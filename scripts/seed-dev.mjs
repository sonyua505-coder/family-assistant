/**
 * 本地开发数据播种 + 铸造 Web Token 脚本。
 *
 * 作用：
 *   1) 确保 dev.db 有 schema（applyMigrations）
 *   2) 灌入一套可演示「日常 / 工作 / 代办」三段式总览的测试数据：
 *        - 1 个 person（小明）+ 1 个身份（qq/openid-xiaoming）
 *        - 2 个账本（个人账本 + 家庭账本）
 *        - 日常账单（含本月收入/支出、待结算 AA、历史月份）
 *        - 工作账单（委托方 + 明细 + 结算，含欠款）
 *        - 代办（已完成 / 未完成）
 *   3) 直接铸一个 24h 的 write Token 进库，并打印可打开的 Web URL
 *
 * 用法：
 *   node scripts/seed-dev.mjs            # 首次播种（dev.db 为空时直接跑）
 *   node scripts/seed-dev.mjs --reset    # 清空旧数据后重新播种
 *
 * 注意：
 *   - 不依赖服务是否启动，直接操作 dev.db；跑完再 `npm run dev` 打开下方 URL 即可。
 *   - 需要先 `npm run build`（dist/ 必须存在，本脚本复用其中的迁移与 mintToken）。
 *   - 本地 Web 端口跟随 API_PORT（默认 3000），非 WEB_PORT(8081)。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(root, 'data/dev.db');
const PORT = process.env.API_PORT || process.env.WEB_PORT || 3000;
const RESET = process.argv.includes('--reset');

// ── 复用构建产物：迁移 runner + 真实 mintToken（保证 token 格式/过期正确） ──
const distMigrations = path.join(root, 'dist/db/migrations.js');
const distTokens = path.join(root, 'dist/modules/bills_web/tokens.js');
if (!fs.existsSync(distMigrations) || !fs.existsSync(distTokens)) {
  console.error('❌ dist/ 缺失，请先运行：npm run build');
  process.exit(1);
}
const { applyMigrations } = await import(pathToFileURL(distMigrations).href);
const { mintToken } = await import(pathToFileURL(distTokens).href);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
applyMigrations(db);

// ── 安全闸门：已有 person 时拒绝覆盖，除非 --reset ──
const personCount = db.prepare('SELECT COUNT(*) n FROM persons').get().n;
if (personCount > 0 && !RESET) {
  console.error(
    `⚠️  dev.db 已有 ${personCount} 个 person，拒绝覆盖。\n` +
      `    如需重新播种请加参数：\n      node scripts/seed-dev.mjs --reset`,
  );
  process.exit(1);
}
if (RESET) {
  db.pragma('foreign_keys = OFF');
  for (const t of [
    'web_tokens', 'operation_logs',
    'work_settlements', 'work_bill_items', 'work_bills', 'work_clients', 'work_unit_prices',
    'tasks', 'bills', 'person_identities', 'accounts', 'persons',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.pragma('foreign_keys = ON');
  console.log('🧹 已清空旧数据（--reset）');
}

// ── 日期助手：让"本月"统计永远有数据 ──
const pad = (n) => String(n).padStart(2, '0');
function ymOffset(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return { y: d.getFullYear(), m: pad(d.getMonth() + 1) };
}
const cur = ymOffset(0);
const prev = ymOffset(-1);
const curDay = (day) => `${cur.y}-${cur.m}-${pad(day)}`;
const prevDay = (day) => `${prev.y}-${prev.m}-${pad(day)}`;

// ── 1. person + 身份 ──
const xiaoming = Number(
  db.prepare('INSERT INTO persons (display_name) VALUES (?)').run('小明').lastInsertRowid,
);
db.prepare(
  'INSERT INTO person_identities (platform, openid, person_id, is_primary) VALUES (?, ?, ?, 1)',
).run('qq', 'openid-xiaoming', xiaoming);

// ── 2. 账本 ──
const acc1 = Number(
  db.prepare("INSERT INTO accounts (type, name, owner_person_id) VALUES ('personal', ?, ?)")
    .run('小明的账本', xiaoming).lastInsertRowid,
);
const acc2 = Number(
  db.prepare("INSERT INTO accounts (type, name, owner_person_id) VALUES ('family', ?, ?)")
    .run('我家', xiaoming).lastInsertRowid,
);
// family 账本需在 account_members 登记 owner 才可见（listAccountsForPerson 对 family 走成员表授权）
db.prepare("INSERT INTO account_members (account_id, person_id, role) VALUES (?, ?, 'owner')").run(acc2, xiaoming);

// ── 3. 日常账单（bills，金额单位：分） ──
const insBill = db.prepare(
  `INSERT INTO bills (account_id, person_id, type, amount, category, note, occurred_at, status, participants)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
// 小明账本：本月收入/支出 + 一笔待结算 AA + 历史月份
insBill.run(acc1, xiaoming, 'income', 800000, '工资', '本月工资', `${curDay(5)} 09:00:00`, 'settled', '[]');
insBill.run(acc1, xiaoming, 'expense', 4500, '餐饮', '午饭', `${curDay(8)} 12:30:00`, 'settled', '[]');
insBill.run(acc1, xiaoming, 'expense', 2000, '交通', '打车', `${curDay(10)} 19:10:00`, 'settled', '[]');
insBill.run(
  acc1, xiaoming, 'expense', 12900, '购物', 'AA 聚餐', `${curDay(12)} 20:00:00`, 'pending',
  '[{"name":"小李","status":"pending","paid_at":null}]',
);
insBill.run(acc1, xiaoming, 'expense', 3800, '餐饮', '外卖', `${curDay(15)} 13:00:00`, 'settled', '[]');
insBill.run(acc1, xiaoming, 'expense', 6000, '餐饮', '上月饭局', `${prevDay(20)} 20:00:00`, 'settled', '[]');
// 我家账本：日常账单
insBill.run(acc2, xiaoming, 'income', 50000, '其他', '兼职', `${curDay(3)} 10:00:00`, 'settled', '[]');
insBill.run(acc2, xiaoming, 'expense', 8800, '餐饮', '家庭聚餐', `${curDay(9)} 18:00:00`, 'settled', '[]');

// ── 4. 工作账单（work_clients / work_bills / work_bill_items / work_settlements，金额：分） ──
const insClient = db.prepare(
  'INSERT INTO work_clients (account_id, name, type, phone, note) VALUES (?, ?, ?, ?, ?)',
);
const insWorkBill = db.prepare(
  `INSERT INTO work_bills (account_id, client_id, contact, address, occurred_at, note, final_amount)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const insItem = db.prepare(
  `INSERT INTO work_bill_items (bill_id, name, qty, unit, unit_price, amount, note, sort)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insSettle = db.prepare(
  'INSERT INTO work_settlements (bill_id, amount, settled_at, note) VALUES (?, ?, ?, ?)',
);

// 小明账本 · 委托方 A 装修公司：两笔明细合计 700 元，已收 300，欠 400
const cA = Number(insClient.run(acc1, 'A装修公司', 'company', '13800000000', '主合作').lastInsertRowid);
const bA = Number(
  insWorkBill.run(acc1, cA, '张经理', '阳光小区3栋', `${curDay(10)}`, '全屋门套', null).lastInsertRowid,
);
insItem.run(bA, '安装门', 2, '个', 15000, 30000, '卧室+大门', 0); // 300 元
insItem.run(bA, '窗套', 5, '个', 8000, 40000, '客厅', 1); // 400 元
insSettle.run(bA, 30000, `${curDay(11)}`, '首付款'); // 已收 300 元

// 小明账本 · 委托方 个人委托：1 笔明细 200 元，部分结算 100，欠 100
const cB = Number(insClient.run(acc1, '王师傅(个人)', 'personal', '', '熟人介绍').lastInsertRowid);
const bB = Number(
  insWorkBill.run(acc1, cB, '王师傅', '幸福里2单元', `${curDay(16)}`, '拆旧+安装', null).lastInsertRowid,
);
insItem.run(bB, '拆旧', 1, '项', 20000, 20000, '旧门窗拆除', 0); // 200 元
insSettle.run(bB, 10000, `${curDay(16)}`, '定金'); // 已收 100 元

// 我家账本 · 一笔工作账单，未结算
const cC = Number(insClient.run(acc2, 'B装修公司', 'company', '', '').lastInsertRowid);
const bC = Number(
  insWorkBill.run(acc2, cC, '李工', '我家新房', `${curDay(7)}`, '柜体安装', null).lastInsertRowid,
);
insItem.run(bC, '衣柜', 3, '个', 12000, 36000, '', 0); // 360 元

// ── 5. 代办（tasks） ──
const insTask = db.prepare(
  `INSERT INTO tasks (account_id, creator_id, platform, content, category, is_done)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
insTask.run(acc1, xiaoming, 'qq', '给物业交电费', '生活', 0);
insTask.run(acc1, xiaoming, 'qq', '预约体检', '健康', 0);
insTask.run(acc1, xiaoming, 'qq', '取快递', '生活', 1); // 已完成
insTask.run(acc2, xiaoming, 'qq', '制定家庭旅行计划', '出行', 0);

// ── 6. 铸 token ──
const { token } = mintToken(db, xiaoming, 'write', 1440); // 24h

db.close();

console.log('\n✅ 播种完成');
console.log(`   person: 小明 (qq/openid-xiaoming)`);
console.log(`   账本: 小明的账本(#${acc1})、我家(#${acc2})`);
console.log(`   Web Token (write, 24h): ${token}`);
console.log('\n🌐 打开页面：');
console.log(`   http://127.0.0.1:${PORT}/w/${token}`);
console.log('\n💡 curl 身份头（如需调试 API）：');
console.log('   -H "X-API-Key: <你的 X_API_KEY>" -H "x-platform: qq" -H "x-openid: openid-xiaoming"');
