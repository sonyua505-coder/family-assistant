/**
 * 家庭共享任务数据访问层（M4，对应设计文档 §4.6 / §5.2 / ADR D25）。
 * 归属账户：family 账户下共享（一人记录全家可查），personal 账户下即个人待办。
 * 可关联待结算账单（linked_bill_id）；可选 remind_at 到点由 reminder_due 写 outbox。
 */
import type Database from 'better-sqlite3';
import { now } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import { getActiveBill } from '../bills/bills.js';

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

/** 列表查询（账户内）：默认未完成，可按 is_done / category 过滤。 */
export function listTasks(
  db: Database.Database,
  accountId: number,
  q: { is_done?: boolean; category?: string } = {},
): TaskRow[] {
  const conds = ['account_id = ?', 'is_deleted = 0'];
  const args: unknown[] = [accountId];
  if (q.is_done !== undefined) {
    conds.push('is_done = ?');
    args.push(q.is_done ? 1 : 0);
  }
  if (q.category !== undefined) {
    conds.push('category = ?');
    args.push(q.category);
  }
  return db
    .prepare(`SELECT * FROM tasks WHERE ${conds.join(' AND ')} ORDER BY is_done ASC, created_at DESC, id DESC`)
    .all(...args) as TaskRow[];
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
