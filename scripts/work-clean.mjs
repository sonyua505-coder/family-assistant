/**
 * 清空指定账本的工作记账数据（结算→明细→账单→单价表→委托方）。
 *
 * 用法：
 *   node scripts/work-clean.mjs --account <id|名称> [--person <id|名称>] [--db <path>]
 *   node scripts/work-clean.mjs --person 小明                      # 用其唯一账本
 *
 * 参数：
 *   --account  账本（数字=id，字符串=名称）；与 --person 二选一或都传
 *   --person   用户（数字=persons.id，字符串=display_name/nickname）；只传时取其唯一账本
 *   --db       SQLite 路径，默认 ./data/dev.db
 */
import { parseArgs } from 'node:util';
import { openDb, resolveAccount, cleanAccountWork } from './_work-util.mjs';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: './data/dev.db' },
    person: { type: 'string' },
    account: { type: 'string' },
  },
});

const db = openDb(values.db);
try {
  const { accountId, accountName, accountType } = resolveAccount(db, {
    person: values.person,
    account: values.account,
  });

  console.log(`目标账本: #${accountId} ${accountName}（${accountType}）`);
  const stat = cleanAccountWork(db, accountId);
  console.log('已清空：');
  console.log(`  委托方 ${stat.clients} 条、单价表 ${stat.prices} 条、工作账单 ${stat.bills} 张（明细 ${stat.items} 行、结算 ${stat.settlements} 条）`);
} finally {
  db.close();
}
