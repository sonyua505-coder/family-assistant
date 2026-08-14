/**
 * better-sqlite3 连接工厂。
 * 约定：WAL 模式、开启外键约束、busy_timeout。数据文件父目录自动创建。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export function openDb(dbPath: string): Database.Database {
  const abs = resolve(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
