/**
 * 导入「G:/工作记账测试数据.txt」到指定账本（可先 --clean 清空）。
 *
 * 数据文件支持多个委托方段（欧派 / 王卫华 / 顶上装饰 小廖 / 陈继 …），
 * 每个委托方的单价规则见 scripts/_work-util.mjs 的 PRICE_RULES（按委托方名匹配）。
 * 手填项（inPriceTable=false，如"拆装旧防盗门改墙"）不进单价表；--extra-price 可补临时手填价。
 *
 * 用法：
 *   node scripts/work-import.mjs --account <id|名称> [--person <id|名称>]
 *       [--data <数据文件>] [--date YYYY-MM-DD] [--clean] [--db <path>] [--dry-run]
 *       [--extra-price "品名:元,品名:元"]
 *
 * 参数：
 *   --account / --person  目标账本（同 work-clean.mjs）
 *   --data      数据文件，默认 G:/工作记账测试数据.txt
 *   --date      账单日期，默认今天
 *   --clean     导入前先清空该账本工作数据
 *   --dry-run   只解析并预览，不写库
 *   --extra-price 临时手填价（不进单价表），如 --extra-price "子母装甲门:150"
 */
import { parseArgs } from 'node:util';
import { openDb, resolveAccount, cleanAccountWork, parseDataFile, rulesForClient, priceRuleFor, unitFor } from './_work-util.mjs';

const DEFAULT_DATA = 'G:/工作记账测试数据.txt';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: './data/dev.db' },
    person: { type: 'string' },
    account: { type: 'string' },
    data: { type: 'string', default: DEFAULT_DATA },
    date: { type: 'string' },
    clean: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'extra-price': { type: 'string' },
  },
});

// 额外价格映射（--extra-price；手填，不进单价表）
const extraPrices = new Map();
if (values['extra-price']) {
  for (const seg of String(values['extra-price']).split(',')) {
    const idx = seg.lastIndexOf(':');
    if (idx <= 0) throw new Error(`--extra-price 格式应为「品名:元,品名:元」，收到: ${seg}`);
    const price = Number(seg.slice(idx + 1));
    if (!Number.isFinite(price) || price <= 0) throw new Error(`--extra-price 价格非法: ${seg}`);
    extraPrices.set(seg.slice(0, idx).trim(), price);
  }
}

// ── 1. 解析数据文件（多委托方）──
const clients = parseDataFile(values.data);
const date = values.date || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date 需为 YYYY-MM-DD，收到: ${date}`);

// ── 2. 逐委托方定价校验（收集未知品名一次性报出）──
const unknowns = new Map(); // 品名 -> [委托方]
let itemCount = 0;
let totalReceivable = 0;
for (const client of clients) {
  const rules = rulesForClient(client.name);
  for (const bill of client.bills) {
    for (const it of bill.items) {
      const rule = extraPrices.has(it.name)
        ? { price: extraPrices.get(it.name), inPriceTable: false }
        : priceRuleFor(rules, it.name);
      if (!rule) {
        if (!unknowns.has(it.name)) unknowns.set(it.name, []);
        unknowns.get(it.name).push(client.name);
        continue;
      }
      it.price = rule.price; // 元
      it.inPriceTable = rule.inPriceTable;
      it.unit = unitFor(it.name);
      it.amountFen = Math.round(it.qty * rule.price * 100);
      itemCount++;
      totalReceivable += it.amountFen;
    }
  }
}
if (unknowns.size > 0) {
  const lines = [...unknowns.entries()]
    .map(([name, cs]) => `  - 「${name}」（委托方: ${[...new Set(cs)].join('、')}）`)
    .join('\n');
  throw new Error(
    `以下品名在单价规则中没有定价，请补充 PRICE_RULES 或用 --extra-price "品名:元" 指定：\n${lines}`,
  );
}

// ── 3. 预览 ──
console.log(`数据文件: ${values.data}`);
console.log(`委托方: ${clients.map((c) => `${c.name}(${c.bills.length}张)`).join('、')}`);
console.log(`合计: ${clients.reduce((s, c) => s + c.bills.length, 0)} 张账单 · 明细 ${itemCount} 行 · 应收合计 ${(totalReceivable / 100).toFixed(2)} 元 · 日期 ${date}`);
for (const client of clients) {
  console.log(`\n【${client.name}】`);
  for (const bill of client.bills) {
    const items = bill.items
      .map((i) => `${i.name}×${i.qty}${i.unit}@${i.price}元${i.note ? `[备注:${i.note}]` : ''}${i.inPriceTable ? '' : '[手填]'}`)
      .join('、');
    console.log(`  ${bill.address}${bill.contact ? '，' + bill.contact : ''}: ${items}`);
  }
}

if (values['dry-run']) {
  console.log('\n[dry-run] 未写库。确认无误后去掉 --dry-run 执行。');
  process.exit(0);
}

// ── 4. 打开库，可选清空，然后导入 ──
const db = openDb(values.db);
try {
  const { accountId, accountName, accountType } = resolveAccount(db, {
    person: values.person,
    account: values.account,
  });
  console.log(`\n目标账本: #${accountId} ${accountName}（${accountType}）`);

  if (values.clean) {
    const stat = cleanAccountWork(db, accountId);
    console.log(`[--clean] 已清空：委托方 ${stat.clients}、单价 ${stat.prices}、账单 ${stat.bills}（明细 ${stat.items}、结算 ${stat.settlements}）`);
  }

  const run = db.transaction(() => {
    const insBill = db.prepare(
      'INSERT INTO work_bills (account_id, client_id, contact, address, occurred_at, note, final_amount) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    );
    const insItem = db.prepare(
      `INSERT INTO work_bill_items (bill_id, name, qty, unit, unit_price, amount, price_ref_id, note, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertPrice = db.prepare(
      `INSERT INTO work_unit_prices (account_id, client_id, name, unit, unit_price, note)
       VALUES (?, ?, ?, ?, ?, '')
       ON CONFLICT(account_id, client_id, name) DO UPDATE SET unit = excluded.unit, unit_price = excluded.unit_price, updated_at = datetime('now','localtime')`,
    );
    const refLookup = db.prepare('SELECT id FROM work_unit_prices WHERE account_id = ? AND client_id = ? AND name = ?');

    let totalBills = 0;
    let totalPrices = 0;
    for (const client of clients) {
      // 4.1 委托方（upsert by account+name）
      const clientRow = db
        .prepare('SELECT id FROM work_clients WHERE account_id = ? AND name = ? AND is_deleted = 0')
        .get(accountId, client.name);
      const clientId = clientRow
        ? clientRow.id
        : Number(
            db
              .prepare("INSERT INTO work_clients (account_id, name, type) VALUES (?, ?, 'company')")
              .run(accountId, client.name).lastInsertRowid,
          );

      // 4.2 单价表：按该委托方实际出现的品名 upsert（手填项不进）
      const priceNames = new Map(); // name -> { price, unit }
      for (const bill of client.bills) {
        for (const it of bill.items) {
          if (!it.inPriceTable) continue;
          if (!priceNames.has(it.name)) priceNames.set(it.name, { price: it.price, unit: it.unit });
        }
      }
      for (const [name, p] of priceNames) {
        upsertPrice.run(accountId, clientId, name, p.unit, Math.round(p.price * 100));
      }
      totalPrices += priceNames.size;

      // 4.3 账单 + 明细
      for (const bill of client.bills) {
        const info = insBill.run(accountId, clientId, bill.contact, bill.address, date, '');
        const billId = Number(info.lastInsertRowid);
        bill.items.forEach((it, idx) => {
          const ref = it.inPriceTable ? refLookup.get(accountId, clientId, it.name)?.id ?? null : null;
          insItem.run(billId, it.name, it.qty, it.unit, Math.round(it.price * 100), it.amountFen, ref, it.note, idx);
        });
        totalBills++;
      }
    }
    return { totalBills, totalPrices };
  });

  const result = run();
  console.log(
    `导入完成：委托方 ${clients.length} 个（${clients.map((c) => c.name).join('、')}）· 单价表 ${result.totalPrices} 条 · 账单 ${result.totalBills} 张 · 明细 ${itemCount} 行 · 应收合计 ${(totalReceivable / 100).toFixed(2)} 元`,
  );
} finally {
  db.close();
}
