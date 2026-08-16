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
  restoreBill,
  settleBill,
  softDeleteBill,
  updateBill,
  yuan,
} from '../bills/bills.js';
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
    // 上月 ym（跨年处理）
    const lastYm =
      ym.month === 1 ? { year: ym.year - 1, month: 12 } : { year: ym.year, month: ym.month - 1 };
    const cards = accounts.map((a) => {
      const s = billStats(db, a.id, ym);
      const last = billStats(db, a.id, lastYm);
      const balance = s.income - s.expense;
      // 环比上月支出增减（上月支出为 0 → mom=null 显示「—」）
      const mom =
        last.expense === 0 ? null : Math.round(((s.expense - last.expense) / last.expense) * 100);
      const top = (s.by_category || []).slice(0, 3).map((c) => ({ category: c.category, amountYuan: yuan(c.amount) }));
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        role: a.role,
        income: yuan(s.income),
        expense: yuan(s.expense),
        balance: yuan(balance),
        balanceClass: balance >= 0 ? 'income' : 'expense',
        mom,
        momText: mom === null ? '—' : `${mom > 0 ? '+' : ''}${mom}%`,
        momClass: mom === null ? '' : mom > 0 ? 'up' : 'down',
        topCategories: top,
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
    const { account, accounts } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
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

    const html = renderPage('账单', token, req.web!.mode, tpl.bills, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
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
    const { account, accounts } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
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
    const { account, accounts } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
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

  // —— 回收站 ——
  app.get('/w/:token/trash', { preHandler: webAuth }, async (req, reply) => {
    const { personId } = req.web!;
    const token = (req.params as { token: string }).token;
    const q = req.query as Record<string, string | undefined>;
    const { account, accounts } = webAccount(personId, q.account_id !== undefined ? Number(q.account_id) : undefined);
    if (!account) return reply.type('text/html; charset=utf-8').send(renderPage('回收站', token, req.web!.mode, tpl.trash, { accounts: [], accountId: 0 }));

    const items = listTrash(db, account.id).map((b) => ({
      id: b.id,
      deleted_at: b.deleted_at,
      occurred_at: b.occurred_at,
      note: b.note,
      category: b.category,
      type: b.type,
      amountYuan: yuan(b.amount),
    }));
    const html = renderPage('回收站', token, req.web!.mode, tpl.trash, {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      accountId: account.id,
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

    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : undefined;
    const bills = exportBills(db, account.id, { from, to });
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

  // ── 私有辅助 ──

  function errorPage(message: string): string {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>访问受限</title></head>
<body style="font-family:system-ui;padding:40px;text-align:center;color:#333">
<p style="font-size:18px;color:#b71c1c">${escHtml(message)}</p>
<p class="muted">如持续失效，请联系家人重新生成记账链接。</p>
</body></html>`;
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
