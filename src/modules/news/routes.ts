/**
 * 订阅 / 新闻 / 实时抓取 路由（M4，对应设计文档 §5.3 / §5.6）。
 * 订阅与新闻归 person（个人级）；/fetch 实时抓取对当前 person 开放。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logOperation } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import type { Identity } from '../../lib/identity.js';
import { createSubscription, deleteSubscription, getSubscription, listSubscriptions } from './subscriptions.js';
import { markNewsRead, queryNews, runSubscriptionFetch } from './service.js';
import { fetchByPreset, fetchRss, fetchUrlAsItem, listAdapterKeys, validateFetchUrl } from './registry.js';
import type { FetchedItem } from './adapters/types.js';

export interface NewsRouteDeps {
  db: Database.Database;
  identity: ReturnType<typeof createIdentityHooks>;
}

export async function registerNewsRoutes(app: FastifyInstance, deps: NewsRouteDeps): Promise<void> {
  const { db, identity } = deps;
  const { requireBoundPerson } = identity;
  const me = (req: { identity: Identity | null }): number => req.identity!.personId!;

  // ── 订阅（§5.3）──

  // 建订阅：rss → 需 source_url（过 SSRF 校验）；preset → 需 preset_key 存在
  app.post('/api/v1/subscriptions', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const platform = req.identity!.platform;
    const body = req.body as Record<string, unknown>;
    const sourceType = body.source_type;
    if (sourceType !== 'rss' && sourceType !== 'preset') {
      throw new AppError(400, 'INVALID_SOURCE_TYPE', 'source_type 需为 rss 或 preset');
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : sourceType === 'rss' ? 'RSS 订阅' : '信息源';

    if (sourceType === 'rss') {
      if (typeof body.source_url !== 'string' || body.source_url.trim() === '') {
        throw new AppError(400, 'INVALID_BODY', 'rss 订阅需提供 source_url');
      }
      await validateFetchUrl(body.source_url.trim()); // SSRF 校验
    } else {
      const key = typeof body.preset_key === 'string' ? body.preset_key : '';
      if (!listAdapterKeys().includes(key)) {
        throw new AppError(400, 'INVALID_PRESET', `未知 preset_key: ${key || '(空)'}（可选: ${listAdapterKeys().join('/')}）`);
      }
    }

    const id = createSubscription(db, {
      person_id: personId,
      platform,
      source_type: sourceType,
      name,
      source_url: typeof body.source_url === 'string' ? body.source_url.trim() : null,
      preset_key: typeof body.preset_key === 'string' ? body.preset_key : null,
    });
    return { ok: true, subscription: getSubscription(db, id) };
  });

  // 订阅列表
  app.get('/api/v1/subscriptions', { preHandler: requireBoundPerson }, async (req) => {
    return { subscriptions: listSubscriptions(db, me(req)) };
  });

  // 退订
  app.delete('/api/v1/subscriptions/:id', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const sub = requireOwnSubscription(req, personId);
    deleteSubscription(db, sub.id);
    return { ok: true, deleted: true };
  });

  // 手动触发一次抓取（写日志，失败可追踪）
  app.post('/api/v1/subscriptions/:id/refresh', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const sub = requireOwnSubscription(req, personId);
    const stats = await runSubscriptionFetch(db, sub);
    logOperation(db, {
      personId,
      action: 'subscription.refresh',
      entity: 'subscriptions',
      entityId: sub.id,
      after: { name: sub.name, source_type: sub.source_type, ...stats },
    });
    return { ok: true, ...stats };
  });

  // ── 新闻查询（§5.3）──

  // 查询缓存新闻：未读优先；可限定 subscription_id
  app.get('/api/v1/news', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const q = req.query as Record<string, string | undefined>;
    const items = queryNews(db, personId, {
      subscription_id: q.subscription_id !== undefined ? Number(q.subscription_id) : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : 20,
    });
    return { items };
  });

  // 标记已读
  app.post('/api/v1/news/:id/read', { preHandler: requireBoundPerson }, async (req) => {
    const { id } = req.params as { id: string };
    const newsId = Number(id);
    if (!Number.isInteger(newsId) || newsId <= 0) throw new AppError(400, 'INVALID_ID', `id 非法: ${id}`);
    if (!markNewsRead(db, newsId, me(req))) {
      throw new AppError(404, 'NEWS_NOT_FOUND', '新闻不存在或不属于当前用户');
    }
    return { ok: true, id: newsId };
  });

  // ── 实时抓取 /fetch（§5.6，模式二）──

  // body: { source_type:'rss'|'url'|'preset', source_url?, preset_key?, params? } → 返回解析后条目
  app.post('/api/v1/fetch', { preHandler: requireBoundPerson }, async (req) => {
    const body = req.body as Record<string, unknown>;
    const sourceType = body.source_type;
    let items: FetchedItem[];

    if (sourceType === 'rss' || sourceType === 'url') {
      const url = typeof body.source_url === 'string' ? body.source_url.trim() : '';
      if (!url) throw new AppError(400, 'INVALID_BODY', `${sourceType} 模式需提供 source_url`);
      await validateFetchUrl(url); // SSRF 校验
      items = sourceType === 'rss' ? await fetchRss(url) : await fetchUrlAsItem(url);
    } else if (sourceType === 'preset') {
      const key = typeof body.preset_key === 'string' ? body.preset_key : '';
      const params = typeof body.params === 'object' && body.params !== null ? (body.params as Record<string, unknown>) : {};
      items = await fetchByPreset(key, params);
    } else {
      throw new AppError(400, 'INVALID_SOURCE_TYPE', 'source_type 需为 rss | url | preset');
    }

    return { ok: true, count: items.length, items };
  });

  // ── 私有辅助 ──

  /** 取当前 person 名下的一条订阅；不存在或不属于则 404。 */
  function requireOwnSubscription(req: FastifyRequest, personId: number) {
    const { id } = req.params as { id: string };
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) throw new AppError(400, 'INVALID_ID', `id 非法: ${id}`);
    const sub = getSubscription(db, idNum);
    if (!sub || sub.person_id !== personId) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', '订阅不存在');
    return sub;
  }
}
