/**
 * 订阅源数据访问层（M4，对应设计文档 §4.7 / §5.3）。
 * 订阅为个人级（ADR D19）：归 person，主要 QQ 端需求；推送目标=创建时平台。
 */
import type Database from 'better-sqlite3';

export interface SubscriptionRow {
  id: number;
  person_id: number;
  platform: string;       // 创建时的注入平台（'wechat' | 'qq'）
  source_type: string;    // 'rss' | 'preset'
  name: string;
  source_url: string | null;  // rss 时必填
  preset_key: string | null;  // preset 时填内置适配器键名
  enabled: number;
  created_at: string;
}

export interface CreateSubscriptionInput {
  person_id: number;
  platform: string;
  source_type: 'rss' | 'preset';
  name: string;
  source_url?: string | null;
  preset_key?: string | null;
}

/** 建订阅，返回新 id。 */
export function createSubscription(db: Database.Database, input: CreateSubscriptionInput): number {
  const info = db
    .prepare(
      `INSERT INTO subscriptions (person_id, platform, source_type, name, source_url, preset_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.person_id,
      input.platform,
      input.source_type,
      input.name,
      input.source_url ?? null,
      input.preset_key ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** 某 person 的全部订阅。 */
export function listSubscriptions(db: Database.Database, personId: number): SubscriptionRow[] {
  return db
    .prepare('SELECT * FROM subscriptions WHERE person_id = ? ORDER BY created_at, id')
    .all(personId) as SubscriptionRow[];
}

/** 取单条订阅；不存在返回 undefined。 */
export function getSubscription(db: Database.Database, id: number): SubscriptionRow | undefined {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined;
}

/** 退订（硬删，订阅无软删除概念）。返回是否真的删到。 */
export function deleteSubscription(db: Database.Database, id: number): boolean {
  const info = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  return info.changes > 0;
}
