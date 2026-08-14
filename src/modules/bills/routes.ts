/**
 * 记账模块路由（M2，对应设计文档 §5.1）。
 * 全部接口要求已绑定 person（requireBoundPerson）——身份头先过，
 * 账户归属由 DAO 的 resolveAccountId 处理（唯一/歧义/越权）。
 * 所有写操作记 operation_logs（before/after 快照），供账单变动日报/on-demand 查询使用。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logOperation } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import type { Identity } from '../../lib/identity.js';
import {
  batchCreateBills,
  billChanges,
  billStats,
  createBill,
  getActiveBill,
  getBillAny,
  listBills,
  listTrash,
  resolveAccountId,
  restoreBill,
  settleBill,
  softDeleteBill,
  toOut,
  updateBill,
  type BillRow,
  type CreateBillInput,
  type StatsQuery,
} from './bills.js';

export interface BillsRouteDeps {
  db: Database.Database;
  identity: ReturnType<typeof createIdentityHooks>;
}

export async function registerBillsRoutes(app: FastifyInstance, deps: BillsRouteDeps): Promise<void> {
  const { db, identity } = deps;
  const { requireBoundPerson } = identity;

  /** 记录一笔 bills 写操作日志。 */
  function logBillOp(
    personId: number,
    action: string,
    billId: number,
    before?: BillRow,
    after?: BillRow,
  ): void {
    logOperation(db, {
      accountId: (after ?? before)?.account_id ?? null,
      personId,
      action,
      entity: 'bills',
      entityId: billId,
      before,
      after,
    });
  }

  /** 从请求头取当前 person id（已由 requireBoundPerson 保证非空）。 */
  const me = (req: { identity: Identity | null }): number => req.identity!.personId!;

  // ── 记一笔（单笔，D20：直接记 + 回显，错了再改）──
  app.post('/api/v1/bills', { preHandler: requireBoundPerson }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, typeof body.account_id === 'number' ? body.account_id : undefined);
    const billId = createBill(db, {
      type: body.type as 'income' | 'expense',
      amount: body.amount as number,
      category: typeof body.category === 'string' ? body.category : undefined,
      note: typeof body.note === 'string' ? body.note : undefined,
      occurred_at: typeof body.occurred_at === 'string' ? body.occurred_at : undefined,
      participants: body.participants,
      account_id: accountId,
      person_id: personId,
    });
    const created = getActiveBill(db, billId)!;
    logBillOp(personId, 'bill.create', billId, undefined, created);
    return reply.code(201).send({ ok: true, bill: toOut(created) });
  });

  // ── 查询列表 ──
  app.get('/api/v1/bills', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num((req.query as Record<string, unknown>).account_id));
    const q = req.query as Record<string, string | undefined>;
    return listBills(db, accountId, {
      type: q.type,
      category: q.category,
      status: q.status,
      participant: q.participant,
      month: q.month,
      year: q.year,
      from: q.from,
      to: q.to,
      page: q.page !== undefined ? Number(q.page) : undefined,
      page_size: q.page_size !== undefined ? Number(q.page_size) : undefined,
    });
  });

  // ── 详情 ──
  app.get('/api/v1/bills/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const bill = requireVisibleBill(req);
    // 归属校验：该 bill 必须属于当前 person 可见账户
    resolveAccountId(db, personId, bill.account_id);
    return toOut(bill);
  });

  // ── 修改（记 before/after）──
  app.patch('/api/v1/bills/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const bill = requireVisibleBill(req);
    resolveAccountId(db, personId, bill.account_id);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = updateBill(db, bill.id, {
      type: body.type as 'income' | 'expense',
      amount: typeof body.amount === 'number' ? body.amount : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      note: typeof body.note === 'string' ? body.note : undefined,
      occurred_at: typeof body.occurred_at === 'string' ? body.occurred_at : undefined,
      participants: body.participants !== undefined ? body.participants : undefined,
    });
    if (!result) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在或已删除');
    logBillOp(personId, 'bill.update', bill.id, result.before, result.after);
    return { ok: true, bill: toOut(result.after) };
  });

  // ── 软删除（进回收站）──
  app.delete('/api/v1/bills/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const bill = requireVisibleBill(req);
    resolveAccountId(db, personId, bill.account_id);
    const before = softDeleteBill(db, bill.id)!;
    logBillOp(personId, 'bill.delete', bill.id, before);
    return { ok: true, deleted: true };
  });

  // ── 回收站列表 ──
  app.get('/api/v1/bills/trash', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num((req.query as Record<string, unknown>).account_id));
    return { items: listTrash(db, accountId).map(toOut) };
  });

  // ── 从回收站恢复 ──
  app.post('/api/v1/bills/:id/restore', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const { id } = req.params as { id: string };
    const billId = requireIntId(id);
    const bill = getBillAny(db, billId);
    if (!bill) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在');
    resolveAccountId(db, personId, bill.account_id);
    if (bill.is_deleted !== 1) throw new AppError(400, 'NOT_DELETED', '该账单不在回收站');
    const after = restoreBill(db, billId)!;
    logBillOp(personId, 'bill.restore', billId, undefined, after);
    return { ok: true, bill: toOut(after) };
  });

  // ── 统计 ──
  app.get('/api/v1/bills/stats', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num((req.query as Record<string, unknown>).account_id));
    const q = req.query as Record<string, string | undefined>;
    const stats: StatsQuery = {};
    if (q.year !== undefined) {
      const y = Number(q.year);
      if (!Number.isInteger(y) || y < 2000 || y > 3000) throw new AppError(400, 'INVALID_YEAR', 'year 需为 YYYY');
      stats.year = y;
    }
    if (q.month !== undefined) {
      const m = Number(q.month);
      if (!Number.isInteger(m) || m < 1 || m > 12) throw new AppError(400, 'INVALID_MONTH', 'month 需为 1-12');
      stats.month = m;
    }
    if (q.category !== undefined) stats.category = q.category;
    return billStats(db, accountId, stats);
  });

  // ── AA 结算 ──
  app.post('/api/v1/bills/:id/settle', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const bill = requireVisibleBill(req);
    resolveAccountId(db, personId, bill.account_id);
    const body = (req.body ?? {}) as { participant_name?: unknown; all?: unknown };
    const result = settleBill(db, bill.id, {
      participantName: typeof body.participant_name === 'string' ? body.participant_name : undefined,
      all: body.all === true,
    });
    if (!result) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在或已删除');
    logBillOp(personId, 'bill.settle', bill.id, result.before, result.after);
    return { ok: true, bill: toOut(result.after) };
  });

  // ── 批量录入（D20：事务插入，调用前应已列清单确认）──
  app.post('/api/v1/bills/batch', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const body = (req.body ?? {}) as { bills?: unknown; account_id?: unknown };
    if (!Array.isArray(body.bills) || body.bills.length === 0) {
      throw new AppError(400, 'INVALID_BODY', 'body 需 { bills: [...], account_id? }');
    }
    if (body.bills.length > 200) throw new AppError(400, 'TOO_MANY', '单次最多 200 笔');
    const accountId = resolveAccountId(db, personId, typeof body.account_id === 'number' ? body.account_id : undefined);
    const ids = batchCreateBills(db, {
      bills: body.bills as CreateBillInput[],
      account_id: accountId,
      person_id: personId,
    });
    // 每笔都记日志（供日报/变动查询）
    for (const id of ids) {
      const bill = getActiveBill(db, id)!;
      logBillOp(personId, 'bill.create', id, undefined, bill);
    }
    return { ok: true, count: ids.length, bill_ids: ids };
  });

  // ── 账单变动（on-demand 版日报，工具 query_bill_changes）──
  app.get('/api/v1/bills/changes', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const q = req.query as { date?: string };
    return billChanges(db, personId, q.date);
  });

  // ── 本文件内私有辅助 ──

  /** 解析查询参数里的数字（可空）。 */
  function num(v: unknown): number | undefined {
    return typeof v === 'string' && v !== '' ? Number(v) : undefined;
  }

  /** 校验路由参数 :id 为正整数。 */
  function requireIntId(s: string): number {
    const id = Number(s);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', `id 非法: ${s}`);
    return id;
  }

  /** 取路由参数 :id 对应的一条未删除账单，并校验当前 person 对该账单所在账户有访问权。 */
  function requireVisibleBill(req: FastifyRequest): BillRow {
    const personId = me(req);
    const billId = requireIntId((req.params as { id: string }).id);
    const bill = getActiveBill(db, billId);
    if (!bill) throw new AppError(404, 'BILL_NOT_FOUND', '账单不存在或已删除');
    resolveAccountId(db, personId, bill.account_id); // 越权会抛 403
    return bill;
  }
}
