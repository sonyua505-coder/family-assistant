/**
 * 工作账单路由（装修安装门记账，2026-08-18）。
 * 全部要求已绑定 person；账户归属走 resolveAccountId（唯一/歧义/越权，D26 同款）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logOperation } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import type { Identity } from '../../lib/identity.js';
import { resolveAccountId } from '../system/accounts.js';
import {
  createClient,
  createWorkBill,
  deleteUnitPrice,
  exportWorkBills,
  getClient,
  getWorkBillAny,
  getWorkBillLedger,
  listClients,
  listUnitPrices,
  listWorkBillTrash,
  listWorkBills,
  purgeWorkBill,
  restoreWorkBill,
  recalcWorkBills,
  settleWorkBill,
  settleWorkBillsBatch,
  softDeleteClient,
  softDeleteWorkBill,
  updateClient,
  updateWorkBill,
  upsertUnitPrice,
  workBillStats,
  buildWorkBillsStatementCsv,
  buildWorkBillsSummaryCsv,
  type CreateWorkBillInput,
  type UpdateWorkBillPatch,
} from './work_bills.js';

export interface WorkBillsRouteDeps {
  db: Database.Database;
  identity: ReturnType<typeof createIdentityHooks>;
}

export async function registerWorkBillsRoutes(app: FastifyInstance, deps: WorkBillsRouteDeps): Promise<void> {
  const { db, identity } = deps;
  const { requireBoundPerson } = identity;
  const me = (req: { identity: Identity | null }): number => req.identity!.personId!;
  const qs = (req: FastifyRequest): Record<string, string | undefined> => req.query as Record<string, string | undefined>;

  // ── 委托方 ──

  app.post('/api/v1/work-clients', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const body = req.body as Record<string, unknown>;
    const id = createClient(db, accountId, { name: body.name, type: body.type, phone: body.phone, note: body.note });
    const client = getClient(db, id)!;
    logOperation(db, { personId, accountId, action: 'work_client.create', entity: 'work_clients', entityId: id, after: client });
    return { ok: true, client };
  });

  app.get('/api/v1/work-clients', { preHandler: requireBoundPerson }, async (req) => {
    const accountId = resolveAccountId(db, me(req), num(qs(req).account_id));
    const q = qs(req);
    const items = listClients(db, accountId, { q: q.q });
    return { items, total: items.length };
  });

  app.patch('/api/v1/work-clients/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const client = getClient(db, id);
    if (!client) throw new AppError(404, 'WORK_CLIENT_NOT_FOUND', '委托方不存在');
    resolveAccountId(db, personId, client.account_id); // 越权 403
    const body = req.body as Record<string, unknown>;
    const updated = updateClient(db, id, { name: body.name, type: body.type, phone: body.phone, note: body.note })!;
    logOperation(db, { personId, accountId: client.account_id, action: 'work_client.update', entity: 'work_clients', entityId: id, before: client, after: updated });
    return { ok: true, client: updated };
  });

  app.delete('/api/v1/work-clients/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const client = getClient(db, id);
    if (!client) throw new AppError(404, 'WORK_CLIENT_NOT_FOUND', '委托方不存在');
    resolveAccountId(db, personId, client.account_id);
    softDeleteClient(db, id);
    logOperation(db, { personId, accountId: client.account_id, action: 'work_client.delete', entity: 'work_clients', entityId: id, before: client });
    return { ok: true, deleted: true };
  });

  // ── 单价表（按委托方，upsert）──

  app.post('/api/v1/work-unit-prices', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const body = req.body as Record<string, unknown>;
    const price = upsertUnitPrice(db, accountId, { client_id: body.client_id, name: body.name, unit: body.unit, unit_price: body.unit_price, note: body.note });
    logOperation(db, { personId, accountId, action: 'work_unit_price.upsert', entity: 'work_unit_prices', entityId: price.id, after: price });
    return { ok: true, price };
  });

  app.get('/api/v1/work-unit-prices', { preHandler: requireBoundPerson }, async (req) => {
    const accountId = resolveAccountId(db, me(req), num(qs(req).account_id));
    const q = qs(req);
    const items = listUnitPrices(db, accountId, { client_id: num(q.client_id), q: q.q });
    return { items, total: items.length };
  });

  app.delete('/api/v1/work-unit-prices/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const price = deleteUnitPrice(db, id, accountId);
    if (!price) throw new AppError(404, 'WORK_UNIT_PRICE_NOT_FOUND', '单价不存在');
    logOperation(db, { personId, accountId, action: 'work_unit_price.delete', entity: 'work_unit_prices', entityId: id, before: price });
    return { ok: true, deleted: true };
  });

  // ── 工作账单 ──

  app.post('/api/v1/work-bills', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const body = req.body as Partial<CreateWorkBillInput> & Record<string, unknown>;
    const id = createWorkBill(db, accountId, {
      client_id: body.client_id as number,
      address: body.address,
      contact: body.contact,
      occurred_at: body.occurred_at,
      note: body.note,
      final_amount: body.final_amount as number | null,
      items: body.items as CreateWorkBillInput['items'],
    });
    const full = getWorkBillLedger(db, id)!;
    logOperation(db, { personId, accountId, action: 'work_bill.create', entity: 'work_bills', entityId: id, after: full.bill });
    return { ok: true, bill: full };
  });

  app.get('/api/v1/work-bills', { preHandler: requireBoundPerson }, async (req) => {
    const accountId = resolveAccountId(db, me(req), num(qs(req).account_id));
    const q = qs(req);
    return listWorkBills(db, accountId, {
      client_id: num(q.client_id),
      contact: q.contact,
      keyword: q.keyword,
      status: q.status,
      from: q.from,
      to: q.to,
      page: q.page !== undefined ? Number(q.page) : undefined,
      page_size: q.page_size !== undefined ? Number(q.page_size) : undefined,
    });
  });

  app.get('/api/v1/work-bills/:id', { preHandler: requireBoundPerson }, async (req) => {
    const id = requireIntId(req);
    const full = requireVisibleWorkBill(req, id);
    return { bill: full };
  });

  app.patch('/api/v1/work-bills/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const before = requireVisibleWorkBill(req, id);
    const body = req.body as Partial<UpdateWorkBillPatch> & Record<string, unknown>;
    const updated = updateWorkBill(db, id, before.bill.account_id, {
      client_id: body.client_id as number | undefined,
      address: body.address,
      contact: body.contact,
      occurred_at: body.occurred_at,
      note: body.note,
      final_amount: body.final_amount as number | null,
      items: body.items as UpdateWorkBillPatch['items'],
    })!;
    logOperation(db, { personId, accountId: before.bill.account_id, action: 'work_bill.update', entity: 'work_bills', entityId: id, before: before.bill, after: updated.bill });
    return { ok: true, bill: updated };
  });

  app.delete('/api/v1/work-bills/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const full = requireVisibleWorkBill(req, id);
    softDeleteWorkBill(db, id);
    logOperation(db, { personId, accountId: full.bill.account_id, action: 'work_bill.delete', entity: 'work_bills', entityId: id, before: full.bill });
    return { ok: true, deleted: true };
  });

  // ── 回收站（软删后可查看/恢复/彻底删除）──

  app.get('/api/v1/work-bills/trash', { preHandler: requireBoundPerson }, async (req) => {
    const accountId = resolveAccountId(db, me(req), num(qs(req).account_id));
    return { items: listWorkBillTrash(db, accountId) };
  });

  app.post('/api/v1/work-bills/:id/restore', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const bill = getWorkBillAny(db, id);
    if (!bill) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '账单不存在');
    resolveAccountId(db, personId, bill.account_id); // 越权 403
    if (bill.is_deleted !== 1) throw new AppError(400, 'NOT_DELETED', '该账单不在回收站');
    const after = restoreWorkBill(db, id)!;
    logOperation(db, { personId, accountId: bill.account_id, action: 'work_bill.restore', entity: 'work_bills', entityId: id, after });
    return { ok: true, bill: after };
  });

  // 彻底删除（仅回收站内，不可恢复；先清明细/结算子表）
  app.delete('/api/v1/work-bills/:id/purge', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const bill = getWorkBillAny(db, id);
    if (!bill) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '账单不存在');
    resolveAccountId(db, personId, bill.account_id); // 越权 403
    if (bill.is_deleted !== 1) throw new AppError(400, 'NOT_DELETED', '该账单不在回收站，不能彻底删除');
    purgeWorkBill(db, id);
    logOperation(db, { personId, accountId: bill.account_id, action: 'work_bill.purge', entity: 'work_bills', entityId: id, before: bill });
    return { ok: true, purged: true };
  });

  // 结算：记一笔实收（可多次、可部分；与计算金额解耦）
  app.post('/api/v1/work-bills/:id/settle', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const id = requireIntId(req);
    const full = requireVisibleWorkBill(req, id);
    const body = req.body as Record<string, unknown>;
    const updated = settleWorkBill(db, id, { amount: body.amount, settled_at: body.settled_at, note: body.note })!;
    logOperation(db, { personId, accountId: full.bill.account_id, action: 'work_settlement.create', entity: 'work_settlements', entityId: id, after: updated.bill });
    return { ok: true, bill: updated };
  });

  // 批量结算：按给定账单 ID 组（bill_ids 顺序）收一笔款冲抵这几张未结单
  app.post('/api/v1/work-bills/settle-batch', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const body = req.body as Record<string, unknown>;
    const result = settleWorkBillsBatch(db, accountId, {
      bill_ids: Array.isArray(body.bill_ids) ? (body.bill_ids as unknown[]) : [],
      amount: body.amount,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    for (const a of result.applied) {
      logOperation(db, { personId, accountId, action: 'work_settlement.create', entity: 'work_settlements', entityId: a.bill_id, after: { batch: true, applied: a.applied } });
    }
    return { ok: true, ...result };
  });

  // 批量重算未结算单（纯手动；dry_run 默认 true=预览，dry_run=0 才提交）
  app.post('/api/v1/work-bills/recalc', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const q = qs(req);
    const dryRun = q.dry_run !== '0' && q.dry_run !== 'false';
    const billIds = q.bill_ids
      ? q.bill_ids.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
      : undefined;
    return recalcWorkBills(db, accountId, {
      bill_ids: billIds,
      client_id: num(q.client_id),
      from: q.from,
      to: q.to,
      dry_run: dryRun,
    });
  });

  // 区间统计：合计应收/已收/欠款 + 按委托方 + 按月份（applied 回显）
  app.get('/api/v1/work-bills/stats', { preHandler: requireBoundPerson }, async (req) => {
    const accountId = resolveAccountId(db, me(req), num(qs(req).account_id));
    const q = qs(req);
    return workBillStats(db, accountId, {
      from: q.from,
      to: q.to,
      year: q.year !== undefined ? Number(q.year) : undefined,
      month: q.month !== undefined ? Number(q.month) : undefined,
      client_id: num(q.client_id),
      status: q.status,
    });
  });

  // 全量导出：mode=statement 结账版（式子）/ summary 日常简版；format=json|csv
  app.get('/api/v1/work-bills/export', { preHandler: requireBoundPerson }, async (req, reply) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num(qs(req).account_id));
    const q = qs(req);
    const mode = q.mode === 'statement' ? 'statement' : 'summary';
    const { bills, total, applied } = exportWorkBills(db, accountId, {
      client_id: num(q.client_id),
      contact: q.contact,
      keyword: q.keyword,
      status: q.status,
      from: q.from,
      to: q.to,
    });

    if (q.format === 'csv') {
      const csv = mode === 'statement' ? buildWorkBillsStatementCsv(bills) : buildWorkBillsSummaryCsv(bills);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="work-bills-${mode}.csv"`);
      return reply.send(`﻿${csv}`);
    }
    return { total, applied, mode, bills };
  });

  // ── 私有辅助 ──

  function num(v: unknown): number | undefined {
    return typeof v === 'string' && v !== '' ? Number(v) : undefined;
  }

  function requireIntId(req: FastifyRequest): number {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    return id;
  }

  /** 取路由 :id 对应的一条未删除工作账单（含对账），并校验当前 person 对所在账户有访问权。 */
  function requireVisibleWorkBill(req: FastifyRequest, id: number) {
    const personId = me(req);
    const full = getWorkBillLedger(db, id);
    if (!full) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '工作账单不存在或已删除');
    resolveAccountId(db, personId, full.bill.account_id); // 越权抛 403
    return full;
  }
}
