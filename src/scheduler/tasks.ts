/**
 * 调度任务实现（M3，对应设计文档 §6）。
 *
 * 原则（§7.1 / ADR D10）：定时抓取/存储/待发消息生成一律由后端确定性完成，
 * 不依赖 LLM/Agent。所有任务幂等：
 *  - reminder_due 靠 tasks.reminded 标志
 *  - bill_digest / daily_brief 靠"同一 person(+平台) 当日已发则跳过"
 *  - outbox_sweep 靠 status='failed' && attempts>=3 定义终态
 *
 * news_fetch / news_cleanup 依赖 M4 的抓取适配器，本里程碑不实现。
 */
import type Database from 'better-sqlite3';
import { now, today } from '../db/dao.js';
import { getPersonIdentities } from '../modules/system/identity.js';
import { listAccountsForPerson } from '../modules/system/accounts.js';
import { getSettingBool, getSettingDefault } from '../modules/system/settings.js';
import { enqueue } from '../modules/outbox/index.js';
import { sweepTerminal } from '../modules/outbox/service.js';
import { billChanges, type ChangeSummary } from '../modules/bills/bills.js';
import { cleanupOldNews, runSubscriptionFetch } from '../modules/news/service.js';
import type { SubscriptionRow } from '../modules/news/subscriptions.js';

// ── 辅助 ──

/** 某 person 在指定平台的身份；无则 undefined。 */
function identityOn(db: Database.Database, personId: number, platform: string) {
  return getPersonIdentities(db, personId).find((i) => i.platform === platform);
}

/** 某 person 的主平台身份；无则 undefined。 */
function primaryIdentity(db: Database.Database, personId: number) {
  return getPersonIdentities(db, personId).find((i) => i.is_primary === 1);
}

/** 当前时间是否已过 HH:MM（设置驱动每日任务的触发时刻用）。 */
function pastTime(time: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return false;
  const target = Number(m[1]) * 60 + Number(m[2]);
  const n = now();
  const cur = Number(n.slice(11, 13)) * 60 + Number(n.slice(14, 16));
  return cur >= target;
}

/** 分 → 元字符串（整数显示不带小数）。 */
function yuan(amount: number): string {
  return (amount / 100).toFixed(amount % 100 ? 2 : 0);
}

/** 当日是否已给该 person(+可选 channel) 发过某 kind 的消息（幂等判断）。 */
function alreadySentToday(db: Database.Database, personId: number, kind: string, channel?: string): boolean {
  const sql = channel
    ? `SELECT 1 AS x FROM outbox WHERE kind = ? AND person_id = ? AND channel = ? AND substr(created_at, 1, 10) = ?`
    : `SELECT 1 AS x FROM outbox WHERE kind = ? AND person_id = ? AND substr(created_at, 1, 10) = ?`;
  const args = channel ? [kind, personId, channel, today()] : [kind, personId, today()];
  return !!db.prepare(sql).get(...args);
}

// ── 任务：任务提醒（reminder_due，每 1 分钟）──

/**
 * 扫描到期未提醒的任务（remind_at<=now && reminded=0 && 未完成 && 未删除），
 * 为每个写一条 outbox 提醒（通道=任务创建时 platform，无则该 person 主平台），
 * 并置 reminded=1 防重复。返回本次提醒条数。
 */
export function runReminderDue(db: Database.Database): number {
  const due = db
    .prepare(
      `SELECT * FROM tasks
       WHERE remind_at IS NOT NULL AND remind_at <= ? AND reminded = 0 AND is_done = 0 AND is_deleted = 0`,
    )
    .all(now()) as Array<{ id: number; creator_id: number; platform: string; content: string; category: string }>;

  let count = 0;
  for (const task of due) {
    // 目标身份：任务创建平台 → 对应 openid；找不到再回落主平台；再找不到就跳过（该平台身份已解绑）
    let identity = task.platform ? identityOn(db, task.creator_id, task.platform) : undefined;
    if (!identity) identity = primaryIdentity(db, task.creator_id);
    if (!identity) continue;

    enqueue(db, {
      personId: task.creator_id,
      channel: identity.platform,
      targetId: identity.openid,
      kind: 'reminder',
      content: `【提醒】${task.category ? `[${task.category}] ` : ''}${task.content}`,
    });
    db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(task.id);
    count++;
  }
  return count;
}

// ── 任务：每日账单变动日报（bill_digest，每日 settings.bill_digest_time，默认 21:00）──

/**
 * 按 operation_logs 汇总当日账单变动，推给相关 person：
 * 家庭账本变动 → 账户所有成员；个人账本变动 → 本人。
 * 通道 = 该 person 主平台。附"疑似重复"仅提示。当日已发则不重发。
 * 返回本次发出的日报条数。
 */
export function runBillDigest(db: Database.Database, date: string = today()): number {
  if (!getSettingBool(db, 'bill_digest_enabled', true)) return 0;
  if (!pastTime(getSettingDefault(db, 'bill_digest_time', '21:00'))) return 0;

  // 找出当日有 bills 变动记录的账户
  const changedAccounts = db
    .prepare(
      `SELECT DISTINCT account_id FROM operation_logs
       WHERE entity = 'bills' AND account_id IS NOT NULL AND substr(created_at, 1, 10) = ?`,
    )
    .all(date) as Array<{ account_id: number }>;

  // 汇总接收人：家庭账本=全部成员，个人账本=本人
  const recipients = new Set<number>();
  for (const { account_id } of changedAccounts) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id) as
      | { type: string; owner_person_id: number }
      | undefined;
    if (!account) continue;
    if (account.type === 'family') {
      const members = db.prepare('SELECT person_id FROM account_members WHERE account_id = ?').all(account_id) as Array<{
        person_id: number;
      }>;
      for (const m of members) recipients.add(m.person_id);
    } else {
      recipients.add(account.owner_person_id);
    }
  }

  let sent = 0;
  for (const personId of recipients) {
    if (alreadySentToday(db, personId, 'bill_digest')) continue;
    const identity = primaryIdentity(db, personId);
    if (!identity) continue; // 无任何平台身份的人发不了
    const { changes } = billChanges(db, personId, date);
    const text = formatBillDigest(date, changes);
    if (!text) continue;
    enqueue(db, {
      personId,
      channel: identity.platform,
      targetId: identity.openid,
      kind: 'bill_digest',
      content: text,
    });
    sent++;
  }
  return sent;
}

/** 把某 person 当日各账户的变动汇总成纯文本日报。 */
function formatBillDigest(date: string, changes: ChangeSummary[]): string {
  const lines = [`【账单日报 ${date}】`];
  let has = false;
  for (const c of changes) {
    const parts: string[] = [];
    if (c.created.length > 0) {
      const brief = c.created
        .slice(0, 5)
        .map((b) => `${b.note || b.category}${yuan(b.amount)}元`)
        .join('、');
      parts.push(`新增 ${c.created.length} 笔${brief ? `（${brief}${c.created.length > 5 ? '…' : ''}）` : ''}`);
    }
    if (c.updated.length > 0) parts.push(`修改 ${c.updated.length} 笔`);
    if (c.deleted.length > 0) parts.push(`删除 ${c.deleted.length} 笔`);
    if (c.restored.length > 0) parts.push(`恢复 ${c.restored.length} 笔`);
    if (c.settled.length > 0) parts.push(`AA 结算 ${c.settled.length} 笔`);
    if (parts.length === 0) continue;
    has = true;
    lines.push(`${c.account_name}：${parts.join('；')}`);
    for (const s of c.suspect_duplicates) {
      lines.push(`⚠ 疑似重复：${yuan(s.amount)}元/${s.category} ×${s.count}`);
    }
  }
  return has ? lines.join('\n') : '';
}

// ── 任务：每日简报（daily_brief，每日 settings.daily_brief_time，默认 09:00）──

/**
 * 汇总未读新闻 + 未完成待办，对每个 person、每个存在启用订阅的平台各写一条 outbox
 * （通道=该平台，目标=该平台身份）。当日该 person+平台已发则不重发。
 * 返回本次简报条数。
 */
export function runDailyBrief(db: Database.Database, date: string = today()): number {
  if (!getSettingBool(db, 'daily_brief_enabled', true)) return 0;
  if (!pastTime(getSettingDefault(db, 'daily_brief_time', '09:00'))) return 0;

  // 所有启用订阅按 (person, platform) 分组
  const subs = db
    .prepare(`SELECT id, person_id, platform FROM subscriptions WHERE enabled = 1`)
    .all() as Array<{ id: number; person_id: number; platform: string }>;
  const groups = new Map<string, { personId: number; platform: string; subIds: number[] }>();
  for (const s of subs) {
    const key = `${s.person_id}|${s.platform}`;
    const g = groups.get(key) ?? { personId: s.person_id, platform: s.platform, subIds: [] };
    g.subIds.push(s.id);
    groups.set(key, g);
  }

  let sent = 0;
  for (const g of groups.values()) {
    if (alreadySentToday(db, g.personId, 'daily_brief', g.platform)) continue;
    const identity = identityOn(db, g.personId, g.platform);
    if (!identity) continue;
    const text = formatDailyBrief(db, g, date);
    if (!text) continue;
    enqueue(db, {
      personId: g.personId,
      channel: g.platform,
      targetId: identity.openid,
      kind: 'daily_brief',
      content: text,
    });
    sent++;
  }
  return sent;
}

/** 组装每日简报文本：该平台订阅的未读新闻 + 该 person 可见账户的未完成待办。 */
function formatDailyBrief(
  db: Database.Database,
  g: { personId: number; platform: string; subIds: number[] },
  date: string,
): string {
  const placeholders = g.subIds.map(() => '?').join(', ');
  const news = db
    .prepare(
      `SELECT title FROM news_cache WHERE subscription_id IN (${placeholders}) AND is_read = 0
       ORDER BY fetched_at DESC LIMIT 10`,
    )
    .all(...g.subIds) as Array<{ title: string }>;

  const accountIds = listAccountsForPerson(db, g.personId).map((a) => a.id);
  let tasks: Array<{ content: string; category: string }> = [];
  if (accountIds.length > 0) {
    const p2 = accountIds.map(() => '?').join(', ');
    tasks = db
      .prepare(
        `SELECT content, category FROM tasks WHERE account_id IN (${p2}) AND is_done = 0 AND is_deleted = 0
         ORDER BY created_at LIMIT 10`,
      )
      .all(...accountIds) as Array<{ content: string; category: string }>;
  }

  if (news.length === 0 && tasks.length === 0) return '';
  const lines = [`【每日简报 ${date}】`];
  if (news.length > 0) {
    lines.push(`未读新闻 ${news.length} 条：`);
    for (const n of news) lines.push(`- ${n.title}`);
  }
  if (tasks.length > 0) {
    lines.push(`未完成待办 ${tasks.length} 项：`);
    for (const t of tasks) lines.push(`- ${t.content}${t.category ? `（${t.category}）` : ''}`);
  }
  return lines.join('\n');
}

// ── 任务：outbox 终态清理（outbox_sweep，每 10 分钟）──

/** 扫描 failed+attempts>=3 的终态记录并告警（去重）。返回本次新告警条数。 */
export function runOutboxSweep(db: Database.Database): number {
  return sweepTerminal(db);
}

// ── 任务：订阅抓取（news_fetch，每 6 小时）与缓存清理（news_cleanup，每小时）──

/**
 * 遍历全部启用订阅，调对应适配器抓取并去重写 news_cache。
 * 单个订阅失败只记日志不中断（网络超时/站点改版都要能扛）。返回成功抓取的订阅数。
 */
export async function runNewsFetch(db: Database.Database): Promise<number> {
  const subs = db.prepare('SELECT * FROM subscriptions WHERE enabled = 1').all() as SubscriptionRow[];
  let ok = 0;
  for (const sub of subs) {
    try {
      const stats = await runSubscriptionFetch(db, sub);
      console.log(`[news_fetch] ${sub.name}: total=${stats.total} new=${stats.new} dup=${stats.dup}`);
      ok++;
    } catch (err) {
      console.warn(`[news_fetch] ${sub.name} 失败: ${(err as Error).message}`);
    }
  }
  return ok;
}

/** 清理超期新闻缓存（settings.news_retention_days，默认 4 天）。返回删除条数。 */
export function runNewsCleanup(db: Database.Database): number {
  const days = Number(getSettingDefault(db, 'news_retention_days', '4')) || 4;
  return cleanupOldNews(db, days);
}
