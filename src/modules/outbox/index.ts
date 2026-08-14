/**
 * outbox 待推送队列（M1 只做"生产侧"最小实现，对应设计文档 §4.9 / §7）。
 *
 * 设计模式（ADR D6）：后端只往 outbox 写"待发消息"，AstrBot 插件轮询取走再投递。
 * M1 用到的场景：bind_person 绑定后通知该 person 所有已绑身份（Open Item #13）。
 * 完整的生产调度（reminder/daily_brief/bill_digest）与插件消费在 M3。
 */
import type Database from 'better-sqlite3';
import { now } from '../../db/dao.js';

export interface OutboxEnqueueInput {
  personId: number;    // 接收人（推送目标 person）
  channel: string;     // 'wechat' | 'qq'（投递通道，来自触发来源平台）
  targetId: string;    // 目标 openid / 群 id
  content: string;     // 纯文本消息内容（不含密钥/内部地址）
  kind?: string;       // 'reminder'|'daily_brief'|'bill_digest'|'news'|'notice'，默认 notice
  dueAt?: string;      // 可发送时间，默认立即
}

/** 写一条待推送消息到 outbox，返回新记录 id。 */
export function enqueue(db: Database.Database, input: OutboxEnqueueInput): number {
  const info = db
    .prepare(
      `INSERT INTO outbox (person_id, channel, target_id, content, kind, due_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.personId, input.channel, input.targetId, input.content, input.kind ?? 'notice', input.dueAt ?? now());
  return Number(info.lastInsertRowid);
}
