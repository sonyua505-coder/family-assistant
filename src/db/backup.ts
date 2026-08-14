/**
 * 每日冷备脚本（ADR D22）：npm run backup
 * better-sqlite3 在线备份（db.backup()）→ 一致快照，即使服务器正在跑也安全。
 * 备份到 BACKUP_DIR（默认 ./backup/），文件名 app-YYYY-MM-DD.db，保留最近 7 份。
 * 服务器上由 cron 每日调用；本机（Windows）可经 ZeroTier 定时拉取做异地副本。
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { openDb } from './index.js';

const KEEP = 7;

async function main(): Promise<void> {
  const config = loadConfig();
  const backupDir = resolve(config.backupDir);
  mkdirSync(backupDir, { recursive: true });

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const dest = join(backupDir, `app-${date}.db`);

  // 同一天重跑则覆盖旧文件（db.backup() 目标已存在会报错，先删）
  if (existsSync(dest)) unlinkSync(dest);

  const db = openDb(config.dbPath);
  await db.backup(dest);
  db.close();
  console.log(`备份完成: ${dest}`);

  // 清理：只保留最近 KEEP 份
  const files = readdirSync(backupDir)
    .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  while (files.length > KEEP) {
    const oldest = files.shift()!;
    unlinkSync(join(backupDir, oldest));
    console.log(`清理旧备份: ${oldest}`);
  }
}

main().catch((err) => {
  console.error('备份失败:', err);
  process.exit(1);
});
