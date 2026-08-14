/**
 * DAO 基座：通用辅助函数。
 * 各模块 DAO 在 registry 通用 CRUD 之上叠加特化逻辑（如 bills 统计、AA 结算）。
 */
import type Database from 'better-sqlite3';

/** 与 SQLite datetime('now','localtime') 一致的本地时间串 "YYYY-MM-DD HH:MM:SS"。 */
export function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function jsonStringify(v: unknown): string {
  return JSON.stringify(v);
}

export interface OpLogInput {
  accountId?: number | null;
  personId?: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  before?: unknown;
  after?: unknown;
}

/** 写操作日志（operation_logs，M2 起由各模块写操作调用）。 */
export function logOperation(db: Database.Database, input: OpLogInput): void {
  db.prepare(
    `INSERT INTO operation_logs (account_id, person_id, action, entity, entity_id, before_data, after_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.accountId ?? null,
    input.personId ?? null,
    input.action,
    input.entity,
    input.entityId ?? null,
    input.before !== undefined ? jsonStringify(input.before) : null,
    input.after !== undefined ? jsonStringify(input.after) : null,
  );
}
