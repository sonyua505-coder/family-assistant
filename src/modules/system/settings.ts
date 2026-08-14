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

export function getAllSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
