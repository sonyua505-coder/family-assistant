/**
 * system 模块路由（M0 先做 settings；identity/persons/accounts 在 M1）。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { requireApiKey } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { getAllSettings, setSetting } from './settings.js';

export interface SystemRouteDeps {
  db: Database.Database;
  apiKey: string;
}

export async function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): Promise<void> {
  const { db, apiKey } = deps;
  const onAuth = requireApiKey(apiKey);

  app.get('/api/v1/system/settings', { preHandler: onAuth }, async () => getAllSettings(db));

  app.patch('/api/v1/system/settings', { preHandler: onAuth }, async (req) => {
    const body = req.body as { key?: unknown; value?: unknown };
    if (typeof body !== 'object' || body === null || typeof body.key !== 'string' || body.key.length === 0 || typeof body.value !== 'string') {
      throw new AppError(400, 'INVALID_BODY', 'body 需 { key: string, value: string }');
    }
    setSetting(db, body.key, body.value);
    return { ok: true, key: body.key };
  });
}
