/**
 * 方向 A 新端点本地验证脚本（dev.db 造数据 + curl 断言）。
 * 用 better-sqlite3 直接插入测试数据，再启动服务用 fetch 验证：
 *   - GET /api/v1/bills/export?format=json（宽过滤 + applied 回显 + 金额区间）
 *   - GET /api/v1/bills/export?format=csv（CSV BOM/防注入）
 *   - GET /api/v1/bills/stats/range（合计尊重区间）
 *   - 越权：他人身份访问他人 account → 403
 * 用法：node scripts/verify-direction-a.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve('data/dev.db');
const PORT = 3999;
const API_KEY = 'verify-key-123';
const ADMIN_KEY = 'verify-admin-123';

// ── 0. 用临时环境准备干净库 ──
process.env.DB_PATH = DB_PATH;
process.env.X_API_KEY = API_KEY;
process.env.ADMIN_KEY = ADMIN_KEY;
process.env.SCHEDULER_ENABLED = 'false';
process.env.API_PORT = String(PORT);
process.env.LOG_LEVEL = 'silent';

const { default: Database } = await import('better-sqlite3');
if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 迁移：直接用后端 runner（dist/db/migrations.js）
const { applyMigrations } = await import('../dist/db/migrations.js');
applyMigrations(db);

// ── 1. 造数据：2 person + 2 account + 跨年跨金额账单 ──
const insert = db.prepare(`INSERT INTO bills (account_id, person_id, type, amount, category, note, occurred_at, status, participants) VALUES (?,?,?,?,?,?,?,?,?)`);
const mkPerson = db.prepare(`INSERT INTO persons (display_name) VALUES (?)`);
const mkAccount = db.prepare(`INSERT INTO accounts (type, name, owner_person_id) VALUES ('personal', ?, ?)`);
const mkIdentity = db.prepare(`INSERT INTO person_identities (platform, openid, person_id, is_primary) VALUES ('qq', ?, ?, 1)`);

const p1 = Number(mkPerson.run('小明').lastInsertRowid);
const p2 = Number(mkPerson.run('小红').lastInsertRowid);
mkIdentity.run('openid-xiaoming', p1);
mkIdentity.run('openid-xiaohong', p2);
const acc1 = Number(mkAccount.run('小明的账本', p1).lastInsertRowid);
const acc2 = Number(mkAccount.run('小红的账本', p2).lastInsertRowid);

// 小明账本：2025-12 一笔支出 5000 分；2026-03 收入 30000；2026-04 支出 1200（AA）
insert.run(acc1, p1, 'expense', 5000, '餐饮', '跨年饭', '2025-12-31 20:00:00', 'settled', '[]');
insert.run(acc1, p1, 'income', 30000, '其他', '工资', '2026-03-10 09:00:00', 'settled', '[]');
insert.run(acc1, p1, 'expense', 1200, '交通', 'AA打车', '2026-04-05 10:00:00', 'pending', '[{"name":"李四","status":"pending","paid_at":null}]');
insert.run(acc1, p1, 'expense', 8800, '购物', '=SUM()注入', '2026-04-20 15:00:00', 'settled', '[]');
// 小红账本：一笔 2026-01 支出 999
insert.run(acc2, p2, 'expense', 999, '餐饮', '小红的账', '2026-01-15 12:00:00', 'settled', '[]');
db.close();

// ── 2. 启动服务 ──
const child = spawn(process.execPath, ['dist/index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => (logs += d));
child.stderr.on('data', (d) => (logs += d));

const api = `http://127.0.0.1:${PORT}`;
const H = (openid) => ({
  Authorization: `Bearer ${API_KEY}`,
  'x-platform': 'qq',
  'x-openid': openid,
});

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${api}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务未就绪:\n${logs}`);
}

async function get(path, openid) {
  const r = await fetch(`${api}${path}`, { headers: H(openid) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, buf, headers: r.headers };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

// ── 3. 断言 ──
try {
  await waitReady();

  // 3.1 export json：宽过滤 + applied 回显 + 金额区间
  const e1 = await get('/api/v1/bills/export?year=2026&amount_min=1000&format=json', 'openid-xiaoming');
  assert(e1.status === 200, 'export json 返回 200');
  assert(e1.json && e1.json.total === 3, `export json year=2026 amount_min=1000 → total=3（30000/1200/8800 均 ≥1000，实得 ${e1.json?.total}）`);
  assert(e1.json && e1.json.applied && e1.json.applied.year === '2026', 'applied.year 回显');
  assert(e1.json && e1.json.applied.amount_min === 1000, 'applied.amount_min 回显');
  const amounts = e1.json.items.map((b) => b.amount);
  assert(amounts.every((a) => a >= 1000), '金额下界过滤生效');
  assert(e1.json.items.every((b) => b.occurred_at.startsWith('2026')), 'year 过滤生效');

  // 3.2 export json：金额区间上界 + category
  const e2 = await get('/api/v1/bills/export?year=2026&amount_max=2000&format=json', 'openid-xiaoming');
  assert(e2.json && e2.json.total === 1, `export json amount_max=2000 → total=1（实得 ${e2.json?.total}）`);

  // 3.3 export csv：BOM + 防注入
  const e3 = await get('/api/v1/bills/export?format=csv', 'openid-xiaoming');
  assert(e3.status === 200, 'export csv 返回 200');
  assert(e3.headers.get('content-type')?.includes('text/csv'), 'csv content-type');
  assert(e3.buf.length >= 3 && e3.buf[0] === 0xef && e3.buf[1] === 0xbb && e3.buf[2] === 0xbf, 'csv 含 UTF-8 BOM（EF BB BF）');
  assert(e3.text.includes("'=SUM()注入"), 'csv 防公式注入（= 前缀清洗）');

  // 3.4 stats/range：合计尊重 year 区间（对比旧 stats 全量）
  const s1 = await get('/api/v1/bills/stats/range?year=2026', 'openid-xiaoming');
  assert(s1.status === 200, 'stats/range 返回 200');
  assert(s1.json && s1.json.expense === 10000, `range 2026 expense=10000（8800+1200，实得 ${s1.json?.expense}）`);
  assert(s1.json && s1.json.income === 30000, `range 2026 income=30000（实得 ${s1.json?.income}）`);
  assert(s1.json && s1.json.net === 20000, `range 2026 net=20000（实得 ${s1.json?.net}）`);
  assert(s1.json && s1.json.applied && s1.json.applied.from === '2026-01-01' && s1.json.applied.to === '2026-12-31', 'applied 回显年份区间');
  const catTraffic = (s1.json?.by_category || []).find((c) => c.category === '交通');
  assert(catTraffic && catTraffic.amount === 1200, 'by_category 尊重区间（交通 1200）');
  assert(!s1.json.by_category.some((c) => c.category === '餐饮'), '2025 餐饮不入 by_category');

  // 3.5 stats/range：from/to 显式 + amount 过滤（4 月两笔 1200/8800，amount_max=5000 只留 1200）
  const s2 = await get('/api/v1/bills/stats/range?from=2026-04-01&to=2026-04-30&amount_max=5000', 'openid-xiaoming');
  assert(s2.json && s2.json.expense === 1200, `range 4月 amount_max=5000 → expense=1200（8800 被金额过滤排除，实得 ${s2.json?.expense}）`);

  // 3.6 stats/range：单月 trend
  const s3 = await get('/api/v1/bills/stats/range?year=2026&month=4', 'openid-xiaoming');
  assert(s3.json && s3.json.trend.length === 1 && s3.json.trend[0].month === '2026-04', 'trend 单月正确');
  assert(s3.json && s3.json.applied.from === '2026-04-01' && s3.json.applied.to === '2026-04-30', 'applied 单月区间');

  // 3.7 越权：小明访问小红账本 → 403
  const e4 = await get(`/api/v1/bills/export?account_id=${acc2}`, 'openid-xiaoming');
  assert(e4.status === 403, `越权访问他人账本 → 403（实得 ${e4.status}）`);

  // 3.8 回归：旧接口行为不变
  const old = await get('/api/v1/bills/stats', 'openid-xiaoming');
  assert(old.status === 200, '旧 stats 接口仍可用');
  assert(old.json && old.json.income === 30000 && old.json.expense === 15000, `旧 stats 合计仍为全量（income=30000 expense=15000，实得 ${old.json?.income}/${old.json?.expense}）`);
  const oldList = await get('/api/v1/bills?month=2026-04', 'openid-xiaoming');
  assert(oldList.json && oldList.json.total === 2, `旧 list 接口仍可用（2026-04 total=2，实得 ${oldList.json?.total}）`);

  // 3.9 非法金额参数 → 400 错误码
  const bad = await get('/api/v1/bills/export?amount_min=abc', 'openid-xiaoming');
  assert(bad.status === 400 && bad.json && bad.json.code === 'INVALID_AMOUNT_MIN', `amount_min 非法 → 400 INVALID_AMOUNT_MIN（实得 ${bad.status} ${bad.json?.code}）`);

  const bad2 = await get('/api/v1/bills/stats/range?from=2026-05&to=2026-04', 'openid-xiaoming');
  assert(bad2.status === 400 && bad2.json && (bad2.json.code === 'INVALID_FROM' || bad2.json.code === 'INVALID_RANGE'), `from 非法 → 400（实得 ${bad2.status} ${bad2.json?.code}）`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

console.log(process.exitCode ? '\n存在失败项' : '\n全部通过 🎉');
