/**
 * outbox 消费端路由（M3，对应设计文档 §5.4）。
 * 消费方是 AstrBot 插件（服务，非用户），所以只过 X-API-Key，不需要身份注入。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { requireApiKey } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { deliver, listPending } from './service.js';

export interface OutboxRouteDeps {
  db: Database.Database;
  apiKey: string;
}

export async function registerOutboxRoutes(app: FastifyInstance, deps: OutboxRouteDeps): Promise<void> {
  const { db, apiKey } = deps;
  const onAuth = requireApiKey(apiKey);

  // 插件轮询待发消息（?limit=&channel=）
  app.get('/api/v1/outbox/pending', { preHandler: onAuth }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const channel = q.channel && q.channel.length > 0 ? q.channel : undefined;
    const limit = q.limit !== undefined ? Number(q.limit) : 20;
    return { items: listPending(db, { channel, limit }) };
  });

  // 插件投递回执：{ status:'sent'|'failed', error? }
  app.post('/api/v1/outbox/:id/delivery', { preHandler: onAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) throw new AppError(400, 'INVALID_ID', `id 非法: ${id}`);
    const body = req.body as { status?: unknown; error?: unknown };
    if (body.status !== 'sent' && body.status !== 'failed') {
      throw new AppError(400, 'INVALID_STATUS', 'status 需为 sent 或 failed');
    }
    const result = deliver(db, idNum, {
      status: body.status,
      error: typeof body.error === 'string' ? body.error : undefined,
    });
    if (result === undefined) throw new AppError(404, 'OUTBOX_NOT_FOUND', '记录不存在');
    if (result === 'already') return { ok: true, already: true, status: 'sent' };
    return { ok: true, status: result.row.status, attempts: result.row.attempts };
  });
}
