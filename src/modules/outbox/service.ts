/**
 * outbox 服务层（M3，对应设计文档 §5.4 / §6 outbox_sweep / §7 消费契约）。
 *
 * 生命周期：enqueue 生产 pending → 插件轮询 listPending 取走 → 投递后 deliver 回执。
 *  - status='sent'：投递成功，不再出现在 pending。
 *  - status='failed' && attempts>=3：终态，由 outbox_sweep 告警，不再重试。
 *  - status='pending' && attempts<3：可重试，仍会被 pending 取到。
 */
import type Database from 'better-sqlite3';
import { now } from '../../db/dao.js';

export interface OutboxRow {
  id: number;
  person_id: number;
  channel: string;      // 'wechat' | 'qq'
  target_id: string;    // 目标 openid / 群 id
  content: string;
  kind: string;
  due_at: string;
  status: string;       // 'pending' | 'sent' | 'failed'
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

/** 已投递成功且重试超限的失败记录会被告警去重，避免每轮 sweep 重复告警。 */
const alertedIds = new Set<number>();

/**
 * 插件消费：取 due_at<=now、status=pending、attempts<3 的待发消息。
 * 可选按 channel 过滤。按到期时间升序（先到先发）。
 */
export function listPending(
  db: Database.Database,
  opts: { channel?: string; limit?: number } = {},
): OutboxRow[] {
  const conds = ["status = 'pending'", 'attempts < 3', 'due_at <= ?'];
  const args: unknown[] = [now()];
  if (opts.channel) {
    conds.push('channel = ?');
    args.push(opts.channel);
  }
  const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, 100) : 20;
  return db
    .prepare(`SELECT * FROM outbox WHERE ${conds.join(' AND ')} ORDER BY due_at, id LIMIT ?`)
    .all(...args, limit) as OutboxRow[];
}

/**
 * 插件回执（幂等）：
 *  - 记录不存在 → undefined（路由层转 404）
 *  - 已 sent → 'already'（路由层直接返回 200，不重复处理，§7 幂等）
 *  - status='sent' → 置 sent/sent_at
 *  - status='failed' → attempts+1；达到 3 次置 status='failed'（终态），否则留 pending 供重试
 */
export function deliver(
  db: Database.Database,
  id: number,
  input: { status: 'sent' | 'failed'; error?: string },
): { row: OutboxRow } | 'already' | undefined {
  const before = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined;
  if (!before) return undefined;
  if (before.status === 'sent') return 'already';

  if (input.status === 'sent') {
    db.prepare(`UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`).run(now(), id);
  } else {
    const attempts = before.attempts + 1;
    const finalStatus = attempts >= 3 ? 'failed' : 'pending';
    db.prepare(
      `UPDATE outbox SET attempts = ?, status = ?, last_error = ?, sent_at = NULL WHERE id = ?`,
    ).run(attempts, finalStatus, input.error ?? null, id);
  }
  return { row: db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow };
}

/**
 * 终态清理扫描（§6 outbox_sweep，每 10 分钟）：status='failed' 且 attempts>=3 的做终态告警。
 * 返回本次新告警的条数（模块内 Set 去重，避免每轮重复告警）。
 */
export function sweepTerminal(db: Database.Database): number {
  const rows = db
    .prepare(`SELECT id, channel, target_id, last_error FROM outbox WHERE status = 'failed' AND attempts >= 3`)
    .all() as Array<{ id: number; channel: string; target_id: string; last_error: string | null }>;
  let fresh = 0;
  for (const r of rows) {
    if (alertedIds.has(r.id)) continue;
    alertedIds.add(r.id);
    // eslint-disable-next-line no-console
    console.warn(`[outbox] 终态失败消息 id=${r.id} channel=${r.channel} target=${r.target_id} error=${r.last_error ?? ''}`);
    fresh++;
  }
  return fresh;
}
