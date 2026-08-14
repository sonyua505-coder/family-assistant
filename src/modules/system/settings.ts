/**
 * settings 键值配置（对应设计文档 §4.11）。
 * 预留键：daily_brief_enabled/daily_brief_time、bill_digest_enabled/bill_digest_time、
 *         news_retention_days（§6 调度任务读取）。
 */
import type Database from 'better-sqlite3';

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** 读配置，未设置时返回 fallback（调度任务用的默认值都走这里，避免建库时 seed）。 */
export function getSettingDefault(db: Database.Database, key: string, fallback: string): string {
  return getSetting(db, key) ?? fallback;
}

/** 读布尔配置（'true'/'1' 视为 true），未设置用 fallback。 */
export function getSettingBool(db: Database.Database, key: string, fallback: boolean): boolean {
  const v = getSetting(db, key);
  if (v === null) return fallback;
  return v === 'true' || v === '1';
}

export function getAllSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
