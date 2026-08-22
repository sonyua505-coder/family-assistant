/**
 * 工作账单数据访问层（装修安装门记账，2026-08-18）。
 * 5 张表：委托方 / 单价表(按委托方) / 工作账单 / 明细 / 结算记录。
 * 金额一律「分」INTEGER；明细 qty REAL（㎡ 可小数）；小计 = round(qty × 单价快照)。
 * 与 bills 完全独立；权限经 account 隔离（路由层 resolveAccountId）。
 */
import type Database from 'better-sqlite3';
import { now, today } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import { resolveStatsRange, yuan, csvCell } from '../bills/bills.js';
import { listAccountsForPerson } from '../system/accounts.js';

// ── 类型 ──

export type WorkClientType = 'company' | 'personal';

export interface WorkClientRow {
  id: number;
  account_id: number;
  name: string;
  type: WorkClientType;
  phone: string;
  note: string;
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkUnitPriceRow {
  id: number;
  account_id: number;
  client_id: number;
  name: string;
  unit: string;
  unit_price: number;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface WorkBillRow {
  id: number;
  account_id: number;
  client_id: number;
  contact: string;
  address: string;
  occurred_at: string;
  note: string;
  final_amount: number | null;
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkBillItemRow {
  id: number;
  bill_id: number;
  name: string;
  qty: number;
  unit: string;
  unit_price: number;
  amount: number;
  price_ref_id: number | null;
  note: string;
  sort: number;
}

export interface WorkSettlementRow {
  id: number;
  bill_id: number;
  amount: number;
  settled_at: string;
  note: string;
  created_at: string;
}

/** 账单明细输入（路由/插件层）；unit_price 缺省从单价表按 (account, client, name) 带出。 */
export interface WorkBillItemInput {
  name: string;
  qty?: number;
  unit?: string;
  unit_price?: number;
  note?: string;
}

export interface CreateWorkBillInput {
  client_id: number;
  address?: string;
  contact?: string;
  occurred_at?: string;
  note?: string;
  final_amount?: number | null;
  items: WorkBillItemInput[];
}

export interface UpdateWorkBillPatch {
  client_id?: number;
  address?: string;
  contact?: string;
  occurred_at?: string;
  note?: string;
  final_amount?: number | null; // null 清空
  items?: WorkBillItemInput[]; // 全量替换
}

export interface WorkBillListQuery {
  client_id?: number;
  contact?: string;
  keyword?: string; // 地址或备注包含（多 token AND）
  status?: string; // unsettled | partial | settled（派生）
  from?: string;
  to?: string;
  page?: number;
  page_size?: number;
}

export type WorkBillStatus = 'unsettled' | 'partial' | 'settled';

export interface WorkBillLedger {
  computed_total: number; // Σ items.amount
  receivable: number; // final_amount ?? computed_total
  paid: number; // Σ settlements.amount
  owed: number; // receivable - paid
  status: WorkBillStatus;
}

export interface WorkBillLedgerFull {
  bill: WorkBillRow;
  client_name: string;
  items: WorkBillItemRow[];
  settlements: WorkSettlementRow[];
  computed_total: number;
  receivable: number;
  paid: number;
  owed: number;
  status: WorkBillStatus;
}

export interface WorkBillListOut extends WorkBillLedger {
  id: number;
  client_id: number;
  client_name: string;
  contact: string;
  address: string;
  occurred_at: string;
  note: string;
  final_amount: number | null;
}

export interface WorkBillExportOut extends WorkBillListOut {
  client_name: string;
  client_type: WorkClientType;
  items: WorkBillItemRow[];
  formula: string;
}

// ── 归一化辅助 ──

function normalizeClientType(type?: unknown): WorkClientType {
  const t = (type ?? 'company') as string;
  if (t !== 'company' && t !== 'personal') throw new AppError(400, 'INVALID_CLIENT_TYPE', 'type 需为 company 或 personal');
  return t;
}

function normalizeQty(qty: unknown): number {
  const n = typeof qty === 'number' ? qty : Number(qty);
  if (!Number.isFinite(n) || n <= 0) throw new AppError(400, 'INVALID_QTY', 'qty 需为正数（可小数）');
  return n;
}

function normalizeUnitPrice(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new AppError(400, 'INVALID_UNIT_PRICE', 'unit_price 需为非负整数（单位：分）');
  return n;
}

function normalizeDate(s: unknown, field: string): string {
  const str = String(s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw new AppError(400, field === 'from' ? 'INVALID_FROM' : field === 'to' ? 'INVALID_TO' : 'INVALID_DATE', `${field} 需为 YYYY-MM-DD`);
  }
  return str;
}

function escLike(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 小计 = round(qty × 单价)。 */
function computeAmount(qty: number, unitPrice: number): number {
  return Math.round(qty * unitPrice);
}

function calcLedger(finalAmount: number | null, computedTotal: number, paid: number): WorkBillLedger {
  const receivable = finalAmount ?? computedTotal;
  const owed = receivable - paid;
  const status: WorkBillStatus = paid <= 0 ? 'unsettled' : paid >= receivable ? 'settled' : 'partial';
  return { computed_total: computedTotal, receivable, paid, owed, status };
}

function lookupUnitPrice(db: Database.Database, accountId: number, clientId: number, name: string): WorkUnitPriceRow | undefined {
  return db.prepare('SELECT * FROM work_unit_prices WHERE account_id = ? AND client_id = ? AND name = ?').get(accountId, clientId, name) as WorkUnitPriceRow | undefined;
}

// ── 委托方 ──

export function getClient(db: Database.Database, id: number): WorkClientRow | undefined {
  return db.prepare('SELECT * FROM work_clients WHERE id = ? AND is_deleted = 0').get(id) as WorkClientRow | undefined;
}

export function createClient(db: Database.Database, accountId: number, input: { name: unknown; type?: unknown; phone?: unknown; note?: unknown }): number {
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError(400, 'INVALID_BODY', 'name 不能为空');
  const info = db
    .prepare('INSERT INTO work_clients (account_id, name, type, phone, note) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, name, normalizeClientType(input.type), String(input.phone ?? ''), String(input.note ?? ''));
  return Number(info.lastInsertRowid);
}

export function updateClient(db: Database.Database, id: number, patch: { name?: unknown; type?: unknown; phone?: unknown; note?: unknown }): WorkClientRow | undefined {
  const client = getClient(db, id);
  if (!client) return undefined;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new AppError(400, 'INVALID_BODY', 'name 不能为空');
    sets.push('name = ?');
    args.push(n);
  }
  if (patch.type !== undefined) {
    sets.push('type = ?');
    args.push(normalizeClientType(patch.type));
  }
  if (patch.phone !== undefined) {
    sets.push('phone = ?');
    args.push(String(patch.phone));
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    args.push(String(patch.note));
  }
  if (sets.length === 0) return client;
  db.prepare(`UPDATE work_clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), id);
  return getClient(db, id)!;
}

export function softDeleteClient(db: Database.Database, id: number): WorkClientRow | undefined {
  const client = getClient(db, id);
  if (!client) return undefined;
  const activeBills = (db.prepare('SELECT COUNT(*) n FROM work_bills WHERE client_id = ? AND is_deleted = 0').get(id) as { n: number }).n;
  if (activeBills > 0) throw new AppError(400, 'CLIENT_HAS_BILLS', '该委托方下还有未删除的账单，不能删除');
  db.prepare('UPDATE work_clients SET is_deleted = 1, deleted_at = ? WHERE id = ?').run(now(), id);
  return client;
}

export function listClients(db: Database.Database, accountId: number, q: { q?: string } = {}): WorkClientRow[] {
  const conds = ['account_id = ?', 'is_deleted = 0'];
  const args: unknown[] = [accountId];
  if (q.q?.trim()) {
    const esc = escLike(q.q.trim());
    conds.push("(name LIKE '%' || ? || '%' ESCAPE '\\' OR phone LIKE '%' || ? || '%' ESCAPE '\\')");
    args.push(esc, esc);
  }
  return db.prepare(`SELECT * FROM work_clients WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC`).all(...args) as WorkClientRow[];
}

// ── 单价表 ──

export function upsertUnitPrice(db: Database.Database, accountId: number, input: { client_id: unknown; name: unknown; unit?: unknown; unit_price: unknown; note?: unknown }): WorkUnitPriceRow {
  const clientId = Number(input.client_id);
  const client = getClient(db, clientId);
  if (!client || client.account_id !== accountId) throw new AppError(404, 'WORK_CLIENT_NOT_FOUND', '委托方不存在');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError(400, 'INVALID_BODY', 'name 不能为空');
  const unit = String(input.unit ?? '个').trim() || '个';
  const unitPrice = normalizeUnitPrice(input.unit_price);
  const note = String(input.note ?? '');
  const existing = lookupUnitPrice(db, accountId, clientId, name);
  if (existing) {
    db.prepare('UPDATE work_unit_prices SET unit = ?, unit_price = ?, note = ?, updated_at = ? WHERE id = ?').run(unit, unitPrice, note, now(), existing.id);
    return db.prepare('SELECT * FROM work_unit_prices WHERE id = ?').get(existing.id) as WorkUnitPriceRow;
  }
  const info = db
    .prepare('INSERT INTO work_unit_prices (account_id, client_id, name, unit, unit_price, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(accountId, clientId, name, unit, unitPrice, note);
  return db.prepare('SELECT * FROM work_unit_prices WHERE id = ?').get(Number(info.lastInsertRowid)) as WorkUnitPriceRow;
}

export function listUnitPrices(db: Database.Database, accountId: number, q: { client_id?: number; q?: string } = {}): WorkUnitPriceRow[] {
  const conds = ['account_id = ?'];
  const args: unknown[] = [accountId];
  if (q.client_id !== undefined) {
    conds.push('client_id = ?');
    args.push(q.client_id);
  }
  if (q.q?.trim()) {
    conds.push("name LIKE '%' || ? || '%' ESCAPE '\\'");
    args.push(escLike(q.q.trim()));
  }
  return db.prepare(`SELECT * FROM work_unit_prices WHERE ${conds.join(' AND ')} ORDER BY client_id, name`).all(...args) as WorkUnitPriceRow[];
}

export function deleteUnitPrice(db: Database.Database, id: number, accountId: number): WorkUnitPriceRow | undefined {
  const row = db.prepare('SELECT * FROM work_unit_prices WHERE id = ? AND account_id = ?').get(id, accountId) as WorkUnitPriceRow | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM work_unit_prices WHERE id = ?').run(id); // 旧明细 price_ref_id 悬空，recalc 跳过
  return row;
}

// ── 账单明细归一 ──

function normalizeItems(db: Database.Database, accountId: number, clientId: number, items: unknown): Array<Omit<WorkBillItemRow, 'id' | 'bill_id' | 'sort'>> {
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'INVALID_BODY', 'items 不能为空');
  return items.map((raw, idx) => {
    const it = (raw ?? {}) as WorkBillItemInput;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) throw new AppError(400, 'INVALID_BODY', `items[${idx}].name 不能为空`);
    const explicitUnit = typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim() : null;
    const qty = normalizeQty(it.qty ?? 1);
    let unit = explicitUnit ?? '个';
    let unitPrice: number;
    let priceRefId: number | null = null;
    if (it.unit_price === undefined || it.unit_price === null) {
      const price = lookupUnitPrice(db, accountId, clientId, name);
      if (!price) throw new AppError(400, 'UNIT_PRICE_NOT_FOUND', `品名「${name}」在单价表无价，请提供 unit_price 或先在单价表设置`);
      unit = explicitUnit ?? price.unit;
      unitPrice = price.unit_price;
      priceRefId = price.id;
    } else {
      unitPrice = normalizeUnitPrice(it.unit_price);
    }
    return {
      name,
      qty,
      unit,
      unit_price: unitPrice,
      amount: computeAmount(qty, unitPrice),
      price_ref_id: priceRefId,
      note: typeof it.note === 'string' ? it.note.trim() : '',
    };
  });
}

function insertItems(db: Database.Database, billId: number, items: ReturnType<typeof normalizeItems>): void {
  const stmt = db.prepare('INSERT INTO work_bill_items (bill_id, name, qty, unit, unit_price, amount, price_ref_id, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  items.forEach((it, idx) => stmt.run(billId, it.name, it.qty, it.unit, it.unit_price, it.amount, it.price_ref_id, it.note, idx));
}

// ── 账单 ──

export function getWorkBill(db: Database.Database, id: number): { bill: WorkBillRow; items: WorkBillItemRow[]; settlements: WorkSettlementRow[] } | undefined {
  const bill = db.prepare('SELECT * FROM work_bills WHERE id = ? AND is_deleted = 0').get(id) as WorkBillRow | undefined;
  if (!bill) return undefined;
  const items = db.prepare('SELECT * FROM work_bill_items WHERE bill_id = ? ORDER BY sort, id').all(id) as WorkBillItemRow[];
  const settlements = db.prepare('SELECT * FROM work_settlements WHERE bill_id = ? ORDER BY settled_at, id').all(id) as WorkSettlementRow[];
  return { bill, items, settlements };
}

/** 单条 + 对账推导（computed_total/receivable/paid/owed/status）。 */
export function getWorkBillLedger(db: Database.Database, id: number): WorkBillLedgerFull | undefined {
  const full = getWorkBill(db, id);
  if (!full) return undefined;
  const computedTotal = full.items.reduce((s, i) => s + i.amount, 0);
  const paid = full.settlements.reduce((s, x) => s + x.amount, 0);
  const client = getClient(db, full.bill.client_id);
  return { ...full, client_name: client?.name ?? '', ...calcLedger(full.bill.final_amount, computedTotal, paid) };
}

export function createWorkBill(db: Database.Database, accountId: number, input: CreateWorkBillInput): number {
  const clientId = Number(input.client_id);
  if (!Number.isInteger(clientId) || clientId <= 0) throw new AppError(400, 'INVALID_CLIENT_ID', 'client_id 非法');
  const client = getClient(db, clientId);
  if (!client || client.account_id !== accountId) throw new AppError(404, 'WORK_CLIENT_NOT_FOUND', '委托方不存在');
  const occurredAt = normalizeDate(input.occurred_at, 'occurred_at');
  const normalized = normalizeItems(db, accountId, clientId, input.items);
  const finalAmount = input.final_amount === undefined || input.final_amount === null ? null : normalizeUnitPrice(input.final_amount);

  const run = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO work_bills (account_id, client_id, contact, address, occurred_at, note, final_amount) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, clientId, String(input.contact ?? ''), String(input.address ?? ''), occurredAt, String(input.note ?? ''), finalAmount);
    const billId = Number(info.lastInsertRowid);
    insertItems(db, billId, normalized);
    return billId;
  });
  return run();
}

export function updateWorkBill(db: Database.Database, id: number, accountId: number, patch: UpdateWorkBillPatch): WorkBillLedgerFull | undefined {
  const full = getWorkBill(db, id);
  if (!full) return undefined;
  const bill = full.bill;

  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.client_id !== undefined) {
    const client = getClient(db, Number(patch.client_id));
    if (!client || client.account_id !== accountId) throw new AppError(404, 'WORK_CLIENT_NOT_FOUND', '委托方不存在');
    sets.push('client_id = ?');
    args.push(client.id);
  }
  if (patch.address !== undefined) {
    sets.push('address = ?');
    args.push(String(patch.address));
  }
  if (patch.contact !== undefined) {
    sets.push('contact = ?');
    args.push(String(patch.contact));
  }
  if (patch.occurred_at !== undefined) {
    sets.push('occurred_at = ?');
    args.push(normalizeDate(patch.occurred_at, 'occurred_at'));
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    args.push(String(patch.note));
  }
  if (patch.final_amount !== undefined) {
    sets.push('final_amount = ?');
    args.push(patch.final_amount === null ? null : normalizeUnitPrice(patch.final_amount));
  }

  const run = db.transaction(() => {
    if (sets.length > 0) {
      db.prepare(`UPDATE work_bills SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), id);
    }
    if (patch.items !== undefined) {
      const clientId = patch.client_id !== undefined ? Number(patch.client_id) : bill.client_id;
      const normalized = normalizeItems(db, accountId, clientId, patch.items);
      db.prepare('DELETE FROM work_bill_items WHERE bill_id = ?').run(id);
      insertItems(db, id, normalized);
    }
  });
  run();
  return getWorkBillLedger(db, id);
}

export function softDeleteWorkBill(db: Database.Database, id: number): WorkBillRow | undefined {
  const full = getWorkBill(db, id);
  if (!full) return undefined;
  db.prepare('UPDATE work_bills SET is_deleted = 1, deleted_at = ? WHERE id = ?').run(now(), id);
  return full.bill;
}

/** 取一张工作账单（无视删除状态，回收站恢复/彻底删除用）。 */
export function getWorkBillAny(db: Database.Database, id: number): WorkBillRow | undefined {
  return db.prepare('SELECT * FROM work_bills WHERE id = ?').get(id) as WorkBillRow | undefined;
}

/** 回收站列表（该账户内已软删除的工作账单，按删除时间倒序）。 */
export function listWorkBillTrash(db: Database.Database, accountId: number): WorkBillRow[] {
  return db
    .prepare('SELECT * FROM work_bills WHERE account_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC, id DESC')
    .all(accountId) as WorkBillRow[];
}

/** 从回收站恢复。返回恢复后的账单快照（is_deleted=0）。 */
export function restoreWorkBill(db: Database.Database, id: number): WorkBillRow | undefined {
  const bill = getWorkBillAny(db, id);
  if (!bill || bill.is_deleted !== 1) return undefined;
  db.prepare('UPDATE work_bills SET is_deleted = 0, deleted_at = NULL WHERE id = ?').run(id);
  return getWorkBillAny(db, id)!;
}

/** 彻底删除（硬删，仅回收站内，不可恢复）。先清明细/结算子表（外键），再删主表。 */
export function purgeWorkBill(db: Database.Database, id: number): WorkBillRow | undefined {
  const bill = getWorkBillAny(db, id);
  if (!bill || bill.is_deleted !== 1) return undefined;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM work_bill_items WHERE bill_id = ?').run(id);
    db.prepare('DELETE FROM work_settlements WHERE bill_id = ?').run(id);
    db.prepare('DELETE FROM work_bills WHERE id = ?').run(id);
  });
  run();
  return bill;
}

// ── 列表 / 导出 ──

/** 派生表片段：每单 computed_total / paid（内部复用，勿外拼不信任输入）。 */
function buildBillFromSql(innerWhere: string): string {
  return `FROM (
    SELECT wb.*,
      COALESCE((SELECT SUM(i.amount) FROM work_bill_items i WHERE i.bill_id = wb.id), 0) AS computed_total,
      COALESCE((SELECT SUM(s.amount) FROM work_settlements s WHERE s.bill_id = wb.id), 0) AS paid
    FROM work_bills wb
    WHERE ${innerWhere}
  ) t`;
}

function buildStatusCond(status: string | undefined, alias = 't'): string {
  if (status === undefined) return '';
  if (status !== 'unsettled' && status !== 'partial' && status !== 'settled') {
    throw new AppError(400, 'INVALID_WORK_STATUS', 'status 需为 unsettled | partial | settled');
  }
  return `WHERE CASE WHEN ${alias}.paid = 0 THEN 'unsettled' WHEN ${alias}.paid >= COALESCE(${alias}.final_amount, ${alias}.computed_total) THEN 'settled' ELSE 'partial' END = ?`;
}

function buildWorkBillFilter(q: WorkBillListQuery & { account_id: number }): { innerWhere: string; args: unknown[] } {
  const conds = ['wb.account_id = ?', 'wb.is_deleted = 0'];
  const args: unknown[] = [q.account_id];
  if (q.client_id !== undefined) {
    conds.push('wb.client_id = ?');
    args.push(q.client_id);
  }
  if (q.contact?.trim()) {
    conds.push("wb.contact LIKE '%' || ? || '%' ESCAPE '\\'");
    args.push(escLike(q.contact.trim()));
  }
  if (q.keyword?.trim()) {
    // 地址或备注包含（多 token 拆词 AND；每个 token 匹配 address OR note）
    for (const token of q.keyword.trim().split(/\s+/)) {
      const esc = escLike(token);
      conds.push("(wb.address LIKE '%' || ? || '%' ESCAPE '\\' OR wb.note LIKE '%' || ? || '%' ESCAPE '\\')");
      args.push(esc, esc);
    }
  }
  if (q.from) {
    conds.push('wb.occurred_at >= ?');
    args.push(normalizeDate(q.from, 'from'));
  }
  if (q.to) {
    conds.push('wb.occurred_at <= ?');
    args.push(normalizeDate(q.to, 'to'));
  }
  return { innerWhere: conds.join(' AND '), args };
}

export function listWorkBills(db: Database.Database, accountId: number, q: WorkBillListQuery = {}): {
  items: WorkBillListOut[];
  total: number;
  page: number;
  page_size: number;
  applied: Record<string, string | number>;
} {
  const { innerWhere, args } = buildWorkBillFilter({ ...q, account_id: accountId });
  const fromSql = buildBillFromSql(innerWhere);
  const statusCond = buildStatusCond(q.status);
  const whereArgs = [...args, ...(q.status !== undefined ? [q.status] : [])];

  const total = (db.prepare(`SELECT COUNT(*) n ${fromSql} ${statusCond}`).get(...whereArgs) as { n: number }).n;

  const page = Number.isInteger(q.page) && (q.page as number) > 0 ? (q.page as number) : 1;
  const pageSize = Number.isInteger(q.page_size) && (q.page_size as number) > 0 ? Math.min(q.page_size as number, 200) : 50;
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS client_name ${fromSql} LEFT JOIN work_clients c ON c.id = t.client_id ${statusCond}
       ORDER BY t.occurred_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...whereArgs, pageSize, (page - 1) * pageSize) as Array<WorkBillRow & { computed_total: number; paid: number; client_name: string }>;

  const applied: Record<string, string | number> = { account_id: accountId };
  if (q.client_id !== undefined) applied.client_id = q.client_id;
  if (q.contact?.trim()) applied.contact = q.contact.trim();
  if (q.keyword?.trim()) applied.keyword = q.keyword.trim();
  if (q.status) applied.status = q.status;
  if (q.from) applied.from = q.from;
  if (q.to) applied.to = q.to;

  const items = rows.map((r) => {
    const ledger = calcLedger(r.final_amount, r.computed_total, r.paid);
    return { id: r.id, client_id: r.client_id, client_name: r.client_name, contact: r.contact, address: r.address, occurred_at: r.occurred_at, note: r.note, final_amount: r.final_amount, ...ledger };
  });
  return { items, total, page, page_size: pageSize, applied };
}

/** 对账式子：`欧派木门 2扇×1200元=2400元；进户门套 1套×500元=500元`。 */
export function buildWorkBillFormula(items: WorkBillItemRow[]): string {
  return items.map((it) => `${it.name} ${it.qty}${it.unit}×${yuan(it.unit_price)}元=${yuan(it.amount)}元`).join('；');
}

export function exportWorkBills(db: Database.Database, accountId: number, q: Omit<WorkBillListQuery, 'page' | 'page_size'> = {}): {
  bills: WorkBillExportOut[];
  total: number;
  applied: Record<string, string | number>;
} {
  const { innerWhere, args } = buildWorkBillFilter({ ...q, account_id: accountId });
  const whereArgs = [...args, ...(q.status !== undefined ? [q.status] : [])];

  const rows = db
    .prepare(
      `SELECT wbx.*, c.name AS client_name, c.type AS client_type
       FROM (
         SELECT wb.*,
           COALESCE((SELECT SUM(i.amount) FROM work_bill_items i WHERE i.bill_id = wb.id), 0) AS computed_total,
           COALESCE((SELECT SUM(s.amount) FROM work_settlements s WHERE s.bill_id = wb.id), 0) AS paid
         FROM work_bills wb
         WHERE ${innerWhere}
       ) wbx
       LEFT JOIN work_clients c ON c.id = wbx.client_id
       ${buildStatusCond(q.status, 'wbx')}
       ORDER BY wbx.occurred_at, wbx.id`,
    )
    .all(...whereArgs) as Array<WorkBillRow & { computed_total: number; paid: number; client_name: string; client_type: WorkClientType }>;

  const bills: WorkBillExportOut[] = rows.map((r) => {
    const items = db.prepare('SELECT * FROM work_bill_items WHERE bill_id = ? ORDER BY sort, id').all(r.id) as WorkBillItemRow[];
    const ledger = calcLedger(r.final_amount, r.computed_total, r.paid);
    return {
      id: r.id,
      client_id: r.client_id,
      client_name: r.client_name,
      client_type: r.client_type,
      contact: r.contact,
      address: r.address,
      occurred_at: r.occurred_at,
      note: r.note,
      final_amount: r.final_amount,
      items,
      formula: buildWorkBillFormula(items),
      ...ledger,
    };
  });

  const applied: Record<string, string | number> = { account_id: accountId };
  if (q.client_id !== undefined) applied.client_id = q.client_id;
  if (q.contact?.trim()) applied.contact = q.contact.trim();
  if (q.keyword?.trim()) applied.keyword = q.keyword.trim();
  if (q.status) applied.status = q.status;
  if (q.from) applied.from = q.from;
  if (q.to) applied.to = q.to;

  return { bills, total: bills.length, applied };
}

// ── CSV ──

/** 日常简版 CSV：一明细一行。 */
export function buildWorkBillsSummaryCsv(bills: WorkBillExportOut[]): string {
  const header = ['委托方', '地址', '联系人', '日期', '品名', '数量', '单位', '单价(元)', '金额(元)'];
  const rows: string[][] = [header];
  for (const b of bills) {
    for (const it of b.items) {
      rows.push([
        b.client_name,
        b.address,
        b.contact,
        b.occurred_at,
        it.name,
        Number.isInteger(it.qty) ? String(it.qty) : String(it.qty),
        it.unit,
        yuan(it.unit_price),
        yuan(it.amount),
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** 结账版 CSV：一单一列（含式子 + 对账），末尾追加总计行（合计应收/已收/欠款）。 */
export function buildWorkBillsStatementCsv(bills: WorkBillExportOut[]): string {
  const header = ['委托方', '地址', '联系人', '日期', '明细式子', '计算总额(元)', '实际应收(元)', '已收(元)', '欠款(元)', '状态'];
  const rows = bills.map((b) => [
    b.client_name,
    b.address,
    b.contact,
    b.occurred_at,
    b.formula,
    yuan(b.computed_total),
    yuan(b.receivable),
    yuan(b.paid),
    yuan(b.owed),
    b.status === 'settled' ? '已结算' : b.status === 'partial' ? '部分结算' : '未结算',
  ]);
  // 总计行（口径与 calcLedger 一致：应收/已收/欠款合计）
  if (bills.length > 0) {
    const sum = bills.reduce(
      (acc, b) => {
        acc.computed_total += b.computed_total;
        acc.receivable += b.receivable;
        acc.paid += b.paid;
        acc.owed += b.owed;
        return acc;
      },
      { computed_total: 0, receivable: 0, paid: 0, owed: 0 },
    );
    rows.push([
      '合计',
      '',
      '',
      `${bills.length} 单`,
      '',
      yuan(sum.computed_total),
      yuan(sum.receivable),
      yuan(sum.paid),
      yuan(sum.owed),
      '',
    ]);
  }
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

// ── 统计 ──

export interface WorkStatsQuery {
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  year?: number;
  month?: number;
  client_id?: number;
  status?: string; // unsettled | partial | settled
}

/**
 * 工作账单统计（账户内，不含已删除）：合计应收/已收/欠款 + 按委托方 + 按月份。
 * 口径与 calcLedger 一致：receivable = COALESCE(final_amount, Σ明细)；paid = Σ结算；owed = receivable - paid。
 * 返回 `{ bill_count, receivable, paid, owed, by_client, by_month, applied }`，金额「分」。
 */
export function workBillStats(db: Database.Database, accountId: number, q: WorkStatsQuery = {}): {
  bill_count: number;
  receivable: number;
  paid: number;
  owed: number;
  by_client: Array<{ client_id: number; client_name: string; bill_count: number; receivable: number; paid: number; owed: number }>;
  by_month: Array<{ month: string; bill_count: number; receivable: number; paid: number; owed: number }>;
  applied: Record<string, string | number | null>;
} {
  const range = resolveStatsRange({ from: q.from, to: q.to, year: q.year, month: q.month });

  const conds = ['wb.account_id = ?', 'wb.is_deleted = 0'];
  const args: unknown[] = [accountId];
  if (q.client_id !== undefined) {
    conds.push('wb.client_id = ?');
    args.push(q.client_id);
  }
  if (range.from) {
    conds.push('wb.occurred_at >= ?');
    args.push(range.from);
  }
  if (range.to) {
    conds.push('wb.occurred_at <= ?');
    args.push(range.to);
  }
  const innerWhere = conds.join(' AND ');

  const fromSql = `FROM (
    SELECT wb.*,
      COALESCE(wb.final_amount, (SELECT SUM(i.amount) FROM work_bill_items i WHERE i.bill_id = wb.id)) AS receivable,
      COALESCE((SELECT SUM(s.amount) FROM work_settlements s WHERE s.bill_id = wb.id), 0) AS paid,
      COALESCE(wb.final_amount, (SELECT SUM(i.amount) FROM work_bill_items i WHERE i.bill_id = wb.id))
        - COALESCE((SELECT SUM(s.amount) FROM work_settlements s WHERE s.bill_id = wb.id), 0) AS owed
    FROM work_bills wb
    WHERE ${innerWhere}
  ) wbx
  LEFT JOIN work_clients c ON c.id = wbx.client_id`;

  let statusWhere = '';
  if (q.status !== undefined) {
    if (q.status !== 'unsettled' && q.status !== 'partial' && q.status !== 'settled') {
      throw new AppError(400, 'INVALID_WORK_STATUS', 'status 需为 unsettled | partial | settled');
    }
    statusWhere = "WHERE CASE WHEN wbx.paid = 0 THEN 'unsettled' WHEN wbx.paid >= wbx.receivable THEN 'settled' ELSE 'partial' END = ?";
  }
  const whereArgs = [...args, ...(q.status !== undefined ? [q.status] : [])];

  const totals = db
    .prepare(`SELECT COUNT(*) bill_count, COALESCE(SUM(receivable), 0) receivable, COALESCE(SUM(paid), 0) paid, COALESCE(SUM(owed), 0) owed ${fromSql} ${statusWhere}`)
    .get(...whereArgs) as { bill_count: number; receivable: number; paid: number; owed: number };

  const byClient = db
    .prepare(
      `SELECT wbx.client_id, c.name AS client_name, COUNT(*) bill_count, COALESCE(SUM(wbx.receivable), 0) receivable,
              COALESCE(SUM(wbx.paid), 0) paid, COALESCE(SUM(wbx.owed), 0) owed
       ${fromSql} ${statusWhere} GROUP BY wbx.client_id ORDER BY owed DESC`,
    )
    .all(...whereArgs) as Array<{ client_id: number; client_name: string; bill_count: number; receivable: number; paid: number; owed: number }>;

  const byMonth = db
    .prepare(
      `SELECT strftime('%Y-%m', wbx.occurred_at) month, COUNT(*) bill_count, COALESCE(SUM(wbx.receivable), 0) receivable,
              COALESCE(SUM(wbx.paid), 0) paid, COALESCE(SUM(wbx.owed), 0) owed
       ${fromSql} ${statusWhere} GROUP BY strftime('%Y-%m', wbx.occurred_at) ORDER BY month`,
    )
    .all(...whereArgs) as Array<{ month: string; bill_count: number; receivable: number; paid: number; owed: number }>;

  const applied: Record<string, string | number | null> = { from: range.from, to: range.to };
  if (q.client_id !== undefined) applied.client_id = q.client_id;
  if (q.status) applied.status = q.status;

  return {
    bill_count: totals.bill_count,
    receivable: totals.receivable,
    paid: totals.paid,
    owed: totals.owed,
    by_client: byClient,
    by_month: byMonth,
    applied,
  };
}

// ── 每日变动汇总（work_digest 用）──

export interface WorkDailyChange {
  account_id: number;
  account_name: string;
  created: Array<{ bill_id: number; client_name: string; contact: string; receivable: number; status: WorkBillStatus }>;
  settled_count: number;
  settled_total: number;
  updated: number;
  deleted: number;
}

/**
 * 按 person 可见账户汇总当日工作账单变动（供每晚 work_digest 推送确认）。
 * created/updated/deleted 取自 operation_logs（entity='work_bills'，entity_id=账单 id）；
 * settled 直接查 work_settlements 表当日记录（结算日志 after 只存 bill 不含金额，故不走日志）。
 */
export function workBillChanges(db: Database.Database, personId: number, date: string): WorkDailyChange[] {
  const accounts = listAccountsForPerson(db, personId);
  if (accounts.length === 0) return [];
  const accountIds = accounts.map((a) => a.id);
  const placeholders = accountIds.map(() => '?').join(',');

  const logs = db
    .prepare(
      `SELECT account_id, action, entity_id FROM operation_logs
       WHERE entity IN ('work_bills','work_settlements') AND account_id IN (${placeholders}) AND substr(created_at,1,10) = ?`,
    )
    .all(...accountIds, date) as Array<{ account_id: number; action: string; entity_id: number }>;

  const byAccount = new Map<number, { created: number[]; settled_count: number; settled_total: number; updated: number; deleted: number }>();
  for (const log of logs) {
    const entry = byAccount.get(log.account_id) ?? { created: [], settled_count: 0, settled_total: 0, updated: 0, deleted: 0 };
    if (log.entity_id === undefined) continue;
    if (log.action === 'work_bill.create') entry.created.push(log.entity_id);
    else if (log.action === 'work_bill.update') entry.updated++;
    else if (log.action === 'work_bill.delete') entry.deleted++;
    byAccount.set(log.account_id, entry);
  }

  // 结算：当日实际入账（JOIN 可见账单）
  const settlements = db
    .prepare(
      `SELECT s.amount, wb.account_id FROM work_settlements s
       JOIN work_bills wb ON wb.id = s.bill_id
       WHERE wb.account_id IN (${placeholders}) AND substr(s.created_at,1,10) = ?`,
    )
    .all(...accountIds, date) as Array<{ amount: number; account_id: number }>;
  for (const s of settlements) {
    const entry = byAccount.get(s.account_id) ?? { created: [], settled_count: 0, settled_total: 0, updated: 0, deleted: 0 };
    entry.settled_count++;
    entry.settled_total += s.amount;
    byAccount.set(s.account_id, entry);
  }

  const result: WorkDailyChange[] = [];
  for (const account of accounts) {
    const entry = byAccount.get(account.id);
    if (!entry) continue;
    const created = entry.created
      .map((billId) => {
        const ledger = getWorkBillLedger(db, billId);
        if (!ledger) return null;
        const client = getClient(db, ledger.bill.client_id);
        return {
          bill_id: billId,
          client_name: client?.name ?? '',
          contact: ledger.bill.contact,
          receivable: ledger.receivable,
          status: ledger.status,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    result.push({
      account_id: account.id,
      account_name: account.name,
      created,
      settled_count: entry.settled_count,
      settled_total: entry.settled_total,
      updated: entry.updated,
      deleted: entry.deleted,
    });
  }
  return result;
}

// ── 结算 ──

export function settleWorkBill(db: Database.Database, id: number, input: { amount: unknown; settled_at?: unknown; note?: unknown }): WorkBillLedgerFull | undefined {
  const full = getWorkBill(db, id);
  if (!full) return undefined;
  const amount = normalizeUnitPrice(input.amount);
  if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', '结算金额需大于 0（分）');
  const settledAt = normalizeDate(input.settled_at ?? today(), 'settled_at');
  db.prepare('INSERT INTO work_settlements (bill_id, amount, settled_at, note) VALUES (?, ?, ?, ?)').run(id, amount, settledAt, String(input.note ?? ''));
  return getWorkBillLedger(db, id);
}

export interface WorkBatchSettleResult {
  total_applied: number;
  remaining: number;
  applied: Array<{ bill_id: number; applied: number; owed_before: number; owed_after: number }>;
}

/**
 * 批量结算：按调用方给定的账单 ID 组（bill_ids 顺序）收一笔款冲抵这几张未结账单。
 * 只结算指定单（须同账户、可见），不会动其它单——避免误结算。
 * 每单插入一条 work_settlements（日期=今天）；已结清/无欠款跳过；事务包裹。
 * 返回冲抵明细与剩余未冲金额。
 */
export function settleWorkBillsBatch(
  db: Database.Database,
  accountId: number,
  input: { bill_ids: unknown[]; amount: unknown; note?: unknown },
): WorkBatchSettleResult {
  if (!Array.isArray(input.bill_ids) || input.bill_ids.length === 0) {
    throw new AppError(400, 'INVALID_BODY', 'bill_ids 不能为空（需指定要结算的账单组）');
  }
  const amount = normalizeUnitPrice(input.amount);
  if (amount <= 0) throw new AppError(400, 'INVALID_AMOUNT', '结算金额需大于 0（分）');

  // 按 bill_ids 传入顺序取单（去重；只保留同账户可见单）
  const bills: WorkBillRow[] = [];
  const seen = new Set<number>();
  for (const raw of input.bill_ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const bill = getWorkBillAny(db, id);
    if (bill && bill.account_id === accountId) bills.push(bill);
  }
  if (bills.length === 0) throw new AppError(404, 'WORK_BILL_NOT_FOUND', '指定的账单不存在或无权访问');

  const applied: WorkBatchSettleResult['applied'] = [];
  let remaining = amount;
  const run = db.transaction(() => {
    for (const bill of bills) {
      if (remaining <= 0) break;
      const ledger = getWorkBillLedger(db, bill.id);
      if (!ledger || ledger.owed <= 0) continue; // 已结清/无欠款跳过
      const a = Math.min(remaining, ledger.owed);
      db.prepare('INSERT INTO work_settlements (bill_id, amount, settled_at, note) VALUES (?, ?, ?, ?)').run(
        bill.id,
        a,
        today(),
        String(input.note ?? ''),
      );
      applied.push({ bill_id: bill.id, applied: a, owed_before: ledger.owed, owed_after: ledger.owed - a });
      remaining -= a;
    }
  });
  run();

  return { total_applied: amount - remaining, remaining, applied };
}

// ── 批量重算（纯手动；改单价表不自动级联）──

export function recalcWorkBills(db: Database.Database, accountId: number, q: {
  bill_ids?: number[];
  client_id?: number;
  from?: string;
  to?: string;
  dry_run?: boolean;
} = {}): {
  dry_run: boolean;
  affected_bills: number;
  total_changes: number;
  changed: Array<{ bill_id: number; item_id: number; name: string; qty: number; unit: string; old_price: number; new_price: number; old_amount: number; new_amount: number }>;
  applied: Record<string, string | number>;
} {
  // 选目标单：指定 bill_ids，否则按 client/日期 筛全部未完全结算单
  let targetIds: number[];
  const applied: Record<string, string | number> = { account_id: accountId };
  if (q.bill_ids?.length) {
    targetIds = q.bill_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    applied.bill_ids = targetIds.join(',');
  } else {
    const conds = ['account_id = ?', 'is_deleted = 0'];
    const args: unknown[] = [accountId];
    if (q.client_id !== undefined) {
      conds.push('client_id = ?');
      args.push(q.client_id);
      applied.client_id = q.client_id;
    }
    if (q.from) {
      conds.push('occurred_at >= ?');
      args.push(normalizeDate(q.from, 'from'));
      applied.from = q.from;
    }
    if (q.to) {
      conds.push('occurred_at <= ?');
      args.push(normalizeDate(q.to, 'to'));
      applied.to = q.to;
    }
    targetIds = (db.prepare(`SELECT id FROM work_bills WHERE ${conds.join(' AND ')}`).all(...args) as { id: number }[]).map((r) => r.id);
  }

  const dry = q.dry_run !== false;
  const changed: Array<{ bill_id: number; item_id: number; name: string; qty: number; unit: string; old_price: number; new_price: number; old_amount: number; new_amount: number }> = [];

  const run = db.transaction(() => {
    for (const billId of targetIds) {
      const full = getWorkBill(db, billId);
      if (!full || full.bill.account_id !== accountId) throw new AppError(404, 'WORK_BILL_NOT_FOUND', `账单 ${billId} 不存在或无权访问`);
      const computedTotal = full.items.reduce((s, i) => s + i.amount, 0);
      const paid = full.settlements.reduce((s, x) => s + x.amount, 0);
      if (paid >= (full.bill.final_amount ?? computedTotal)) continue; // 已结算锁定
      for (const item of full.items) {
        if (item.price_ref_id === null) continue; // 手填价不动
        const price = db.prepare('SELECT * FROM work_unit_prices WHERE id = ? AND account_id = ?').get(item.price_ref_id, accountId) as WorkUnitPriceRow | undefined;
        if (!price) continue; // 单价表条目已删，悬空不重算
        const newAmount = computeAmount(item.qty, price.unit_price);
        if (price.unit_price !== item.unit_price) {
          changed.push({
            bill_id: billId,
            item_id: item.id,
            name: item.name,
            qty: item.qty,
            unit: item.unit,
            old_price: item.unit_price,
            new_price: price.unit_price,
            old_amount: item.amount,
            new_amount: newAmount,
          });
          if (!dry) {
            db.prepare('UPDATE work_bill_items SET unit_price = ?, amount = ? WHERE id = ?').run(price.unit_price, newAmount, item.id);
          }
        }
      }
    }
  });
  run();

  const affectedBills = new Set(changed.map((c) => c.bill_id)).size;
  return { dry_run: dry, affected_bills: affectedBills, total_changes: changed.length, changed, applied };
}
