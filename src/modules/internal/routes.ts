/**
 * 内部接口：表注册（对应设计文档 §5.7）。需独立管理员密钥，不对用户开放。
 * 用途：新增特化模块（如工作记账）时，用 schema 描述符注册表 → 自动建表 + 通用 CRUD。
 */
import type { FastifyInstance } from 'fastify';
import { normalizeDescriptor, type TableDescriptor, TableRegistry } from '../../db/registry.js';
import { requireAdminKey } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';

export interface InternalRouteDeps {
  registry: TableRegistry;
  adminKey: string;
}

export async function registerInternalRoutes(app: FastifyInstance, deps: InternalRouteDeps): Promise<void> {
  const { registry, adminKey } = deps;
  const onAdmin = requireAdminKey(adminKey);

  app.get('/api/v1/_internal/tables', { preHandler: onAdmin }, async () => ({
    tables: registry.list().map((d) => ({
      name: d.name,
      softDelete: !!d.softDelete,
      columns: Object.keys(d.columns),
      indexes: (d.indexes ?? []).map((i) => i.name),
    })),
  }));

  app.post('/api/v1/_internal/tables', { preHandler: onAdmin }, async (req) => {
    let desc: TableDescriptor;
    try {
      desc = normalizeDescriptor(req.body);
    } catch (err) {
      throw new AppError(400, 'INVALID_DESCRIPTOR', (err as Error).message);
    }
    registry.register(desc);
    return { ok: true, name: desc.name };
  });

  app.delete('/api/v1/_internal/tables/:name', { preHandler: onAdmin }, async (req) => {
    const { name } = req.params as { name: string };
    if (!registry.unregister(name)) throw new AppError(404, 'TABLE_NOT_REGISTERED', `表未注册: ${name}`);
    return { ok: true, name };
  });
}
