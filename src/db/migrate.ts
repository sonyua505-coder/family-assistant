/**
 * 迁移 CLI：npm run migrate
 * 打开配置的库 → 执行未应用的迁移 → 打印已应用版本。
 */
import 'dotenv/config';
import { loadConfig } from '../config.js';
import { openDb } from './index.js';
import { applyMigrations } from './migrations.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const records = applyMigrations(db);
console.log(`数据库: ${config.dbPath}`);
console.log(`已应用迁移 ${records.length} 个:`);
for (const r of records) console.log(`  v${r.version} ${r.name}  (${r.applied_at})`);
db.close();
