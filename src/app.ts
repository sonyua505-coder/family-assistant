/**
 * Fastify 应用装配：日志、错误统一格式、/healthz、模块路由注册。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { AppError } from './lib/errors.js';
import type { Config } from './config.js';
import { TableRegistry } from './db/registry.js';
import { createIdentityHooks } from './lib/identity.js';
import { registerSystemRoutes } from './modules/system/routes.js';
import { registerInternalRoutes } from './modules/internal/routes.js';
import { registerBillsRoutes } from './modules/bills/routes.js';
import { registerOutboxRoutes } from './modules/outbox/routes.js';
import { registerNewsRoutes } from './modules/news/routes.js';
import { registerTasksRoutes } from './modules/tasks/routes.js';
import { registerBillsWebRoutes } from './modules/bills_web/routes.js';

export interface AppDeps {
  db: Database.Database;
  registry: TableRegistry;
  config: Config;
}

export function buildApp({ db, registry, config }: AppDeps): FastifyInstance {
  const isDev = process.env.NODE_ENV !== 'production';
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // 记账 Web 令牌不落日志（§9：/w/* 访问日志对 token 脱敏）
        req(request: { method: string; url: string }) {
          return { method: request.method, url: request.url.replace(/\/w\/[0-9a-f]{64}/gi, '/w/<redacted>') };
        },
      },
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
  });

  // 错误统一格式 { code, message }
  // AppError 是我们的业务错误；其余（Fastify 自带的 400/404、运行时异常等）
  // 保留其原始状态码与 code，兜底才是 500，避免把客户端错误误报成服务器错误。
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply.code(err.statusCode).send({ code: err.code, message: err.message });
      return;
    }
    req.log.error(err);
    const anyErr = err as { code?: unknown; statusCode?: unknown; message?: string };
    const code = typeof anyErr.code === 'string' ? anyErr.code : 'INTERNAL';
    const status = Number.isInteger(anyErr.statusCode) && (anyErr.statusCode as number) >= 400
      ? (anyErr.statusCode as number)
      : 500;
    void reply.code(status).send({ code, message: anyErr.message ?? 'Internal server error' });
  });

  // 宽容 JSON 解析：空 body + application/json（常见于无 body 的 DELETE）解析成 {}，
  // 而非 Fastify 默认的 "Body cannot be empty" 400。缺字段由各路由的业务校验兜底。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  // 健康检查（无鉴权，供 compose healthcheck）
  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  // 给请求对象挂上 identity 字段（默认 null，由身份中间件填充）
  app.decorateRequest('identity', null);

  // 身份注入中间件（M1）：从 x-platform / x-openid 请求头解析 person
  const { requireIdentity, requireBoundPerson } = createIdentityHooks(db);

  app.register(registerSystemRoutes, {
    db,
    apiKey: config.apiKey,
    identity: { requireIdentity, requireBoundPerson },
  });
  app.register(registerBillsRoutes, { db, identity: { requireIdentity, requireBoundPerson } });
  app.register(registerOutboxRoutes, { db, apiKey: config.apiKey });
  app.register(registerNewsRoutes, { db, identity: { requireIdentity, requireBoundPerson } });
  app.register(registerTasksRoutes, { db, identity: { requireIdentity, requireBoundPerson } });
  app.register(registerBillsWebRoutes, { db, apiKey: config.apiKey, config, identity: { requireIdentity, requireBoundPerson } });
  app.register(registerInternalRoutes, { registry, adminKey: config.adminKey });

  return app;
}
