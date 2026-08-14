/**
 * 迁移 runner：按 src/db/migrations/*.sql 文件名的版本号（前缀数字）顺序执行，
 * 已执行版本记录进 schema_migrations，启动时自动补齐未执行的。
 *
 * 注意：schema_migrations 表由 runner 自行创建，不放在任何 *.sql 里。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

const MIGRATIONS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

export function applyMigrations(db: Database.Database, dir: string = MIGRATIONS_DIR): MigrationRecord[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);

  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );

  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));

  const run = db.transaction(() => {
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if (appliedVersions.has(version)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, file);
    }
  });
  run();

  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all() as MigrationRecord[];
}
