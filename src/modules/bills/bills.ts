/**
 * 记账核心（M2，对应设计文档 §4.5 / §5.1 / ADR D20/D21/D24/D26）。
 *
 * 关键设计：
 *  - 金额一律用「分」整数存（避免浮点误差），接口层与 LLM 传的是元。
 *  - 记录人 person_id = 实际垫付者；participants = 待收对象（欠垫付者的人），
 *    只存 [{name, status, paid_at}]，不记每人应付金额、不算分摊（D24，口头约定，可写 note）。
 *  - 软删除：is_deleted=1 进回收站，可恢复。
 *  - 分类用泛用固定集（D21）：餐饮/交通/购物/居住/娱乐/医疗/教育/人情/其他。
 *  - 账户归属（D26）：可显式 account_id，省略时用该 person 唯一可用账户，多个则报 ACCOUNT_AMBIGUOUS。
 *  - 所有写操作由路由层记 operation_logs（before/after 快照），供账单变动日报使用。
 */
import type Database from 'better-sqlite3';
import { now, parseJson, today } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import { listAccountsForPerson, resolveAccountId } from '../system/accounts.js';

// 账户归属解析（D26）已上移到 system/accounts.ts（bills 与 tasks 共用），这里透传导出，
// 避免已有 bills 路由的 import 路径改动。
export { resolveAccountId };

// ── 常量 ──

export const BILL_CATEGORIES = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '其他'] as const;
export type BillCategory = (typeof BILL_CATEGORIES)[number];
export type BillType = 'income' | 'expense';
export type BillStatus = 'settled' | 'pending';

// ── 类型 ──

export interface BillParticipant {
  name: string;          // 参与人名字（display_name 或临时名字）
  status: 'pending' | 'paid';
  paid_at: string | null;
}

export interface BillRow {
  id: number;
  account_id: number;
  person_id: number;     // 记录人（= 垫付者）
  type: BillType;
  amount: number;        // 分
  category: string;
  note: string;
  occurred_at: string;   // 发生时间
  status: BillStatus;
  participants: string;  // JSON 字符串
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 对外展示的账单（participants 解析成数组）。 */
export type BillOut = Omit<BillRow, 'participants'> & { participants: BillParticipant[] };

export interface CreateBillInput {
  type: BillType;
  amount: number;
  category?: string;
  note?: string;
  occurred_at?: string;
  participants?: unknown;
}

export interface UpdateBillPatch {
  type?: BillType;
  amount?: number;
  category?: string;
  note?: string;
  occurred_at?: string;
  participants?: unknown;
}

// ── 解析/校验辅助 ──

/** 解析 participants JSON 串成数组；损坏时回退空数组。 */
export function parseParticipants(s: string): BillParticipant[] {
  return parseJson<BillParticipant[]>(s, []);
}

/**
 * 把接口层传入的 participants（[{name}] 或原始 [{name,status}]）规范成标准结构。
 * 规则：name 去空格、去空、按名去重（保留第一个）；状态统一为 pending。
 * 返回空数组 = 不是 AA 单。
 */
export function normalizeParticipants(input: unknown): BillParticipant[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: BillParticipant[] = [];
  for (const item of input) {
    const raw = (item as Record<string, unknown>) ?? {};
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, status: 'pending', paid_at: null });
  }
  return out;
}

/** 规范化发生时间：缺省=现在；纯日期 "YYYY-MM-DD" 补成当天 00:00:00；非法则 400。 */
function normalizeOccurredAt(input?: string): string {
  if (input === undefined || input === '') return now();
  const s = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(s)) {
    throw new AppError(400, 'INVALID_OCCURRED_AT', 'occurred_at 需为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS');
  }
  return s.length === 10 ? `${s} 00:00:00` : s;
}

/** 校验 type/amount/category/occurred_at 一组字段（create 与 update 共用）。 */
function validateFields(patch: { type?: unknown; amount?: unknown; category?: unknown; occurred_at?: unknown }): void {
  if (patch.type !== undefined && patch.type !== 'income' && patch.type !== 'expense') {
    throw new AppError(400, 'INVALID_TYPE', 'type 需为 income 或 expense');
  }
  if (patch.amount !== undefined && (!Number.isInteger(patch.amount) || (patch.amount as number) <= 0)) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount 需为正整数（单位：分）');
  }
  if (patch.category !== undefined && !BILL_CATEGORIES.includes(patch.category as BillCategory)) {
    throw new AppError(400, 'INVALID_CATEGORY', `category 需为固定分类之一: ${BILL_CATEGORIES.join('/')}`);
  }
  if (patch.occurred_at !== undefined) {
    normalizeOccurredAt(patch.occurred_at as string); // 非法会抛 400
  }
}

// ── 查询 ──

/** 取一条未删除账单；已删除或不存在返回 undefined。 */
export function getActiveBill(db: Database.Database, billId: number): BillRow | undefined {
  return db
    .prepare('SELECT * FROM bills WHERE id = ? AND is_deleted = 0')
    .get(billId) as BillRow | undefined;
}

/** 取一条账单（含已删除，供回收站用）；不存在返回 undefined。 */
export function getBillAny(db: Database.Database, billId: number): BillRow | undefined {
  return db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as BillRow | undefined;
}

/** 账单对外展示结构。 */
export function toOut(bill: BillRow): BillOut {
  return { ...bill, participants: parseParticipants(bill.participants) };
}

export interface BillListQuery {
  type?: string;
  category?: string;
  status?: string;
  participant?: string;
  month?: string;   // YYYY-MM
  year?: string;    // YYYY
  from?: string;    // YYYY-MM-DD
  to?: string;      // YYYY-MM-DD
  page?: number;
  page_size?: number;
}

/**
 * 列表查询（账户内），支持类型/分类/状态/参与人/月份/年份/日期区间筛选 + 分页。
 * 按发生时间倒序。返回 { items, total, page, page_size }。
 */
export function listBills(db: Database.Database, accountId: number, q: BillListQuery) {
  const conds: string[] = ['account_id = ?', 'is_deleted = 0'];
  const args: unknown[] = [accountId];

  if (q.type) {
    if (q.type !== 'income' && q.type !== 'expense') throw new AppError(400, 'INVALID_TYPE', 'type 需为 income 或 expense');
    conds.push('type = ?');
    args.push(q.type);
  }
  if (q.category) {
    if (!BILL_CATEGORIES.includes(q.category as BillCategory)) throw new AppError(400, 'INVALID_CATEGORY', `category 非法: ${q.category}`);
    conds.push('category = ?');
    args.push(q.category);
  }
  if (q.status) {
    if (q.status !== 'settled' && q.status !== 'pending') throw new AppError(400, 'INVALID_STATUS', 'status 需为 settled 或 pending');
    conds.push('status = ?');
    args.push(q.status);
  }
  if (q.participant) {
    // participants 是 JSON 数组，用 SQLite 的 json_each 按参与人名字过滤（比 LIKE 可靠）
    conds.push("EXISTS (SELECT 1 FROM json_each(bills.participants) je WHERE json_extract(je.value, '$.name') = ?)");
    args.push(q.participant);
  }
  if (q.month) {
    if (!/^\d{4}-\d{2}$/.test(q.month)) throw new AppError(400, 'INVALID_MONTH', 'month 需为 YYYY-MM');
    conds.push("strftime('%Y-%m', occurred_at) = ?");
    args.push(q.month);
  }
  if (q.year) {
    if (!/^\d{4}$/.test(q.year)) throw new AppError(400, 'INVALID_YEAR', 'year 需为 YYYY');
    conds.push("strftime('%Y', occurred_at) = ?");
    args.push(q.year);
  }
  if (q.from) {
    conds.push('occurred_at >= ?');
    args.push(`${q.from} 00:00:00`);
  }
  if (q.to) {
    conds.push('occurred_at <= ?');
    args.push(`${q.to} 23:59:59`);
  }

  const where = conds.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) n FROM bills WHERE ${where}`).get(...args) as { n: number }).n;

  const page = Number.isInteger(q.page) && (q.page as number) > 0 ? (q.page as number) : 1;
  const pageSize = Number.isInteger(q.page_size) && (q.page_size as number) > 0 ? Math.min(q.page_size as number, 200) : 50;
  const rows = db
    .prepare(`SELECT * FROM bills WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as BillRow[];

  return { items: rows.map(toOut), total, page, page_size: pageSize };
}

/** CSV 导出用：账户内全部未删除账单（可选日期区间，无分页上限）。 */
export function exportBills(
  db: Database.Database,
  accountId: number,
  range?: { from?: string; to?: string },
): BillRow[] {
  const conds = ['account_id = ?', 'is_deleted = 0'];
  const args: unknown[] = [accountId];
  if (range?.from) {
    conds.push('occurred_at >= ?');
    args.push(`${range.from} 00:00:00`);
  }
  if (range?.to) {
    conds.push('occurred_at <= ?');
    args.push(`${range.to} 23:59:59`);
  }
  return db
    .prepare(`SELECT * FROM bills WHERE ${conds.join(' AND ')} ORDER BY occurred_at, id`)
    .all(...args) as BillRow[];
}

// ── 写操作 ──

/** 建一笔账单。participants 非空 → status=pending（AA 单），否则 settled。返回新 id。 */
export function createBill(db: Database.Database, input: CreateBillInput & { account_id: number; person_id: number }): number {
  validateFields(input);
  const participants = normalizeParticipants(input.participants);
  const status: BillStatus = participants.length > 0 ? 'pending' : 'settled';
  const occurredAt = normalizeOccurredAt(input.occurred_at);
  const info = db
    .prepare(
      `INSERT INTO bills (account_id, person_id, type, amount, category, note, occurred_at, status, participants)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.account_id,
      input.person_id,
      input.type,
      input.amount,
      input.category ?? '其他',
      input.note ?? '',
      occurredAt,
      status,
      JSON.stringify(participants),
    );
  return Number(info.lastInsertRowid);
}

/** 改一笔账单（金额/类别/备注/时间/参与人）。participants 变化时重算 status。返回 {before, after}。 */
export function updateBill(
  db: Database.Database,
  billId: number,
  patch: UpdateBillPatch,
): { before: BillRow; after: BillRow } | undefined {
  const before = getActiveBill(db, billId);
  if (!before) return undefined;

  validateFields(patch);
  // 注意：patch 可能带 undefined 值的字段（路由层构造），绝不能整对象 spread 覆盖 before，
  // 否则会把已有字段覆写成 undefined 并在绑定参数时炸掉。只按显式提供的字段逐个应用。
  const after: BillRow = { ...before };
  if (patch.type !== undefined) after.type = patch.type;
  if (patch.amount !== undefined) after.amount = patch.amount;
  if (patch.category !== undefined) after.category = patch.category;
  if (patch.note !== undefined) after.note = patch.note;
  if (patch.occurred_at !== undefined) after.occurred_at = normalizeOccurredAt(patch.occurred_at);
  if (patch.participants !== undefined) {
    const parts = normalizeParticipants(patch.participants);
    after.participants = JSON.stringify(parts);
    after.status = parts.length === 0 || parts.every((p) => p.status === 'paid') ? 'settled' : 'pending';
  }
  after.updated_at = now();

  db.prepare(
    `UPDATE bills SET type = ?, amount = ?, category = ?, note = ?, occurred_at = ?, status = ?, participants = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    after.type,
    after.amount,
    after.category,
    after.note,
    after.occurred_at,
    after.status,
    after.participants,
    after.updated_at,
    billId,
  );
  return { before, after };
}

/** 软删除（进回收站）。返回被删账单。 */
export function softDeleteBill(db: Database.Database, billId: number): BillRow | undefined {
  const bill = getActiveBill(db, billId);
  if (!bill) return undefined;
  db.prepare(`UPDATE bills SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?`).run(
    now(),
    now(),
    billId,
  );
  return bill;
}

/** 从回收站恢复。返回恢复后的账单快照（is_deleted=0）。 */
export function restoreBill(db: Database.Database, billId: number): BillRow | undefined {
  const bill = getBillAny(db, billId);
  if (!bill || bill.is_deleted !== 1) return undefined;
  db.prepare(`UPDATE bills SET is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), billId);
  return getBillAny(db, billId); // 返回更新后的快照（不能返回改之前的旧对象）
}

/** 回收站列表（该账户内已软删除的账单，按删除时间倒序）。 */
export function listTrash(db: Database.Database, accountId: number): BillRow[] {
  return db
    .prepare('SELECT * FROM bills WHERE account_id = ? AND is_deleted = 1 ORDER BY deleted_at DESC, id DESC')
    .all(accountId) as BillRow[];
}

export interface SettleInput {
  participantName?: string; // 结算某一位
  all?: boolean;            // 全部结清
}

/**
 * AA 结算（D24）：
 *  - all=true → 全部参与人置 paid。
 *  - participantName → 只结那一位（必须是 participants 里的名字）。
 *  - 结算后若全部 paid（或本来就无参与人）→ bills.status 自动回 settled。
 * 返回 { before, after }。
 */
export function settleBill(
  db: Database.Database,
  billId: number,
  input: SettleInput,
): { before: BillRow; after: BillRow } | undefined {
  const before = getActiveBill(db, billId);
  if (!before) return undefined;

  const participants = parseParticipants(before.participants);
  if (participants.length === 0) {
    throw new AppError(400, 'NOT_AA_BILL', '该账单没有待结算参与人（非 AA 单）');
  }

  if (input.all === true) {
    for (const p of participants) {
      p.status = 'paid';
      p.paid_at = p.paid_at ?? now();
    }
  } else if (typeof input.participantName === 'string' && input.participantName.trim()) {
    const target = participants.find((p) => p.name === input.participantName!.trim());
    if (!target) {
      throw new AppError(404, 'PARTICIPANT_NOT_FOUND', `参与人不存在: ${input.participantName}`);
    }
    if (target.status !== 'paid') {
      target.status = 'paid';
      target.paid_at = now();
    }
  } else {
    throw new AppError(400, 'INVALID_BODY', '需提供 participant_name 或 all:true');
  }

  const after: BillRow = {
    ...before,
    participants: JSON.stringify(participants),
    status: participants.every((p) => p.status === 'paid') ? 'settled' : 'pending',
    updated_at: now(),
  };
  db.prepare('UPDATE bills SET status = ?, participants = ?, updated_at = ? WHERE id = ?').run(
    after.status,
    after.participants,
    after.updated_at,
    billId,
  );
  return { before, after };
}

// ── 批量录入（D20）──

/**
 * 批量录入：事务内插入多笔（同一账户）。
 * 调用前提：路由已把清单校验过一轮（D20：LLM 先列清单请用户确认再调用）。
 * 返回每笔的 id。
 */
export function batchCreateBills(
  db: Database.Database,
  input: { bills: CreateBillInput[]; account_id: number; person_id: number },
): number[] {
  const validated = input.bills.map((b) => ({ ...b, account_id: input.account_id, person_id: input.person_id }));
  const insert = db.transaction(() => validated.map((b) => createBill(db, b)));
  return insert();
}

// ── 统计 ──

export interface StatsQuery {
  year?: number;
  month?: number;   // 1-12
  category?: string;
}

/**
 * 统计（账户内，不含已删除）：
 *  - income/expense：区间内收入/支出合计。
 *  - by_category：支出按分类汇总（[{category, amount, count}]，金额降序）。
 *  - trend：月度趋势 [{month:'YYYY-MM', income, expense}]。
 *    给 year → 该年 12 个月；year+month → 单月；都不给 → 最近 6 个月。
 */
export function billStats(db: Database.Database, accountId: number, q: StatsQuery) {
  const baseConds = ['account_id = ?', 'is_deleted = 0'];
  const baseArgs: unknown[] = [accountId];
  if (q.category) {
    if (!BILL_CATEGORIES.includes(q.category as BillCategory)) throw new AppError(400, 'INVALID_CATEGORY', `category 非法: ${q.category}`);
    baseConds.push('category = ?');
    baseArgs.push(q.category);
  }
  const baseWhere = baseConds.join(' AND ');

  const totals = db
    .prepare(`SELECT type, SUM(amount) total, COUNT(*) n FROM bills WHERE ${baseWhere} GROUP BY type`)
    .all(...baseArgs) as { type: BillType; total: number; n: number }[];
  const income = totals.find((t) => t.type === 'income')?.total ?? 0;
  const expense = totals.find((t) => t.type === 'expense')?.total ?? 0;

  const byCategory = db
    .prepare(
      `SELECT category, SUM(amount) amount, COUNT(*) count FROM bills
       WHERE ${baseWhere} AND type = 'expense' GROUP BY category ORDER BY amount DESC`,
    )
    .all(...baseArgs) as { category: string; amount: number; count: number }[];

  // 趋势：逐月查询（家庭规模 12 次小查询足够）
  const months = trendMonths(q.year, q.month);
  const trend = months.map((ym) => {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) income,
           SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) expense
         FROM bills WHERE ${baseWhere} AND strftime('%Y-%m', occurred_at) = ?`,
      )
      .get(...baseArgs, ym) as { income: number; expense: number };
    return { month: ym, income: row.income, expense: row.expense };
  });

  return { income, expense, by_category: byCategory, trend };
}

/** 生成趋势要展示的月份列表（YYYY-MM）。 */
function trendMonths(year?: number, month?: number): string[] {
  const cur = now();
  const curY = Number(cur.slice(0, 4));
  const curM = Number(cur.slice(5, 7));
  const pad = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

  if (year !== undefined && month !== undefined) {
    return [pad(year, month)];
  }
  if (year !== undefined) {
    return Array.from({ length: 12 }, (_, i) => pad(year, i + 1));
  }
  // 都不给 → 最近 6 个月（含本月），向前推并处理跨年
  const out: string[] = [];
  for (let k = 5; k >= 0; k--) {
    let y = curY;
    let m = curM - k;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    out.push(pad(y, m));
  }
  return out;
}

// ── 账单变动（on-demand 版日报，工具 query_bill_changes）──

export interface ChangeSummary {
  account_id: number;
  account_name: string;
  created: BillOut[];
  updated: Array<BillOut & { changed_fields: string[] }>;
  deleted: BillOut[];
  restored: BillOut[];
  settled: Array<{ bill_id: number; note: string; participants: string[] }>;
  suspect_duplicates: Array<{ amount: number; category: string; count: number; bill_ids: number[] }>;
}

/**
 * 汇总某 person 可见账户在指定日期（默认今天）的账单变动。
 * 数据源 = operation_logs（entity='bills'）。
 * 另附"疑似重复"：同日同账户同金额同分类的新增 >1 条（仅提示，不自动处理）。
 */
export function billChanges(db: Database.Database, personId: number, date?: string): { date: string; changes: ChangeSummary[] } {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
  const accounts = listAccountsForPerson(db, personId);
  if (accounts.length === 0) return { date: d, changes: [] };

  const placeholders = accounts.map(() => '?').join(', ');
  const logs = db
    .prepare(
      `SELECT * FROM operation_logs
       WHERE entity = 'bills' AND account_id IN (${placeholders}) AND substr(created_at, 1, 10) = ?
       ORDER BY created_at, id`,
    )
    .all(...accounts.map((a) => a.id), d) as Array<{
    id: number;
    account_id: number;
    person_id: number | null;
    action: string;
    entity_id: number;
    before_data: string | null;
    after_data: string | null;
    created_at: string;
  }>;

  // 按账户分组初始化
  const byAccount = new Map<number, ChangeSummary>();
  for (const a of accounts) {
    byAccount.set(a.id, {
      account_id: a.id,
      account_name: a.name,
      created: [],
      updated: [],
      deleted: [],
      restored: [],
      settled: [],
      suspect_duplicates: [],
    });
  }

  for (const log of logs) {
    const summary = byAccount.get(log.account_id);
    if (!summary) continue;
    const after = log.after_data ? (JSON.parse(log.after_data) as BillRow) : undefined;
    const before = log.before_data ? (JSON.parse(log.before_data) as BillRow) : undefined;

    switch (log.action) {
      case 'bill.create': {
        if (after) summary.created.push(toOut(after));
        break;
      }
      case 'bill.update': {
        if (after && before) {
          const changed = Object.keys(after).filter((k) => after[k as keyof BillRow] !== before[k as keyof BillRow]);
          summary.updated.push({ ...toOut(after), changed_fields: changed.filter((k) => k !== 'updated_at') });
        }
        break;
      }
      case 'bill.delete': {
        if (before) summary.deleted.push(toOut(before));
        break;
      }
      case 'bill.restore': {
        if (after) summary.restored.push(toOut(after));
        break;
      }
      case 'bill.settle': {
        if (after && before) {
          const beforeParts = parseParticipants(before.participants);
          const afterParts = parseParticipants(after.participants);
          const justPaid = afterParts
            .filter((p) => p.status === 'paid')
            .map((p) => p.name)
            .filter((name) => !beforeParts.some((b) => b.name === name && b.status === 'paid'));
          summary.settled.push({ bill_id: after.id, note: after.note, participants: justPaid });
        }
        break;
      }
      // 其他 action（如将来新增）忽略
    }
  }

  // 疑似重复：同账户 同金额+同分类 的 bill.create 超过 1 条
  for (const summary of byAccount.values()) {
    const groups = new Map<string, { amount: number; category: string; ids: number[] }>();
    for (const c of summary.created) {
      const key = `${c.amount}|${c.category}`;
      const g = groups.get(key) ?? { amount: c.amount, category: c.category, ids: [] };
      g.ids.push(c.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      if (g.ids.length > 1) {
        summary.suspect_duplicates.push({ amount: g.amount, category: g.category, count: g.ids.length, bill_ids: g.ids });
      }
    }
  }

  return { date: d, changes: [...byAccount.values()].filter((c) => isChangeEmpty(c) === false) };
}

/** 判断某账户当日是否真有变动（没变动就不放进返回）。 */
function isChangeEmpty(c: ChangeSummary): boolean {
  return (
    c.created.length === 0 &&
    c.updated.length === 0 &&
    c.deleted.length === 0 &&
    c.restored.length === 0 &&
    c.settled.length === 0
  );
}
