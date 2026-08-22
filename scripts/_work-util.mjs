/**
 * 工作记账测试数据脚本的公共工具（供 work-clean.mjs / work-import.mjs 复用）。
 * 不依赖 dist 构建，直接用 better-sqlite3 操作 dev.db。
 */

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 打开数据库（同 src/db/index.ts 的约定：WAL / 外键 / busy_timeout）。 */
export function openDb(dbPath) {
  const abs = resolve(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * 解析"用户/账本"参数：
 *  - account 传了：数字=id，字符串=名称精确匹配（同名多个报错）
 *  - 只传 person：数字=persons.id，字符串=display_name 匹配；取其唯一可用账本
 *    （personal=owner，family=成员，逻辑同 src/modules/system/accounts.ts）
 * 返回 { accountId, accountName, personId }
 */
export function resolveAccount(db, { person, account }) {
  let accountId = null;
  let accountRow = null;

  if (account !== undefined && account !== '') {
    const isNum = /^\d+$/.test(String(account));
    if (isNum) {
      accountRow = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(account));
    } else {
      const rows = db.prepare('SELECT * FROM accounts WHERE name = ?').all(String(account));
      if (rows.length === 0) throw new Error(`找不到账本: ${account}`);
      if (rows.length > 1) throw new Error(`账本名称「${account}」有多个，请用 --account <id>`);
      accountRow = rows[0];
    }
    if (!accountRow) throw new Error(`找不到账本 id: ${account}`);
    accountId = accountRow.id;
  } else {
    // 按 person 解析唯一可用账本
    if (person === undefined || person === '') throw new Error('请提供 --account <id|名称> 或 --person <id|名称>');
    let personId;
    if (/^\d+$/.test(String(person))) {
      const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(Number(person));
      if (!p) throw new Error(`找不到 person id: ${person}`);
      personId = p.id;
    } else {
      const p = db.prepare('SELECT * FROM persons WHERE display_name = ? OR nickname = ?').get(String(person), String(person));
      if (!p) throw new Error(`找不到 person: ${person}`);
      personId = p.id;
    }
    const accounts = db
      .prepare(
        `SELECT a.* FROM accounts a WHERE a.owner_person_id = ? AND a.type = 'personal'
         UNION ALL
         SELECT a.* FROM accounts a JOIN account_members m ON m.account_id = a.id
           WHERE m.person_id = ? AND a.type = 'family'
         ORDER BY id`,
      )
      .all(personId, personId);
    if (accounts.length === 0) throw new Error(`person id=${personId} 没有任何可用账本`);
    if (accounts.length > 1)
      throw new Error(`person id=${personId} 有 ${accounts.length} 个账本，请用 --account <id> 指定: ${accounts.map((a) => `#${a.id} ${a.name}`).join('、')}`);
    accountRow = accounts[0];
    accountId = accountRow.id;
  }

  return { accountId: Number(accountId), accountName: accountRow.name, accountType: accountRow.type };
}

/** 清空指定账本的工作记账数据（结算→明细→账单→单价表→委托方），返回各表删除条数。 */
export function cleanAccountWork(db, accountId) {
  const run = db.transaction(() => {
    // 子表按父账单删除
    const bills = db.prepare('SELECT id FROM work_bills WHERE account_id = ?').all(accountId);
    const ids = bills.map((b) => b.id);
    let items = 0;
    let settlements = 0;
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      items = db.prepare(`DELETE FROM work_bill_items WHERE bill_id IN (${ph})`).run(...ids).changes;
      settlements = db.prepare(`DELETE FROM work_settlements WHERE bill_id IN (${ph})`).run(...ids).changes;
    }
    const billsDel = db.prepare('DELETE FROM work_bills WHERE account_id = ?').run(accountId).changes;
    const prices = db.prepare('DELETE FROM work_unit_prices WHERE account_id = ?').run(accountId).changes;
    const clients = db.prepare('DELETE FROM work_clients WHERE account_id = ?').run(accountId).changes;
    return { clients, prices, bills: billsDel, items, settlements };
  });
  return run();
}

// ──────────────────────────────────────────────
// 单价规则（与「G:/工作记账测试数据.txt」各委托方的单价表一致，顺序即优先级）
// 每个委托方一段；m: 'eq'=精确匹配 / 'inc'=包含 / 'inc2'=同时包含；manual=true 表示手填不进单价表
// ──────────────────────────────────────────────

export const PRICE_RULES = {
  '欧派': [
    { m: 'inc', name: '推拉门', price: 220 }, // 只要是推拉门均 220，每类独立单价
    { m: 'eq', name: '隐形门加墙板', price: 300 }, // 隐形门 200 + 墙板 100，一般总是带墙板
    { m: 'eq', name: '卫生间双包门', price: 100 },
    { m: 'eq', name: '卫生间单包门', price: 50 },
    { m: 'eq', name: '梦天木门', price: 120 },
    { m: 'eq', name: '欧派木门', price: 100 },
    { m: 'eq', name: '进户门套', price: 50 },
    { m: 'inc2', a: '客厅阳台', b: '哑口', price: 100 }, // 客厅阳台哑口/大哑口
    { m: 'inc', name: '哑口', price: 80 }, // 其余哑口均为 80
    { m: 'eq', name: '防盗门', price: 150 },
    { m: 'eq', name: '子母装甲门', price: 150 },
    { m: 'eq', name: '拆装旧防盗门改墙', price: 100, manual: true }, // 特定项目，手动录入
  ],
  '王卫华': [
    { m: 'eq', name: '木门', price: 105 },
    { m: 'eq', name: '入户门套', price: 60 },
  ],
  '顶上装饰 小廖': [
    { m: 'eq', name: '带挂板木门', price: 140 },
    { m: 'eq', name: '木门', price: 110 },
  ],
  '陈继': [
    { m: 'eq', name: '木门', price: 110 },
    { m: 'eq', name: '铝门', price: 100 },
  ],
};

/** 取某委托方的规则表（未知委托方直接抛错，提示可用的）。 */
export function rulesForClient(clientName) {
  const rules = PRICE_RULES[clientName];
  if (!rules) {
    throw new Error(
      `未知委托方「${clientName}」，请先在 scripts/_work-util.mjs 的 PRICE_RULES 中补充单价规则。已知: ${Object.keys(PRICE_RULES).join('、')}`,
    );
  }
  return rules;
}

/** 按规则表匹配品名：返回 { price(元), inPriceTable }；inPriceTable=false 表示手填不进单价表；null=未知。 */
export function priceRuleFor(rules, name) {
  for (const r of rules) {
    let hit = false;
    if (r.m === 'eq') hit = name === r.name;
    else if (r.m === 'inc') hit = name.includes(r.name);
    else if (r.m === 'inc2') hit = name.includes(r.a) && name.includes(r.b);
    if (hit) return { price: r.price, inPriceTable: !r.manual };
  }
  return null;
}

/** 明细单位：门/套/墙板类给可读单位，其余"个"。 */
export function unitFor(name) {
  if (name.includes('木门') || name.includes('隐形门') || name.includes('推拉门') || name.includes('防盗门') || name.includes('装甲门') || name.includes('铝门')) return '扇';
  if (name.includes('门套')) return '套';
  if (name.includes('墙板')) return '块';
  return '个';
}

/**
 * 归一化单个品名（去掉括号备注、隐形门品牌进备注）：
 * 返回 { name, note }。
 * 例：
 *   '梦天木门（备注超高门）'  → { name:'梦天木门', note:'超高门' }
 *   '客厅阳台大哑口(备注拼接）' → { name:'客厅阳台大哑口', note:'拼接' }
 *   '欧铂尼隐形门加外面墙板'  → { name:'隐形门加墙板', note:'欧铂尼' }
 */
export function normalizeItemName(rawName) {
  let name = String(rawName).trim();
  let note = '';
  // 1) 提取括号备注：`（备注xxx）` / `(备注xxx)`（括号半角全角混用也兼容）
  const m = name.match(/[（(]备注([^）)]+)[）)]/);
  if (m) {
    note = m[1].trim();
    name = name.replace(/[（(]备注[^）)]+[）)]/, '').trim();
  }
  // 1.5) 别名归一：明细写「双包卫生间」，单价表叫「卫生间双包门」；「大哑口套」与「大哑口」同物；「铝木门」→「铝门」
  if (name === '双包卫生间') name = '卫生间双包门';
  if (name === '单包卫生间') name = '卫生间单包门';
  if (name === '客厅阳台大哑口套') name = '客厅阳台大哑口';
  if (name === '铝木门') name = '铝门';
  // 2) 隐形门品牌 → 备注：`XX隐形门加外面墙板` / `XX隐形门加墙板`
  const im = name.match(/^(.+?)隐形门加(?:外面)?墙板$/);
  if (im) {
    name = '隐形门加墙板';
    const brand = im[1].trim();
    if (brand) note = note ? `${brand} ${note}` : brand;
  }
  return { name, note };
}

/**
 * 归一化一张单的明细数组：
 *  - 提取括号备注、隐形门品牌进备注（normalizeItemName）
 *  - 合并「隐形门 + 外面墙板」两条为一条「隐形门加墙板」（一般总是带墙板）
 * 返回 [{ name, qty, note }]
 */
export function normalizeItems(items) {
  const normalized = items.map((it) => {
    const { name, note } = normalizeItemName(it.name);
    return { name, qty: it.qty, note };
  });

  const out = [];
  let skippedWall = false;
  for (let i = 0; i < normalized.length; i++) {
    const it = normalized[i];
    if (it.name === '外面墙板') {
      // 前面若已有"隐形门"，已被改为"隐形门加墙板"，这里直接丢弃墙板行
      skippedWall = true;
      continue;
    }
    if (it.name === '隐形门') {
      // 后面是否带墙板？
      const hasWall = normalized.some((x, j) => j > i && x.name === '外面墙板') || normalized.some((x) => x.name === '外面墙板');
      if (hasWall) {
        out.push({ ...it, name: '隐形门加墙板' });
        continue;
      }
    }
    out.push(it);
  }
  // 若墙板被合并但没有隐形门（孤立墙板），提示
  if (skippedWall && !out.some((x) => x.name === '隐形门加墙板')) {
    throw new Error(`明细里有「外面墙板」但前面没有「隐形门」，无法合并: ${JSON.stringify(items)}`);
  }
  return out;
}

/** 委托方段头识别：支持多种写法，返回委托方名称（非段头返回 null）。 */
function parseClientHeader(line) {
  // 委托方段头必然含「委托方/委托人」字样（如 `…（委托方 欧派）`、`陈继（委托人）`），
  // 单价表说明行（如 `推拉门 220元（只要是推拉门均为220）`）不含，避免误判
  if (!line.includes('委托')) return null;
  // 只取第一个括号的内容（如 `（委托人）（已结算）` 只认「委托人」）
  const m = line.match(/^(.+?)（(.+?)）/);
  if (!m) return null;
  const before = m[1].trim();
  const inner = m[2].trim();
  // 括号内显式点名：`（委托方 欧派）` / `（委托人：王卫华）`
  const named = inner.match(/委托[方人][:：]?\s*(.+)/);
  if (named) return named[1].trim();
  // 否则用括号前文本（去年份前缀 + "安装" 后缀）：`顶上装饰 小廖（委托人）（已结算）` / `陈继（委托人）`
  const fallback = before.replace(/^\d{4}\s*/, '').replace(/安装$/, '').trim();
  return fallback || null;
}

/**
 * 解析"G:/工作记账测试数据.txt"：支持多个委托方段。
 * 返回 [{ name: 委托方, bills:[{address, contact, items:[{name,qty,note}]}] }]
 */
export function parseDataFile(dataPath) {
  const text = readFileSync(dataPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const clients = [];
  let curClient = null;
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 委托方段头（欧派 / 王卫华 / 顶上装饰 小廖 / 陈继 …）
    const header = parseClientHeader(line);
    if (header) {
      curClient = { name: header, bills: [] };
      clients.push(curClient);
      cur = null;
      continue;
    }
    // 单价表说明段：跳过（规则在 PRICE_RULES 硬编码，按委托方取）
    if (line.includes('单价表')) {
      cur = null;
      continue;
    }
    if (!curClient) continue;
    // 地址行：`编号.地点，联系人`
    const addr = line.match(/^\d+\.(.+)$/);
    if (addr) {
      const rest = addr[1].trim();
      const parts = rest.split('，');
      cur = { address: parts[0].trim(), contact: parts.length > 1 ? parts[1].trim() : '' };
      curClient.bills.push(cur);
      continue;
    }
    // 明细行（跟在地址行后）：品名，数量，品名，数量…
    if (cur) {
      const cells = line.split('，').map((s) => s.trim()).filter(Boolean);
      if (cells.length === 0) continue;
      const items = [];
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const qty = Number(cells[i + 1]);
        if (cells[i] && Number.isFinite(qty) && qty > 0) items.push({ name: cells[i], qty });
      }
      if (items.length === 0) throw new Error(`明细行无法解析: ${line}`);
      cur.items = normalizeItems(items);
    }
  }

  if (clients.length === 0) throw new Error('数据文件里没有解析到任何委托方');
  return clients;
}
