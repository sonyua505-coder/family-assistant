/**
 * 家庭共享任务数据访问层（M4，对应设计文档 §4.6 / §5.2 / ADR D25）。
 * 归属账户：family 账户下共享（一人记录全家可查），personal 账户下即个人待办。
 * 可关联待结算账单（linked_bill_id）；可选 remind_at 到点由 reminder_due 写 outbox。
 */
import type Database from 'better-sqlite3';
import { now } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import { csvCell, getActiveBill } from '../bills/bills.js';

export interface TaskRow {
  id: number;
  account_id: number;
  creator_id: number;
  platform: string;
  content: string;
  category: string;
  is_done: number;
  done_at: string | null;
  remind_at: string | null;
  reminded: number;
  linked_bill_id: number | null;
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
}

export interface CreateTaskInput {
  account_id: number;
  creator_id: number;
  platform: string;
  content: string;
  category?: string;
  remind_at?: unknown; // 由 normalizeRemindAt 校验归一
  linked_bill_id?: number | null;
}

/** 校验 remind_at 格式（YYYY-MM-DD[ HH:MM[:SS]]），合法归一成完整时间串；缺省 null。 */
export function normalizeRemindAt(input?: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
    throw new AppError(400, 'INVALID_REMIND_AT', 'remind_at 需为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM');
  }
  const base = s.length >= 10 ? s.slice(0, 10) : s;
  const time = s.length > 10 ? s.slice(11).padEnd(8, ':00') : '00:00:00';
  return `${base} ${time}`;
}

/** 建任务，返回新 id。 */
export function createTask(db: Database.Database, input: CreateTaskInput): number {
  const info = db
    .prepare(
      `INSERT INTO tasks (account_id, creator_id, platform, content, category, remind_at, linked_bill_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.account_id,
      input.creator_id,
      input.platform,
      input.content,
      input.category ?? '',
      normalizeRemindAt(input.remind_at),
      input.linked_bill_id ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** 取一条未删除任务；不存在返回 undefined。 */
export function getTask(db: Database.Database, id: number): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND is_deleted = 0').get(id) as TaskRow | undefined;
}

/** 任务列表/导出查询参数（宽过滤 + 分页）。 */
export interface TaskListQuery {
  is_done?: boolean;
  category?: string;
  q?: string; // content 关键词，多 token 拆词 AND（转义 LIKE）
  from?: string; // created_at 起始 YYYY-MM-DD
  to?: string; // created_at 结束 YYYY-MM-DD
  page?: number;
  page_size?: number;
}

/**
 * 共享任务过滤条件构建器（listTasks / exportTasks 共用）。
 * 返回 WHERE 片段 conds 与参数 args，二者按顺序配对（conds.join(' AND ') + ...args）。
 * is_deleted 打底 + is_done/category 等值 + q 关键词（多 token 拆词 AND，转义 LIKE）+ from/to（created_at 区间）。
 */
export function buildTaskFilter(q: TaskListQuery): { conds: string[]; args: unknown[] } {
  const conds: string[] = ['is_deleted = 0'];
  const args: unknown[] = [];

  if (q.is_done !== undefined) {
    conds.push('is_done = ?');
    args.push(q.is_done ? 1 : 0);
  }
  if (q.category !== undefined && q.category !== '') {
    conds.push('category = ?');
    args.push(q.category);
  }
  if (q.q !== undefined && q.q.trim() !== '') {
    // 多 token 拆词 AND：两词都必须命中（任意位置子串）；转义 \ % _ 防通配符注入
    for (const token of q.q.trim().split(/\s+/)) {
      conds.push(`content LIKE '%' || ? || '%' ESCAPE '\\'`);
      args.push(token.replace(/[\\%_]/g, (ch) => `\\${ch}`));
    }
  }
  if (q.from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from)) throw new AppError(400, 'INVALID_FROM', 'from 需为 YYYY-MM-DD');
    conds.push('created_at >= ?');
    args.push(`${q.from} 00:00:00`);
  }
  if (q.to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.to)) throw new AppError(400, 'INVALID_TO', 'to 需为 YYYY-MM-DD');
    conds.push('created_at <= ?');
    args.push(`${q.to} 23:59:59`);
  }

  return { conds, args };
}

/**
 * 列表查询（账户内）：默认未完成（is_done 缺省 false，applied 回显），支持关键词/分类/日期区间 + 分页。
 * 返回 { items, total, page, page_size, applied }，applied 回显实际生效的筛选供 LLM 自验证。
 */
export function listTasks(
  db: Database.Database,
  accountId: number,
  q: TaskListQuery = {},
): {
  items: TaskRow[];
  total: number;
  page: number;
  page_size: number;
  applied: Record<string, string | number | boolean>;
} {
  const { conds, args } = buildTaskFilter(q);
  const condsWithAccount = ['account_id = ?', ...conds];
  const argsWithAccount = [accountId, ...args];
  const where = condsWithAccount.join(' AND ');

  const total = (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE ${where}`).get(...argsWithAccount) as { n: number }).n;

  const page = Number.isInteger(q.page) && (q.page as number) > 0 ? (q.page as number) : 1;
  const pageSize = Number.isInteger(q.page_size) && (q.page_size as number) > 0 ? Math.min(q.page_size as number, 200) : 50;
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY is_done ASC, created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...argsWithAccount, pageSize, (page - 1) * pageSize) as TaskRow[];

  // 回显实际生效的筛选（缺省 is_done=false 也回显，让 LLM 知道只看到了未完成）
  const effIsDone = q.is_done === undefined ? false : q.is_done;
  const applied: Record<string, string | number | boolean> = { account_id: accountId, is_done: effIsDone };
  if (q.category) applied.category = q.category;
  if (q.q?.trim()) applied.q = q.q.trim();
  if (q.from) applied.from = q.from;
  if (q.to) applied.to = q.to;

  return { items: rows, total, page, page_size: pageSize, applied };
}

/**
 * 全量导出（无分页上限）：账户内全部未删除任务，支持宽过滤（复用 buildTaskFilter）。
 * is_done 缺省 = 全部（仅显式传才回显）。按创建时间升序。
 */
export function exportTasks(db: Database.Database, accountId: number, q: TaskListQuery = {}): TaskRow[] {
  const { conds, args } = buildTaskFilter(q);
  const condsWithAccount = ['account_id = ?', ...conds];
  const argsWithAccount = [accountId, ...args];
  return db
    .prepare(`SELECT * FROM tasks WHERE ${condsWithAccount.join(' AND ')} ORDER BY created_at, id`)
    .all(...argsWithAccount) as TaskRow[];
}

/** CSV 构建（列：状态/内容/分类/创建时间/完成时间/提醒时间/关联账单）。复用 bills 的 csvCell 防公式注入。 */
export function buildTaskCsv(tasks: TaskRow[]): string {
  const header = ['状态', '内容', '分类', '创建时间', '完成时间', '提醒时间', '关联账单'];
  const rows = tasks.map((t) => [
    t.is_done ? '已完成' : '未完成',
    t.content,
    t.category,
    t.created_at,
    t.done_at ?? '',
    t.remind_at ?? '',
    t.linked_bill_id === null ? '' : String(t.linked_bill_id),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export interface UpdateTaskPatch {
  content?: string;
  category?: string;
  remind_at?: unknown; // null 清除提醒
  linked_bill_id?: number | null;
}

/** 改任务（内容/分类/提醒时间/关联账单）。改 remind_at 时重置 reminded，让提醒可重新触发。 */
export function updateTask(db: Database.Database, id: number, patch: UpdateTaskPatch): TaskRow | undefined {
  const task = getTask(db, id);
  if (!task) return undefined;

  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.content !== undefined) {
    if (typeof patch.content !== 'string' || patch.content.trim() === '') {
      throw new AppError(400, 'INVALID_BODY', 'content 不能为空');
    }
    sets.push('content = ?');
    args.push(patch.content.trim());
  }
  if (patch.category !== undefined) {
    sets.push('category = ?');
    args.push(String(patch.category));
  }
  if (patch.remind_at !== undefined) {
    const remind = normalizeRemindAt(patch.remind_at);
    sets.push('remind_at = ?', 'reminded = 0'); // 改提醒时间 → 允许重新提醒
    args.push(remind);
  }
  if (patch.linked_bill_id !== undefined) {
    if (patch.linked_bill_id !== null && !getActiveBill(db, patch.linked_bill_id)) {
      throw new AppError(404, 'BILL_NOT_FOUND', '关联的账单不存在或已删除');
    }
    sets.push('linked_bill_id = ?');
    args.push(patch.linked_bill_id);
  }
  if (sets.length === 0) return task;

  args.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getTask(db, id);
}

/** 标记完成 / 取消完成（is_done + done_at）。 */
export function setTaskDone(db: Database.Database, id: number, done: boolean): TaskRow | undefined {
  const task = getTask(db, id);
  if (!task) return undefined;
  db.prepare('UPDATE tasks SET is_done = ?, done_at = ? WHERE id = ?').run(done ? 1 : 0, done ? now() : null, id);
  return getTask(db, id);
}

/** 软删除任务。 */
export function softDeleteTask(db: Database.Database, id: number): TaskRow | undefined {
  const task = getTask(db, id);
  if (!task) return undefined;
  db.prepare('UPDATE tasks SET is_deleted = 1, deleted_at = ? WHERE id = ?').run(now(), id);
  return task;
}
