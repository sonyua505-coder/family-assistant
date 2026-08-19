/**
 * 记账 Web 服务（M5，对应设计文档 §5.9 / ADR D27）。
 *
 * 两条面：
 *  1. /api/v1/web/tokens 铸造/列表/撤销 —— 仅插件 X-API-Key + 已绑定身份（内部面）。
 *  2. /w/:token/* 页面与写操作 —— 能力令牌门控（浏览器经 ZeroTier 访问），只服务记账。
 *
 * 安全硬要求（§9）：
 *  - 令牌只存 sha256、默认 30 分钟过期、可即时撤销；校验 trim+hash+过期。
 *  - mode=read 拒一切写路由；所有数据按 token 绑定的 person 账户归属强制过滤。
 *  - 写操作一律记 operation_logs；表单值经 bills DAO 校验（不信任客户端）。
 *  - 页面全部 EJS <%= %> 自动转义 + CSP 头（script-src 'none'）防 XSS 窃令牌。
 *  - 访问日志对 /w/:token 脱敏（app.ts 全局 req serializer）。
 *  - 令牌校验失败按来源 IP 轻量限流（ratelimit.ts）。
 */
import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logOperation, today } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import { requireApiKey } from '../../lib/auth.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import { listAccountsForPerson, resolveAccountId } from '../system/accounts.js';
import { getPerson } from '../system/identity.js';
import {
  BILL_CATEGORIES,
  billStats,
  buildBillCsv,
  createBill,
  exportBills,
  getActiveBill,
  getBillAny,
  listBills,
  listTrash,
  parseParticipants,
  purgeBill,
  restoreBill,
  settleBill,
  softDeleteBill,
  updateBill,
  yuan,
} from '../bills/bills.js';
import { buildTaskCsv, createTask, exportTasks, getTask, getTaskAny, listTaskTrash, listTasks, purgeTask, restoreTask, setTaskDone, softDeleteTask, updateTask } from '../tasks/tasks.js';
import { buildWorkBillsStatementCsv, buildWorkBillsSummaryCsv, createWorkBill, getWorkBillAny, getWorkBillLedger, listClients, listWorkBillTrash, listWorkBills, purgeWorkBill, restoreWorkBill, settleWorkBill, softDeleteWorkBill, updateWorkBill, workBillStats, exportWorkBills } from '../work_bills/work_bills.js';
import { listTokens, mintToken, revokeToken, verifyToken } from './tokens.js';
import { checkRateLimit, clearFailures, recordFailure } from './ratelimit.js';
import { renderPage, tpl } from './templates.js';
import type { Config } from '../../config.js';

// 让 Fastify 认识 req.web（/w 令牌会话）
declare module 'fastify' {
  interface FastifyRequest {
    web: { personId: number; mode: 'read' | 'write' } | null;
  }
}

export interface BillsWebRouteDeps {
  db: Database.Database;
  apiKey: string;
  config: Config;
  identity: ReturnType<typeof createIdentityHooks>;
}

/** 极小 HTML 转义（错误页用；页面主体走 EJS <%= %>）。 */
function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSP = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'";

export async function registerBillsWebRoutes(app: FastifyInstance, deps: BillsWebRouteDeps): Promise<void> {
  const { db, apiKey, config, identity } = deps;
  const onAuth = requireApiKey(apiKey);
  const { requireBoundPerson } = identity;

  // 解析 HTML 表单（application/x-www-form-urlencoded）
  await app.register(formbody);

  app.decorateRequest('web', null);

  // ──────────────────────────────────────────────
  // 令牌面（§5.9，内部）
  // ──────────────────────────────────────────────

  // 铸造：{mode:'read'|'write', expires_in?分钟(默认30)} → token 明文仅此一次
  app.post('/api/v1/web/tokens', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const personId = req.identity!.personId!;
    const body = (req.body ?? {}) as { mode?: unknown; expires_in?: unknown };
    const mode = body.mode === 'write' ? 'write' : 'read';
    let expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) expiresIn = 30;
    expiresIn = Math.min(Math.max(Math.round(expiresIn), 1), 1440); // 1 分钟 ~ 24 小时
    const minted = mintToken(db, personId, mode, expiresIn);
    return {
      url: `${config.publicWebBase}/w/${minted.token}`,
      token: minted.token,
      id: minted.id,
      mode,
      expires_at: minted.expires_at,
    };
  });

  // 列表（含过期状态）
  app.get('/api/v1/web/tokens', { preHandler: [onAuth, requireBoundPerson] }, async (req) => ({
    tokens: listTokens(db, req.identity!.personId!),
  }));

  // 撤销（即时生效）
  app.delete('/api/v1/web/tokens/:id', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const { id } = req.params as { id: string };
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    if (!revokeToken(db, idNum, req.identity!.personId!)) {
      throw new AppError(404, 'TOKEN_NOT_FOUND', '令牌不存在或不属于当前用户');
    }
    return { ok: true };
  });

  // ──────────────────────────────────────────────
  // 页面面（/w/:token/*）
  // ──────────────────────────────────────────────

  /** /w 令牌鉴权：校验 token（trim+hash+过期）+ 限流 + CSP 头 + 挂 req.web。 */
  async function webAuth(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const token = (req.params as { token: string }).token;
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return reply.code(429).type('text/html; charset=utf-8').send(errorPage('尝试次数过多，请稍后再试'));
    }
    const session = verifyToken(db, token);
    if (!session) {
      recordFailure(ip);
      return reply.code(401).type('text/html; charset=utf-8').send(errorPage('链接无效或已过期'));
    }
    clearFailures(ip);
    req.web = session;
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    return undefined;
  }

  /** 写操作前必须 mode=write。 */
  async function requireWrite(req: FastifyRequest): Promise<void> {
    if (!req.web || req.web.mode !== 'write') {
      throw new AppError(403, 'FORBIDDEN', '只读令牌不能执行写操作');
    }
  }

  /** 解析 /w 页面要用的账户：accounts 列表 + 当前选中（缺省第一个；accountId 非法则 404）。 */
  function webAccount(personId: number, accountId?: number): { account: NonNullable<ReturnType<typeof listAccountsForPerson>>[number] | null; accounts: ReturnType<typeof listAccountsForPerson> } {
    const accounts = listAccountsForPerson(db, personId);
    if (accounts.length === 0) return { account: null, accounts };
    let account = accounts[0]!;
    if (accountId !== undefined) {
      const found = accounts.find((a) => a.id === accountId);
      if (!found) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '找不到该账本');
      account = found;
    }
    return { account, accounts };
  }

  function redirect(reply: FastifyReply, path: string): FastifyReply {
    return reply.code(303).header('location', path).send();
  }

  /** 解析账本选择器的复合值（"daily-3" / "work-3" / "task-3"；裸数字按页面自身系列，兼容旧链接）。
   *  id 为 NaN 时由 webAccount 抛 404（与原 Number() 行为一致）。 */
  function parseAccountSel(raw: string | undefined, pageSeries: 'daily' | 'work' | 'task'): { series: 'daily' | 'work' | 'task'; id: number | undefined } {
    if (raw === undefined || raw === '') return { series: pageSeries, id: undefined };
    const m = /^(daily|work|task)-(\d+)$/.exec(raw);
    if (m) return { series: m[1] as 'daily' | 'work' | 'task', id: Number(m[2]) };
    return { series: pageSeries, id: Number(raw) };
  }

  /** 账户切换链接参数（分页/筛选保留）。 */
  function accQs(accountId: number, extra: Record<string, string | undefined> = {}): string {
    const parts = [`account_id=${accountId}`];
    for (const [k, v] of Object.entries(extra)) {
      if (v) parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    return parts.join('&');
  }

  // —— 总览 ——
  app.get('/w/:token', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const accounts = listAccountsForPerson(db, personId);
    const d = new Date();
    const ym = { year: d.getFullYear(), month: d.getMonth() + 1 };
    const ymStr = `${ym.year}-${String(ym.month).padStart(2, '0')}`;
    // 每账本三视图：日常账单 / 工作账单 / 代办（缺数据一律记 0）
    const cards = accounts.map((a) => {
      // —— 日常账单：本月汇总 ——
      const s = billStats(db, a.id, ym);
      const dailyBalance = s.income - s.expense;
      const dailyCount = listBills(db, a.id, { month: ymStr, page_size: 1 }).total;
      // —— 工作账单：累计汇总 ——
      const w = workBillStats(db, a.id, {});
      // —— 代办：未完成 / 已完成 ——
      const pendingTasks = listTasks(db, a.id, { is_done: false, page_size: 1 }).total;
      const doneTasks = listTasks(db, a.id, { is_done: true, page_size: 1 }).total;
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        roleText: a.role === 'owner' ? '创建者' : '成员',
        daily: {
          income: yuan(s.income),
          expense: yuan(s.expense),
          balance: yuan(dailyBalance),
          balanceClass: dailyBalance >= 0 ? 'income' : 'expense',
          count: dailyCount,
        },
        work: {
          receivable: yuan(w.receivable),
          paid: yuan(w.paid),
          owed: yuan(w.owed),
          owedClass: w.owed > 0 ? 'expense' : '',
          count: w.bill_count,
        },
        tasks: {
          pending: pendingTasks,
          done: doneTasks,
        },
      };
    });
    const html = renderPage('账本总览', token, req.web!.mode, tpl.overview, { accounts: cards });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // —— 账单列表 ——
  app.get('/w/:token/bills', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const sel = parseAccountSel(q.account_id, 'daily');
    if (sel.series === 'work') return redirect(reply, `/w/${token}/work?account_id=${sel.id}`);
    if (sel.series === 'task') return redirect(reply, `/w/${token}/tasks?account_id=${sel.id}`);
    const { account, accounts } = webAccount(personId, sel.id);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('账单', token, req.web!.mode, tpl.bills, { accounts: [], accountId: 0, error: '' }));

    const month = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : undefined;
    const page = q.page !== undefined && Number(q.page) > 0 ? Number(q.page) : 1;
    // 金额筛选：表单填「元」，转「分」给 listBills；非法/空则忽略
    const amountMinYuan = q.amount_min !== undefined && q.amount_min !== '' ? Number(q.amount_min) : undefined;
    const amountMaxYuan = q.amount_max !== undefined && q.amount_max !== '' ? Number(q.amount_max) : undefined;
    const toFen = (v: number | undefined): number | undefined => (Number.isFinite(v) && v! >= 0 ? Math.round(v! * 100) : undefined);
    const { items, total, page_size } = listBills(db, account.id, {
      month,
      category: q.category || undefined,
      type: q.type || undefined,
      status: q.status === 'pending' || q.status === 'settled' ? q.status : undefined,
      participant: q.participant || undefined,
      amount_min: toFen(amountMinYuan),
      amount_max: toFen(amountMaxYuan),
      page,
      page_size: 50,
    });
    const rows = items.map((b) => ({
      id: b.id,
      occurred_at: b.occurred_at,
      category: b.category,
      note: b.note,
      type: b.type,
      status: b.status,
      amountYuan: yuan(b.amount),
      participantsText: b.participants.map((p) => p.name).join('、'),
    }));
    const filters = {
      month: month ?? '',
      category: q.category ?? '',
      type: q.type ?? '',
      status: q.status ?? '',
      participant: q.participant ?? '',
      amount_min: q.amount_min ?? '',
      amount_max: q.amount_max ?? '',
    };
    const pagerHref = (p: number): string =>
      `/w/${token}/bills?${accQs(account.id, filters)}&page=${p}`;
    // 导出链接带上当前筛选，确保「所见即所导」
    const exportHref = `/w/${token}/export?${accQs(account.id, filters)}`;

    const html = renderPage('账单', token, req.web!.mode, tpl.bills, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      exportHref,
      ...filters,
      categories: [...BILL_CATEGORIES],
      items: rows,
      total,
      page,
      pageSize: page_size,
      pagerHref,
      error: typeof q.error === 'string' ? q.error : '',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // —— 统计 ——
  app.get('/w/:token/stats', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const sel = parseAccountSel(q.account_id, 'daily');
    if (sel.series === 'work') return redirect(reply, `/w/${token}/work/stats?account_id=${sel.id}`);
    if (sel.series === 'task') return redirect(reply, `/w/${token}/tasks/stats?account_id=${sel.id}`);
    const { account, accounts } = webAccount(personId, sel.id);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('统计', token, req.web!.mode, tpl.stats, { accounts: [], accountId: 0, income: 0, expense: 0 }));

    const year = q.year !== undefined && /^\d{4}$/.test(q.year) ? Number(q.year) : undefined;
    const month = q.month !== undefined && Number(q.month) >= 1 && Number(q.month) <= 12 ? Number(q.month) : undefined;
    const s = billStats(db, account.id, { year, month });
    const byCategory = s.by_category.map((c) => ({ category: c.category, amount: c.amount, amountYuan: yuan(c.amount), count: c.count }));
    const trend = s.trend.map((t) => ({ month: t.month, incomeYuan: yuan(t.income), expenseYuan: yuan(t.expense), expense: t.expense }));

    const html = renderPage('统计', token, req.web!.mode, tpl.stats, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      year: year ?? '',
      month: month ?? '',
      income: yuan(s.income),
      expense: yuan(s.expense),
      byCategory,
      trend,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // —— 待收清单（AA）——
  app.get('/w/:token/aa', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const sel = parseAccountSel(q.account_id, 'daily');
    if (sel.series === 'work') return redirect(reply, `/w/${token}/work?account_id=${sel.id}`);
    if (sel.series === 'task') return redirect(reply, `/w/${token}/tasks?account_id=${sel.id}`);
    const { account, accounts } = webAccount(personId, sel.id);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('待收', token, req.web!.mode, tpl.aa, { accounts: [], accountId: 0 }));

    const { items } = listBills(db, account.id, { status: 'pending', page_size: 200 });
    const pending = items.map((b) => {
      const payer = getPerson(db, b.person_id)?.display_name ?? '未知';
      return {
        id: b.id,
        occurred_at: b.occurred_at,
        note: b.note,
        amountYuan: yuan(b.amount),
        payer,
        unpaid: b.participants.filter((p) => p.status === 'pending').map((p) => p.name),
      };
    });
    const html = renderPage('待收清单', token, req.web!.mode, tpl.aa, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      pending,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // —— 回收站（日常账单 / 工作账单 / 代办 三类，按账本区分）——
  app.get('/w/:token/trash', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const { account, accounts } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('回收站', token, req.web!.mode, tpl.trash, { accounts: [], accountId: 0, kind: 'daily', items: [], kinds: [] }));

    const kind: 'daily' | 'work' | 'task' =
      q.kind === 'work' || q.kind === 'task' ? q.kind : 'daily';

    let items: Array<Record<string, unknown>> = [];
    if (kind === 'daily') {
      items = listTrash(db, account.id).map((b) => ({
        kind: 'daily',
        id: b.id,
        deleted_at: b.deleted_at,
        occurred_at: b.occurred_at,
        note: b.note,
        category: b.category,
        type: b.type,
        amountYuan: yuan(b.amount),
      }));
    } else if (kind === 'work') {
      const clients = listClients(db, account.id);
      const clientName = (id: number) => clients.find((c) => c.id === id)?.name || `委托方#${id}`;
      items = listWorkBillTrash(db, account.id).map((b) => ({
        kind: 'work',
        id: b.id,
        deleted_at: b.deleted_at,
        client_name: clientName(b.client_id),
        address: b.address,
        occurred_at: b.occurred_at,
        note: b.note,
        amountYuan: yuan(b.final_amount ?? 0),
      }));
    } else {
      items = listTaskTrash(db, account.id).map((t) => ({
        kind: 'task',
        id: t.id,
        deleted_at: t.deleted_at,
        content: t.content,
        category: t.category,
        is_done: t.is_done === 1,
      }));
    }

    const html = renderPage('回收站', token, req.web!.mode, tpl.trash, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      kind,
      items,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // —— CSV 导出（防公式注入）——
  app.get('/w/:token/export', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const q = req.query as Record<string, string | undefined>;
    const { account } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
    if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '找不到该账本');

    // 与账单列表页一致的筛选参数：确保导出 = 当前所见筛选结果，而非全量
    const month = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : undefined;
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : undefined;
    const amountMinYuan = q.amount_min !== undefined && q.amount_min !== '' ? Number(q.amount_min) : undefined;
    const amountMaxYuan = q.amount_max !== undefined && q.amount_max !== '' ? Number(q.amount_max) : undefined;
    const toFen = (v: number | undefined): number | undefined => (Number.isFinite(v) && v! >= 0 ? Math.round(v! * 100) : undefined);
    const bills = exportBills(db, account.id, {
      month,
      category: q.category || undefined,
      type: q.type || undefined,
      status: q.status === 'pending' || q.status === 'settled' ? q.status : undefined,
      participant: q.participant || undefined,
      amount_min: toFen(amountMinYuan),
      amount_max: toFen(amountMaxYuan),
      from,
      to,
    });
    const csv = buildBillCsv(bills);

    // filename 含中文需 RFC 5987 编码；加 UTF-8 BOM 让 Excel 正确识别中文
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="bills.csv"; filename*=UTF-8''${encodeURIComponent(`bills-${account.name}-${today()}.csv`)}`);
    return reply.send(`﻿${csv}`);
  });

  // —— 写操作（mode=write）——

  // 记一笔（表单：type/amount(元)/category/note/participants(逗号分隔)/occurred_at/account_id）
  app.post('/w/:token/bills', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/bills?error=${encodeURIComponent(msg)}`);

    const amountYuan = Number(body.amount);
    const amount = Math.round(amountYuan * 100);
    if (!Number.isFinite(amount) || amount <= 0) return fail('金额非法');
    const accountId = Number(body.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) return fail('缺少账本');

    try {
      resolveAccountId(db, personId, accountId); // 越权校验
      const participants = String(body.participants ?? '')
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
      const billId = createBill(db, {
        account_id: accountId,
        person_id: personId,
        type: body.type === 'income' ? 'income' : 'expense',
        amount,
        category: typeof body.category === 'string' ? body.category : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
        occurred_at: typeof body.occurred_at === 'string' && body.occurred_at ? body.occurred_at : undefined,
        participants,
      });
      const bill = getActiveBill(db, billId)!;
      logOperation(db, { personId, accountId, action: 'bill.create', entity: 'bills', entityId: billId, after: bill });
      return redirect(reply, `/w/${token}/bills?account_id=${accountId}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  // AA 结算（all=1 全部结清，或 participant_name 单条）
  app.post('/w/:token/bills/:id/settle', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { all?: unknown; participant_name?: unknown };
    const bill = requireBill(personId, id);
    try {
      const result = settleBill(db, bill.id, {
        all: body.all === '1',
        participantName: typeof body.participant_name === 'string' && body.participant_name ? body.participant_name : undefined,
      });
      if (!result) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在');
      logOperation(db, { personId, accountId: bill.account_id, action: 'bill.settle', entity: 'bills', entityId: bill.id, before: result.before, after: result.after });
      return redirect(reply, `/w/${token}/aa?account_id=${bill.account_id}`);
    } catch (err) {
      return redirect(reply, `/w/${token}/aa?account_id=${bill.account_id}&error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  // 软删除
  app.post('/w/:token/bills/:id/delete', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const bill = requireBill(personId, id);
    softDeleteBill(db, bill.id);
    logOperation(db, { personId, accountId: bill.account_id, action: 'bill.delete', entity: 'bills', entityId: bill.id, before: bill });
    return redirect(reply, `/w/${token}/bills?account_id=${bill.account_id}`);
  });

  // 从回收站恢复
  app.post('/w/:token/bills/:id/restore', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const bill = getBillAny(db, Number(id));
    if (!bill) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在');
    resolveAccountId(db, personId, bill.account_id);
    if (bill.is_deleted !== 1) throw new AppError(400, 'NOT_DELETED', '该账单不在回收站');
    const after = restoreBill(db, bill.id)!;
    logOperation(db, { personId, accountId: bill.account_id, action: 'bill.restore', entity: 'bills', entityId: bill.id, after });
    return redirect(reply, `/w/${token}/trash?account_id=${bill.account_id}`);
  });

  // 编辑页（写令牌；渲染当前值预填的表单）
  app.get('/w/:token/bills/:id/edit', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const bill = requireBill(personId, id);
    resolveAccountId(db, personId, bill.account_id);

    const accounts = listAccountsForPerson(db, personId).map((a) => ({ id: a.id, name: a.name }));
    const html = renderPage('编辑账单', token, req.web!.mode, tpl.edit, {
      accounts,
      accountId: bill.account_id,
      categories: [...BILL_CATEGORIES],
      bill: {
        id: bill.id,
        type: bill.type,
        amountYuan: (bill.amount / 100).toFixed(bill.amount % 100 ? 2 : 0),
        category: bill.category,
        note: bill.note,
        occurred_at: bill.occurred_at.slice(0, 10),
        participantsText: parseParticipants(bill.participants)
          .map((p) => p.name)
          .join('、'),
      },
      error: q.error ?? '',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // 编辑提交（表单：type/amount(元)/category/note/participants(逗号分隔)/occurred_at）
  app.post('/w/:token/bills/:id/update', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const bill = requireBill(personId, id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/bills/${bill.id}/edit?error=${encodeURIComponent(msg)}`);

    const amountYuan = Number(body.amount);
    const amount = Math.round(amountYuan * 100);
    if (!Number.isFinite(amount) || amount <= 0) return fail('金额非法');

    try {
      const participants = String(body.participants ?? '')
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
      const result = updateBill(db, bill.id, {
        type: body.type === 'income' ? 'income' : 'expense',
        amount,
        category: typeof body.category === 'string' ? body.category : undefined,
        note: typeof body.note === 'string' ? body.note : undefined,
        occurred_at: typeof body.occurred_at === 'string' && body.occurred_at ? body.occurred_at : undefined,
        participants,
      });
      if (!result) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在或已删除');
      logOperation(db, {
        personId,
        accountId: bill.account_id,
        action: 'bill.update',
        entity: 'bills',
        entityId: bill.id,
        before: result.before,
        after: result.after,
      });
      return redirect(reply, `/w/${token}/bills?account_id=${bill.account_id}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  // ──────────────────────────────────────────────
  // 待办（tasks，2026-08-18）
  // ──────────────────────────────────────────────

  app.get('/w/:token/tasks', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const { account, accounts } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('待办', token, req.web!.mode, tpl.tasks, { accounts: [], accountId: 0, error: '', trash: false }));

    const trash = q.trash === '1';
    // 筛选（listTasks/exportTasks 同套过滤，所见即所导；status 参数名避免与 is_done 混淆）
    const status = q.status === 'done' ? 'done' : q.status === 'undone' ? 'undone' : '';
    const isDone = status === 'done' ? true : status === 'undone' ? false : undefined;
    const category = q.category || undefined;
    const keyword = q.q || undefined;
    const filters = { status, category: category ?? '', q: keyword ?? '' };
    const exportHref = `/w/${token}/tasks/export?${accQs(account.id, filters)}`;
    // 该账本已有分类（任务分类为自由文本，聚合供筛选下拉 + 新增/编辑 datalist 建议）
    const taskCats = (
      db.prepare(`SELECT DISTINCT category FROM tasks WHERE account_id = ? AND is_deleted = 0 AND category != '' ORDER BY category`).all(account.id) as Array<{ category: string }>
    ).map((r) => r.category);

    let rows: Array<Record<string, unknown>>;
    let total = 0;
    if (trash) {
      rows = listTaskTrash(db, account.id).map((t) => ({ id: t.id, content: t.content, category: t.category, deleted_at: t.deleted_at }));
      total = rows.length;
    } else {
      // 一次查询：未完成排前（is_done ASC）；按筛选过滤
      const { items, total: t } = listTasks(db, account.id, { is_done: isDone, category, q: keyword, page_size: 200 });
      total = t;
      rows = items.map((t) => ({ id: t.id, content: t.content, category: t.category, is_done: t.is_done, remind_at: t.remind_at }));
    }
    const html = renderPage('待办', token, req.web!.mode, tpl.tasks, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      items: rows,
      total,
      trash,
      exportHref,
      taskCats,
      ...filters,
      error: typeof q.error === 'string' ? q.error : '',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.post('/w/:token/tasks', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/tasks?error=${encodeURIComponent(msg)}`);
    const accountId = Number(body.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) return fail('缺少账本');
    const content = String(body.content ?? '').trim();
    if (!content) return fail('内容不能为空');
    try {
      resolveAccountId(db, personId, accountId); // 越权校验
      const taskId = createTask(db, {
        account_id: accountId,
        creator_id: personId,
        platform: 'web',
        content,
        category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : undefined,
        remind_at: typeof body.remind_at === 'string' && body.remind_at ? body.remind_at : undefined,
      });
      const task = getTask(db, taskId)!;
      logOperation(db, { personId, accountId, action: 'task.create', entity: 'tasks', entityId: taskId, after: task });
      return redirect(reply, `/w/${token}/tasks?account_id=${accountId}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  app.post('/w/:token/tasks/:id/done', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTask(personId, (req.params as { id: string }).id);
    const updated = setTaskDone(db, task.id, true)!;
    logOperation(db, { personId, accountId: task.account_id, action: 'task.done', entity: 'tasks', entityId: task.id, after: updated });
    return redirect(reply, `/w/${token}/tasks?account_id=${task.account_id}`);
  });

  app.post('/w/:token/tasks/:id/undo', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTask(personId, (req.params as { id: string }).id);
    const updated = setTaskDone(db, task.id, false)!;
    logOperation(db, { personId, accountId: task.account_id, action: 'task.undo', entity: 'tasks', entityId: task.id, after: updated });
    return redirect(reply, `/w/${token}/tasks?account_id=${task.account_id}`);
  });

  app.post('/w/:token/tasks/:id/delete', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTask(personId, (req.params as { id: string }).id);
    softDeleteTask(db, task.id);
    logOperation(db, { personId, accountId: task.account_id, action: 'task.delete', entity: 'tasks', entityId: task.id, before: task });
    return redirect(reply, `/w/${token}/tasks?account_id=${task.account_id}`);
  });

  // 待办回收站：恢复 / 彻底删除
  app.post('/w/:token/tasks/:id/restore', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTaskAny(personId, (req.params as { id: string }).id);
    const after = restoreTask(db, task.id)!;
    logOperation(db, { personId, accountId: task.account_id, action: 'task.restore', entity: 'tasks', entityId: task.id, after });
    const k = ((req.body ?? {}) as Record<string, unknown>).kind;
    return redirect(reply, k === 'task' ? `/w/${token}/trash?account_id=${task.account_id}&kind=task` : `/w/${token}/tasks?account_id=${task.account_id}&trash=1`);
  });

  app.post('/w/:token/tasks/:id/purge', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTaskAny(personId, (req.params as { id: string }).id);
    purgeTask(db, task.id);
    logOperation(db, { personId, accountId: task.account_id, action: 'task.purge', entity: 'tasks', entityId: task.id, before: task });
    const k = ((req.body ?? {}) as Record<string, unknown>).kind;
    return redirect(reply, k === 'task' ? `/w/${token}/trash?account_id=${task.account_id}&kind=task` : `/w/${token}/tasks?account_id=${task.account_id}&trash=1`);
  });

  // 待办编辑
  app.get('/w/:token/tasks/:id/edit', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTask(personId, (req.params as { id: string }).id);
    const taskCats = (
      db.prepare(`SELECT DISTINCT category FROM tasks WHERE account_id = ? AND is_deleted = 0 AND category != '' ORDER BY category`).all(task.account_id) as Array<{ category: string }>
    ).map((r) => r.category);
    const html = renderPage('编辑待办', token, req.web!.mode, tpl.taskEdit, {
      task: { id: task.id, content: task.content, category: task.category, remind_at: task.remind_at ?? '' },
      taskCats,
      accountId: task.account_id,
      error: typeof (req.query as Record<string, string | undefined>).error === 'string' ? (req.query as Record<string, string | undefined>).error : '',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.post('/w/:token/tasks/:id/update', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const task = requireTask(personId, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/tasks/${task.id}/edit?error=${encodeURIComponent(msg)}`);
    const content = String(body.content ?? '').trim();
    if (!content) return fail('内容不能为空');
    try {
      const updated = updateTask(db, task.id, {
        content,
        category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : undefined,
        remind_at: typeof body.remind_at === 'string' && body.remind_at ? body.remind_at : undefined,
      })!;
      logOperation(db, { personId, accountId: task.account_id, action: 'task.update', entity: 'tasks', entityId: task.id, before: task, after: updated });
      return redirect(reply, `/w/${token}/tasks?account_id=${task.account_id}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  // 待办统计 / 导出
  app.get('/w/:token/tasks/stats', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const sel = parseAccountSel(q.account_id, 'task');
    if (sel.series === 'daily') return redirect(reply, `/w/${token}/stats?account_id=${sel.id}`);
    if (sel.series === 'work') return redirect(reply, `/w/${token}/work/stats?account_id=${sel.id}`);
    const { account, accounts } = webAccount(personId, sel.id);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('待办统计', token, req.web!.mode, tpl.taskStats, { accounts: [], accountId: 0, error: '' }));

    const undone = listTasks(db, account.id, { is_done: false, page_size: 200 });
    const done = listTasks(db, account.id, { is_done: true, page_size: 200 });
    const all = [...undone.items, ...done.items];
    const byCategory = new Map<string, { count: number; done: number }>();
    for (const t of all) {
      const key = t.category || '未分类';
      const e = byCategory.get(key) ?? { count: 0, done: 0 };
      e.count++;
      if (t.is_done) e.done++;
      byCategory.set(key, e);
    }
    const catRows = [...byCategory.entries()]
      .map(([category, v]) => ({ category, count: v.count, done: v.done }))
      .sort((a, b) => b.count - a.count);
    const html = renderPage('待办统计', token, req.web!.mode, tpl.taskStats, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      total: all.length,
      undone: undone.items.length,
      done: done.items.length,
      doneRate: all.length ? Math.round((done.items.length / all.length) * 100) : 0,
      byCategory: catRows,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/w/:token/tasks/export', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const { account } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
    if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '找不到该账本');
    const isDone = q.status === 'done' ? true : q.status === 'undone' ? false : undefined;
    const tasks = exportTasks(db, account.id, {
      is_done: isDone,
      category: q.category || undefined,
      q: q.q || undefined,
    });
    const csv = buildTaskCsv(tasks);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="tasks.csv"; filename*=UTF-8''${encodeURIComponent(`tasks-${account.name}-${today()}.csv`)}`);
    return reply.send(`﻿${csv}`);
  });

  // ──────────────────────────────────────────────
  // 工作记账（work_bills，2026-08-18）
  // ──────────────────────────────────────────────

  app.get('/w/:token/work', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const sel = parseAccountSel(q.account_id, 'work');
    if (sel.series === 'daily') return redirect(reply, `/w/${token}/bills?account_id=${sel.id}`);
    if (sel.series === 'task') return redirect(reply, `/w/${token}/tasks?account_id=${sel.id}`);
    const { account, accounts } = webAccount(personId, sel.id);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('工作记账', token, req.web!.mode, tpl.work, { accounts: [], accountId: 0, error: '', trash: false }));

    const trash = q.trash === '1';
    const clients = listClients(db, account.id);
    // 筛选（后端 listWorkBills/exportWorkBills 同套过滤，所见即所导）
    const status = q.status && ['unsettled', 'partial', 'settled'].includes(q.status) ? q.status : undefined;
    const clientId = q.client_id !== undefined && Number(q.client_id) > 0 ? Number(q.client_id) : undefined;
    const keyword = q.keyword || undefined;
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : undefined;
    const filters = { status, client_id: q.client_id || '', keyword: q.keyword || '', from: from ?? '', to: to ?? '' };
    const exportHref = `/w/${token}/work/export?${accQs(account.id, filters)}`;

    let rows: Array<Record<string, unknown>>;
    let total = 0;
    if (trash) {
      rows = listWorkBillTrash(db, account.id).map((b) => ({
        id: b.id,
        client_name: `委托方#${b.client_id}`,
        address: b.address,
        contact: b.contact,
        occurred_at: b.occurred_at,
        deleted_at: b.deleted_at,
      }));
      total = rows.length;
    } else {
      const { items, total: t } = listWorkBills(db, account.id, {
        status,
        client_id: clientId,
        keyword,
        from,
        to,
        page_size: 200,
      });
      total = t;
      rows = items.map((b) => ({
        id: b.id,
        client_name: b.client_name,
        address: b.address,
        contact: b.contact,
        occurred_at: b.occurred_at,
        receivable: yuan(b.receivable),
        paid: yuan(b.paid),
        owed: yuan(b.owed),
        owed_class: b.owed > 0 ? 'expense' : '',
        status: b.status,
      }));
    }
    const html = renderPage('工作记账', token, req.web!.mode, tpl.work, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      items: rows,
      total,
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
      trash,
      exportHref,
      ...filters,
      error: typeof q.error === 'string' ? q.error : '',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.post('/w/:token/work', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/work?error=${encodeURIComponent(msg)}`);
    const accountId = Number(body.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) return fail('缺少账本');
    const clientId = Number(body.client_id);
    if (!Number.isInteger(clientId) || clientId <= 0) return fail('缺少委托方');
    try {
      resolveAccountId(db, personId, accountId); // 越权校验
      const billId = createWorkBill(db, accountId, {
        client_id: clientId,
        address: String(body.address ?? ''),
        contact: String(body.contact ?? ''),
        occurred_at: typeof body.occurred_at === 'string' && body.occurred_at ? body.occurred_at : today(),
        note: String(body.note ?? ''),
        items: parseWorkItems(body),
      });
      const ledger = getWorkBillLedger(db, billId)!;
      logOperation(db, { personId, accountId, action: 'work_bill.create', entity: 'work_bills', entityId: billId, after: ledger.bill });
      return redirect(reply, `/w/${token}/work?account_id=${accountId}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  app.post('/w/:token/work/:id/settle', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const bill = requireWorkBill(personId, id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/work?account_id=${bill.bill.account_id}&error=${encodeURIComponent(msg)}`);
    const amountYuan = Number(body.amount);
    const amount = Math.round(amountYuan * 100);
    if (!Number.isFinite(amount) || amount <= 0) return fail('收款金额非法');
    try {
      const updated = settleWorkBill(db, bill.bill.id, {
        amount,
        settled_at: typeof body.settled_at === 'string' && body.settled_at ? body.settled_at : undefined,
      });
      if (!updated) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '账单不存在');
      logOperation(db, { personId, accountId: bill.bill.account_id, action: 'work_settlement.create', entity: 'work_settlements', entityId: bill.bill.id, after: updated.bill });
      return redirect(reply, `/w/${token}/work?account_id=${bill.bill.account_id}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  app.post('/w/:token/work/:id/delete', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const bill = requireWorkBill(personId, (req.params as { id: string }).id);
    softDeleteWorkBill(db, bill.bill.id);
    logOperation(db, { personId, accountId: bill.bill.account_id, action: 'work_bill.delete', entity: 'work_bills', entityId: bill.bill.id, before: bill.bill });
    return redirect(reply, `/w/${token}/work?account_id=${bill.bill.account_id}`);
  });

  // 工作账单回收站：恢复 / 彻底删除
  app.post('/w/:token/work/:id/restore', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const bill = requireWorkBillAny(personId, (req.params as { id: string }).id);
    const after = restoreWorkBill(db, bill.id)!;
    logOperation(db, { personId, accountId: bill.account_id, action: 'work_bill.restore', entity: 'work_bills', entityId: bill.id, after });
    const k = ((req.body ?? {}) as Record<string, unknown>).kind;
    return redirect(reply, k === 'work' ? `/w/${token}/trash?account_id=${bill.account_id}&kind=work` : `/w/${token}/work?account_id=${bill.account_id}&trash=1`);
  });

  app.post('/w/:token/work/:id/purge', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const bill = requireWorkBillAny(personId, (req.params as { id: string }).id);
    purgeWorkBill(db, bill.id);
    logOperation(db, { personId, accountId: bill.account_id, action: 'work_bill.purge', entity: 'work_bills', entityId: bill.id, before: bill });
    const k = ((req.body ?? {}) as Record<string, unknown>).kind;
    return redirect(reply, k === 'work' ? `/w/${token}/trash?account_id=${bill.account_id}&kind=work` : `/w/${token}/work?account_id=${bill.account_id}&trash=1`);
  });

  // 工作账单编辑
  app.get('/w/:token/work/:id/edit', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const ledger = requireWorkBill(personId, (req.params as { id: string }).id);
    const clients = listClients(db, ledger.bill.account_id);
    const items = ledger.items.slice(0, 4).map((it) => ({ name: it.name, qty: it.qty, unit: it.unit, unit_price: it.unit_price / 100 }));
    const html = renderPage('编辑工作账单', token, req.web!.mode, tpl.workEdit, {
      bill: { id: ledger.bill.id, client_id: ledger.bill.client_id, address: ledger.bill.address, contact: ledger.bill.contact, occurred_at: ledger.bill.occurred_at, note: ledger.bill.note },
      clients: clients.map((c) => ({ id: c.id, name: c.name })),
      items,
      accountId: ledger.bill.account_id,
      error: typeof (req.query as Record<string, string | undefined>).error === 'string' ? (req.query as Record<string, string | undefined>).error : '',
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.post('/w/:token/work/:id/update', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const bill = requireWorkBill(personId, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => redirect(reply, `/w/${token}/work/${bill.bill.id}/edit?error=${encodeURIComponent(msg)}`);
    const clientId = Number(body.client_id);
    if (!Number.isInteger(clientId) || clientId <= 0) return fail('缺少委托方');
    try {
      const updated = updateWorkBill(db, bill.bill.id, bill.bill.account_id, {
        client_id: clientId,
        address: String(body.address ?? ''),
        contact: String(body.contact ?? ''),
        occurred_at: typeof body.occurred_at === 'string' && body.occurred_at ? body.occurred_at : undefined,
        note: String(body.note ?? ''),
        items: parseWorkItems(body),
      })!;
      logOperation(db, { personId, accountId: bill.bill.account_id, action: 'work_bill.update', entity: 'work_bills', entityId: bill.bill.id, before: bill.bill, after: updated.bill });
      return redirect(reply, `/w/${token}/work?account_id=${bill.bill.account_id}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  // 工作统计 / 导出
  app.get('/w/:token/work/stats', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const sel = parseAccountSel(q.account_id, 'work');
    if (sel.series === 'daily') return redirect(reply, `/w/${token}/stats?account_id=${sel.id}`);
    if (sel.series === 'task') return redirect(reply, `/w/${token}/tasks/stats?account_id=${sel.id}`);
    const { account, accounts } = webAccount(personId, sel.id);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('工作统计', token, req.web!.mode, tpl.workStats, { accounts: [], accountId: 0, error: '' }));

    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : undefined;
    const s = workBillStats(db, account.id, { from, to });
    const html = renderPage('工作统计', token, req.web!.mode, tpl.workStats, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
      from: from ?? '',
      to: to ?? '',
      billCount: s.bill_count,
      receivable: yuan(s.receivable),
      paid: yuan(s.paid),
      owed: yuan(s.owed),
      owedClass: s.owed > 0 ? 'expense' : '',
      byClient: s.by_client.map((c) => ({ client_name: c.client_name, bill_count: c.bill_count, receivable: yuan(c.receivable), paid: yuan(c.paid), owed: yuan(c.owed), owed_class: c.owed > 0 ? 'expense' : '' })),
      byMonth: s.by_month.map((m) => ({ month: m.month, bill_count: m.bill_count, receivable: yuan(m.receivable), paid: yuan(m.paid), owed: yuan(m.owed) })),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/w/:token/work/export', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const { account } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
    if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '找不到该账本');
    const mode = q.mode === 'statement' ? 'statement' : 'summary';
    const status = q.status && ['unsettled', 'partial', 'settled'].includes(q.status) ? q.status : undefined;
    const clientId = q.client_id !== undefined && Number(q.client_id) > 0 ? Number(q.client_id) : undefined;
    const keyword = q.keyword || undefined;
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : undefined;
    const { bills } = exportWorkBills(db, account.id, { status, client_id: clientId, keyword, from, to });
    const csv = mode === 'statement' ? buildWorkBillsStatementCsv(bills) : buildWorkBillsSummaryCsv(bills);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="work-bills.csv"; filename*=UTF-8''${encodeURIComponent(`work-bills-${account.name}-${today()}.csv`)}`);
    return reply.send(`﻿${csv}`);
  });

  // 记账回收站：彻底删除
  app.post('/w/:token/bills/:id/purge', { preHandler: [webAuth, requireWrite] }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const { id } = req.params as { id: string };
    const bill = getBillAny(db, Number(id));
    if (!bill || bill.is_deleted !== 1) return redirect(reply, `/w/${token}/trash?error=${encodeURIComponent('账单不在回收站')}`);
    resolveAccountId(db, personId, bill.account_id);
    purgeBill(db, bill.id);
    logOperation(db, { personId, accountId: bill.account_id, action: 'bill.purge', entity: 'bills', entityId: bill.id, before: bill });
    return redirect(reply, `/w/${token}/trash?account_id=${bill.account_id}`);
  });

  // ── 私有辅助 ──

  function errorPage(message: string): string {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>访问受限</title></head>
<body style="font-family:system-ui;padding:40px;text-align:center;color:#333">
<p style="font-size:18px;color:#b71c1c">${escHtml(message)}</p>
<p class="muted">如持续失效，请联系家人重新生成记账链接。</p>
</body></html>`;
  }

  /** 从表单解析工作账单明细（i0_name/i0_qty/i0_unit/i0_unit_price…；空品名行跳过；单价元→分）。 */
  function parseWorkItems(body: Record<string, unknown>): Array<{ name: string; qty?: number; unit?: string; unit_price?: number }> {
    const out: Array<{ name: string; qty?: number; unit?: string; unit_price?: number }> = [];
    for (let i = 0; i < 8; i++) {
      const name = String(body[`i${i}_name`] ?? '').trim();
      if (!name) continue;
      const item: { name: string; qty?: number; unit?: string; unit_price?: number } = { name };
      const qtyRaw = body[`i${i}_qty`];
      if (qtyRaw !== undefined && qtyRaw !== '') {
        const q = Number(qtyRaw);
        if (Number.isFinite(q) && q > 0) item.qty = q;
      }
      const unitRaw = body[`i${i}_unit`];
      if (unitRaw !== undefined && String(unitRaw).trim()) item.unit = String(unitRaw).trim();
      const priceRaw = body[`i${i}_unit_price`];
      if (priceRaw !== undefined && priceRaw !== '') {
        const p = Number(priceRaw);
        if (Number.isFinite(p) && p >= 0) item.unit_price = Math.round(p * 100);
      }
      out.push(item);
    }
    return out;
  }

  /** 取一条未删除待办并校验当前 person 对其账户有访问权。 */
  function requireTask(personId: number, rawId: string) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    const task = getTask(db, id);
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', '任务不存在或已删除');
    resolveAccountId(db, personId, task.account_id); // 越权 403
    return task;
  }

  /** 取一张未删除工作账单（含对账）并校验当前 person 对其账户有访问权。 */
  function requireWorkBill(personId: number, rawId: string) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    const ledger = getWorkBillLedger(db, id);
    if (!ledger) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '账单不存在或已删除');
    resolveAccountId(db, personId, ledger.bill.account_id); // 越权 403
    return ledger;
  }

  /** 取一条待办（无视删除状态，回收站恢复/彻底删除用）。 */
  function requireTaskAny(personId: number, rawId: string) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    const task = getTaskAny(db, id);
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', '任务不存在');
    resolveAccountId(db, personId, task.account_id); // 越权 403
    return task;
  }

  /** 取一张工作账单（无视删除状态，回收站恢复/彻底删除用）。 */
  function requireWorkBillAny(personId: number, rawId: string) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    const bill = getWorkBillAny(db, id);
    if (!bill) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '账单不存在');
    resolveAccountId(db, personId, bill.account_id); // 越权 403
    return bill;
  }

  /** 取一条未删除账单并校验当前 person 对其账户有访问权。 */
  function requireBill(personId: number, rawId: string) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    const bill = getActiveBill(db, id);
    if (!bill) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在或已删除');
    resolveAccountId(db, personId, bill.account_id); // 越权 403
    return bill;
  }
}
