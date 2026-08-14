/**
 * Fastify 应用装配：日志、错误统一格式、/healthz、模块路由注册。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { AppError } from './lib/errors.js';
import type { Config } from './config.js';
import { TableRegistry } from './db/registry.js';
import { registerSystemRoutes } from './modules/system/routes.js';
import { registerInternalRoutes } from './modules/internal/routes.js';

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
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply.code(err.statusCode).send({ code: err.code, message: err.message });
      return;
    }
    req.log.error(err);
    void reply.code(500).send({ code: 'INTERNAL', message: 'Internal server error' });
  });

  // 健康检查（无鉴权，供 compose healthcheck）
  app.get('/healthz', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  app.register(registerSystemRoutes, { db, apiKey: config.apiKey });
  app.register(registerInternalRoutes, { registry, adminKey: config.adminKey });

  return app;
}
