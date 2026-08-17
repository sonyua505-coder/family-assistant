/**
 * 家庭共享任务路由（M4，对应设计文档 §5.2）。
 * 全部要求已绑定 person；账户归属走 resolveAccountId（唯一/歧义/越权，D26）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logOperation } from '../../db/dao.js';
import { AppError } from '../../lib/errors.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import type { Identity } from '../../lib/identity.js';
import { resolveAccountId } from '../system/accounts.js';
import {
  buildTaskCsv,
  createTask,
  exportTasks,
  getTask,
  listTasks,
  setTaskDone,
  softDeleteTask,
  updateTask,
  type TaskListQuery,
} from './tasks.js';

export interface TasksRouteDeps {
  db: Database.Database;
  identity: ReturnType<typeof createIdentityHooks>;
}

export async function registerTasksRoutes(app: FastifyInstance, deps: TasksRouteDeps): Promise<void> {
  const { db, identity } = deps;
  const { requireBoundPerson } = identity;
  const me = (req: { identity: Identity | null }): number => req.identity!.personId!;

  // 建事项：{content, category?, remind_at?, linked_bill_id?}（account 归属同上）
  app.post('/api/v1/tasks', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const body = req.body as Record<string, unknown>;
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      throw new AppError(400, 'INVALID_BODY', 'content 不能为空');
    }
    const accountId = resolveAccountId(db, personId, typeof body.account_id === 'number' ? body.account_id : undefined);
    const id = createTask(db, {
      account_id: accountId,
      creator_id: personId,
      platform: req.identity!.platform,
      content: body.content.trim(),
      category: typeof body.category === 'string' ? body.category : undefined,
      remind_at: body.remind_at,
      linked_bill_id: typeof body.linked_bill_id === 'number' ? body.linked_bill_id : null,
    });
    const task = getTask(db, id)!;
    logOperation(db, { personId, accountId, action: 'task.create', entity: 'tasks', entityId: id, after: task });
    return { ok: true, task };
  });

  // 查询：?q=&category=&is_done=&from=&to=&page=&page_size=（关键词/分类/日期区间/分页）
  // 默认未完成（is_done 缺省 false，applied 回显）；返回 { items, total, page, page_size, applied }。
  app.get('/api/v1/tasks', { preHandler: requireBoundPerson }, async (req) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num((req.query as Record<string, unknown>).account_id));
    const q = req.query as Record<string, string | undefined>;
    return listTasks(db, accountId, {
      is_done: q.is_done === undefined ? undefined : q.is_done === '1' || q.is_done === 'true',
      category: q.category,
      q: q.q,
      from: q.from,
      to: q.to,
      page: q.page !== undefined ? Number(q.page) : undefined,
      page_size: q.page_size !== undefined ? Number(q.page_size) : undefined,
    });
  });

  // ── 全量宽过滤查询/导出（读工具标准形态：强大查询 + 自验证输出）──
  // format=json 默认 → { total, applied(生效筛选回显), items }，全量无分页；
  // format=csv → text/csv（UTF-8 BOM + 防公式注入）。
  app.get('/api/v1/tasks/export', { preHandler: requireBoundPerson }, async (req, reply) => {
    const personId = me(req);
    const accountId = resolveAccountId(db, personId, num((req.query as Record<string, unknown>).account_id));
    const q = req.query as Record<string, string | undefined>;
    const filter: TaskListQuery = {
      is_done: q.is_done === undefined ? undefined : q.is_done === '1' || q.is_done === 'true',
      category: q.category,
      q: q.q,
      from: q.from,
      to: q.to,
    };

    const tasks = exportTasks(db, accountId, filter);

    // 回显实际生效的筛选（供 LLM 自验证）
    const applied: Record<string, string | number | boolean> = { account_id: accountId };
    if (filter.is_done !== undefined) applied.is_done = filter.is_done;
    if (filter.category) applied.category = filter.category;
    if (filter.q?.trim()) applied.q = filter.q.trim();
    if (filter.from) applied.from = filter.from;
    if (filter.to) applied.to = filter.to;

    if (q.format === 'csv') {
      const csv = buildTaskCsv(tasks);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="tasks-export.csv"');
      return reply.send(`﻿${csv}`);
    }
    return { total: tasks.length, applied, items: tasks };
  });

  // 改内容/分类/提醒时间
  app.patch('/api/v1/tasks/:id', { preHandler: requireBoundPerson }, async (req) => {
    const task = requireVisibleTask(req);
    const body = req.body as Record<string, unknown>;
    const updated = updateTask(db, task.id, {
      content: typeof body.content === 'string' ? body.content : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      remind_at: body.remind_at !== undefined ? body.remind_at : undefined,
      linked_bill_id: typeof body.linked_bill_id === 'number' ? body.linked_bill_id : undefined,
    })!;
    logOperation(db, { personId: me(req), accountId: task.account_id, action: 'task.update', entity: 'tasks', entityId: task.id, before: task, after: updated });
    return { ok: true, task: updated };
  });

  // 标记完成
  app.post('/api/v1/tasks/:id/done', { preHandler: requireBoundPerson }, async (req) => {
    const task = requireVisibleTask(req);
    const updated = setTaskDone(db, task.id, true)!;
    logOperation(db, { personId: me(req), accountId: task.account_id, action: 'task.done', entity: 'tasks', entityId: task.id, after: updated });
    return { ok: true, task: updated };
  });

  // 取消完成
  app.post('/api/v1/tasks/:id/undo', { preHandler: requireBoundPerson }, async (req) => {
    const task = requireVisibleTask(req);
    const updated = setTaskDone(db, task.id, false)!;
    return { ok: true, task: updated };
  });

  // 软删除
  app.delete('/api/v1/tasks/:id', { preHandler: requireBoundPerson }, async (req) => {
    const task = requireVisibleTask(req);
    softDeleteTask(db, task.id);
    logOperation(db, { personId: me(req), accountId: task.account_id, action: 'task.delete', entity: 'tasks', entityId: task.id, before: task });
    return { ok: true, deleted: true };
  });

  // ── 私有辅助 ──

  function num(v: unknown): number | undefined {
    return typeof v === 'string' && v !== '' ? Number(v) : undefined;
  }

  /** 取路由 :id 对应的一条未删除任务，并校验当前 person 对所在账户有访问权。 */
  function requireVisibleTask(req: FastifyRequest) {
    const personId = me(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'INVALID_ID', 'id 非法');
    const task = getTask(db, id);
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', '任务不存在或已删除');
    resolveAccountId(db, personId, task.account_id); // 越权抛 403
    return task;
  }
}
