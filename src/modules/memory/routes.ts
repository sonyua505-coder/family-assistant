/**
 * 用户记忆路由（M4，对应设计文档 §5.6）。
 * 记忆按当前用户强制隔离（设计文档 §4.12 / §9）——所有查询都带 person_id 过滤，
 * 无法跨用户访问。BOT 工具：remember / search_memory / forget。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { AppError } from '../../lib/errors.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import type { Identity } from '../../lib/identity.js';
import { createMemory, deleteMemory, searchMemories } from './memory.js';

export interface MemoryRouteDeps {
  db: Database.Database;
  identity: ReturnType<typeof createIdentityHooks>;
}

export async function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): Promise<void> {
  const { db, identity } = deps;
  const { requireBoundPerson } = identity;
  const me = (req: { identity: Identity | null }): number => req.identity!.personId!;

  // 检索当前用户记忆：?q=&category=（BOT 判断相关时主动调用）
  app.get('/api/v1/memories', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const q = req.query as Record<string, string | undefined>;
    const items = searchMemories(db, personId, q.q, q.category);
    return { items };
  });

  // 新增一条记忆（LLM remember 工具）
  app.post('/api/v1/memories', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const body = req.body as { content?: unknown; category?: unknown };
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      throw new AppError(400, 'INVALID_BODY', 'content 不能为空');
    }
    const id = createMemory(db, personId, body.content.trim(), typeof body.category === 'string' ? body.category : undefined);
    return { ok: true, id };
  });

  // 删除一条记忆（LLM forget 工具，校验归属）
  app.delete('/api/v1/memories/:id', { preHandler: requireBoundPerson }, async (req) => {
    const { id } = req.params as { id: string };
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) throw new AppError(400, 'INVALID_ID', `id 非法: ${id}`);
    if (!deleteMemory(db, idNum, me(req))) {
      throw new AppError(404, 'MEMORY_NOT_FOUND', '记忆不存在或不属于当前用户');
    }
    return { ok: true, id: idNum };
  });
}
