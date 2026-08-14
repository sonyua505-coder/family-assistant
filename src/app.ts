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
  app.register(registerInternalRoutes, { registry, adminKey: config.adminKey });

  return app;
}
