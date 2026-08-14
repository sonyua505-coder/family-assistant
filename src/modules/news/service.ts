/**
 * 新闻抓取/查询服务（M4，对应设计文档 §4.8 / §5.3 / §6 news_fetch）。
 *
 * 调度器（news_fetch）与订阅手动刷新（/subscriptions/:id/refresh）共用同一套：
 * 调适配器 → 按 url_hash 去重写 news_cache → 返回 new/dup 计数。
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AppError } from '../../lib/errors.js';
import { fetchByPreset, fetchRss, validateFetchUrl } from './registry.js';
import type { FetchedItem } from './adapters/types.js';
import type { SubscriptionRow } from './subscriptions.js';

export interface NewsRow {
  id: number;
  subscription_id: number;
  title: string;
  url: string;
  summary: string;
  published_at: string | null;
  url_hash: string;
  fetched_at: string;
  is_read: number;
}

export interface FetchStats {
  total: number;
  new: number; // 本次新增（去重后真正写库的）
  dup: number; // 已存在被去重
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 把适配器返回的条目去重写入 news_cache（url_hash 唯一约束）。
 * ON CONFLICT DO NOTHING：同 (subscription_id, url_hash) 已存在则跳过并计入 dup。
 */
export function storeItems(db: Database.Database, subscriptionId: number, items: FetchedItem[]): FetchStats {
  const stmt = db.prepare(
    `INSERT INTO news_cache (subscription_id, title, url, summary, published_at, url_hash)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, url_hash) DO NOTHING`,
  );
  let total = 0;
  let nNew = 0;
  for (const item of items) {
    total++;
    if (!item.url || !item.title) continue; // 契约要求 url/title 必填，异常条目跳过
    const info = stmt.run(subscriptionId, item.title, item.url, item.summary ?? '', item.published_at ?? null, sha256(item.url));
    if (info.changes > 0) nNew++;
  }
  return { total, new: nNew, dup: total - nNew };
}

/**
 * 执行一次订阅抓取（调度 / refresh 共用）：
 * rss → fetchRss(source_url)（先过 SSRF 校验）；preset → fetchByPreset(preset_key)。
 * 失败抛 AppError / 中文错误，由调用方记日志。
 */
export async function runSubscriptionFetch(
  db: Database.Database,
  subscription: SubscriptionRow,
): Promise<FetchStats> {
  let items: FetchedItem[];
  if (subscription.source_type === 'rss') {
    if (!subscription.source_url) throw new AppError(400, 'INVALID_BODY', 'rss 订阅缺少 source_url');
    await validateFetchUrl(subscription.source_url);
    items = await fetchRss(subscription.source_url);
  } else if (subscription.source_type === 'preset') {
    if (!subscription.preset_key) throw new AppError(400, 'INVALID_BODY', 'preset 订阅缺少 preset_key');
    items = await fetchByPreset(subscription.preset_key);
  } else {
    throw new AppError(400, 'INVALID_SOURCE_TYPE', `未知 source_type: ${subscription.source_type}`);
  }
  return storeItems(db, subscription.id, items);
}

/** 查询当前 person 的缓存新闻：未读优先，再按时间倒序。可限定某订阅。 */
export function queryNews(
  db: Database.Database,
  personId: number,
  opts: { subscription_id?: number; limit?: number } = {},
): NewsRow[] {
  const subIds = db
    .prepare('SELECT id FROM subscriptions WHERE person_id = ?')
    .all(personId)
    .map((r) => (r as { id: number }).id);
  if (subIds.length === 0) return [];

  let conds = `subscription_id IN (${subIds.map(() => '?').join(', ')})`;
  const args: unknown[] = [...subIds];
  if (opts.subscription_id !== undefined) {
    // 只能查自己订阅下的新闻
    if (!subIds.includes(opts.subscription_id)) {
      throw new AppError(403, 'FORBIDDEN', '无权访问该订阅的新闻');
    }
    conds += ' AND subscription_id = ?';
    args.push(opts.subscription_id);
  }
  const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, 100) : 20;
  return db
    .prepare(
      `SELECT * FROM news_cache WHERE ${conds}
       ORDER BY is_read ASC, COALESCE(published_at, fetched_at) DESC, id DESC LIMIT ?`,
    )
    .all(...args, limit) as NewsRow[];
}

/** 标记某条新闻已读（须属于当前 person 的订阅）。返回是否真的标到。 */
export function markNewsRead(db: Database.Database, newsId: number, personId: number): boolean {
  const subIds = db
    .prepare('SELECT id FROM subscriptions WHERE person_id = ?')
    .all(personId)
    .map((r) => (r as { id: number }).id);
  if (subIds.length === 0) return false;
  const info = db
    .prepare(
      `UPDATE news_cache SET is_read = 1
       WHERE id = ? AND subscription_id IN (${subIds.map(() => '?').join(', ')})`,
    )
    .run(newsId, ...subIds);
  return info.changes > 0;
}

/** 清理过期新闻缓存（news_cleanup 用，返回删除条数）。 */
export function cleanupOldNews(db: Database.Database, retentionDays: number): number {
  const info = db
    .prepare(`DELETE FROM news_cache WHERE fetched_at < datetime('now', 'localtime', ?)`)
    .run(`-${retentionDays} days`);
  return info.changes;
}
