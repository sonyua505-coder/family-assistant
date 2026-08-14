/**
 * 表注册机制（内部 · 泛化后端，对应设计文档 §4.14 / ADR D16）。
 *
 * 新增特化模块（如工作记账）= 声明 schema 描述符 → 注册 → 自动建表 + 生成通用 CRUD，
 * 核心零改动。描述符持久化到 registered_tables，重启后 loadPersisted() 恢复。
 *
 * 内部接口，不对用户开放：HTTP 层在 src/modules/internal/routes.ts，需独立 ADMIN_KEY。
 */
import type Database from 'better-sqlite3';

export type SqlType = 'INTEGER' | 'TEXT' | 'REAL';
type DefaultValue = string | number | boolean | { sql: string };

export interface ColumnDef {
  type: SqlType;
  notNull?: boolean;
  /** 字面量默认值；{ sql } 形式表达原生 SQL（如 datetime('now','localtime')） */
  default?: DefaultValue;
  primaryKey?: boolean;
  autoincrement?: boolean;
  unique?: boolean;
  references?: { table: string; column?: string };
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique?: boolean;
  where?: string;
}

export interface TableDescriptor {
  name: string;
  columns: Record<string, ColumnDef>;
  indexes?: IndexDef[];
  /** true 时自动追加 is_deleted/deleted_at，delete() 变软删除、list() 默认过滤已删 */
  softDelete?: boolean;
}

export interface CrudApi<T extends Record<string, unknown> = Record<string, unknown>> {
  insert(data: Partial<T> & { id?: number }): number;
  getById(id: number): (T & { id: number }) | undefined;
  list(filter?: Partial<T> & { limit?: number; offset?: number; includeDeleted?: boolean }): (T & { id: number })[];
  update(id: number, data: Partial<T>): void;
  delete(id: number): void;
  count(filter?: Partial<T>): number;
  exists(id: number): boolean;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_TYPES: SqlType[] = ['INTEGER', 'TEXT', 'REAL'];

/** 校验/归一化外部传入的描述符（HTTP body 或内部调用），非法时抛出带原因的 Error。 */
export function normalizeDescriptor(input: unknown): TableDescriptor {
  if (typeof input !== 'object' || input === null) throw new Error('描述符必须是对象');
  const raw = input as Record<string, unknown>;

  const name = raw.name;
  if (typeof name !== 'string' || !IDENT_RE.test(name)) throw new Error(`非法表名: ${String(name)}`);

  if (typeof raw.columns !== 'object' || raw.columns === null) throw new Error('缺少 columns 对象');
  const columns: Record<string, ColumnDef> = {};
  for (const [key, value] of Object.entries(raw.columns as Record<string, unknown>)) {
    if (!IDENT_RE.test(key)) throw new Error(`非法字段名: ${key}`);
    columns[key] = normalizeColumn(key, value);
  }
  if (Object.keys(columns).length === 0) throw new Error('至少需要一个字段');

  // 约定主键：自动注入 id INTEGER PRIMARY KEY AUTOINCREMENT（未显式声明时）
  if (columns.id) {
    const idCol = columns.id;
    if (idCol.type !== 'INTEGER' || !idCol.primaryKey) {
      throw new Error('显式声明的 id 字段必须是 INTEGER PRIMARY KEY');
    }
  } else {
    columns.id = { type: 'INTEGER', primaryKey: true, autoincrement: true };
  }

  const indexes: IndexDef[] = [];
  if (raw.indexes !== undefined) {
    if (!Array.isArray(raw.indexes)) throw new Error('indexes 必须是数组');
    for (const item of raw.indexes) {
      if (typeof item !== 'object' || item === null) throw new Error('非法 index 定义');
      const i = item as Record<string, unknown>;
      if (typeof i.name !== 'string' || !IDENT_RE.test(i.name)) throw new Error(`非法 index 名: ${String(i.name)}`);
      if (
        !Array.isArray(i.columns) ||
        i.columns.length === 0 ||
        !i.columns.every((c) => typeof c === 'string' && IDENT_RE.test(c))
      ) {
        throw new Error(`index ${String(i.name)} 的 columns 非法`);
      }
      indexes.push({
        name: i.name,
        columns: i.columns as string[],
        unique: i.unique === true,
        where: typeof i.where === 'string' ? i.where : undefined,
      });
    }
  }

  const desc: TableDescriptor = { name, columns, indexes, softDelete: raw.softDelete === true };
  if (desc.softDelete && columns.is_deleted) throw new Error('softDelete 表不得手动声明 is_deleted 列');
  if (desc.softDelete && columns.deleted_at) throw new Error('softDelete 表不得手动声明 deleted_at 列');
  return desc;
}

function normalizeColumn(key: string, input: unknown): ColumnDef {
  if (typeof input === 'string') {
    if (!SQL_TYPES.includes(input as SqlType)) throw new Error(`字段 ${key} 类型非法: ${input}`);
    return { type: input as SqlType };
  }
  if (typeof input !== 'object' || input === null) throw new Error(`字段 ${key} 定义非法`);
  const raw = input as Record<string, unknown>;

  const type = raw.type;
  if (typeof type !== 'string' || !SQL_TYPES.includes(type as SqlType)) throw new Error(`字段 ${key} 缺少合法 type`);

  const col: ColumnDef = { type: type as SqlType };
  if (raw.notNull !== undefined) col.notNull = raw.notNull === true;
  if (raw.primaryKey !== undefined) col.primaryKey = raw.primaryKey === true;
  if (raw.autoincrement !== undefined) col.autoincrement = raw.autoincrement === true;
  if (raw.unique !== undefined) col.unique = raw.unique === true;

  if (raw.default !== undefined) {
    const d = raw.default;
    if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') col.default = d;
    else if (typeof d === 'object' && d !== null && typeof (d as Record<string, unknown>).sql === 'string') {
      col.default = { sql: (d as Record<string, unknown>).sql as string };
    } else throw new Error(`字段 ${key} 的 default 非法`);
  }

  if (raw.references !== undefined) {
    const r = raw.references as Record<string, unknown>;
    if (typeof r !== 'object' || r === null || typeof r.table !== 'string') throw new Error(`字段 ${key} 的 references 非法`);
    col.references = { table: r.table, column: typeof r.column === 'string' ? r.column : undefined };
  }

  if (col.autoincrement && (!col.primaryKey || col.type !== 'INTEGER')) {
    throw new Error(`字段 ${key} 的 autoincrement 必须配合 INTEGER PRIMARY KEY`);
  }
  return col;
}

function effectiveColumns(desc: TableDescriptor): Record<string, ColumnDef> {
  const cols = { ...desc.columns };
  if (desc.softDelete) {
    cols.is_deleted = { type: 'INTEGER', notNull: true, default: 0 };
    cols.deleted_at = { type: 'TEXT' };
  }
  return cols;
}

function renderDefault(d: DefaultValue): string {
  if (typeof d === 'object' && d !== null && 'sql' in d) return d.sql;
  if (typeof d === 'string') return `'${d.replaceAll("'", "''")}'`;
  return String(d);
}

function buildCreateSql(desc: TableDescriptor): { table: string; extra: string[] } {
  const parts: string[] = [];
  for (const [key, c] of Object.entries(effectiveColumns(desc))) {
    const p: string[] = [`"${key}"`, c.type];
    if (c.primaryKey) p.push('PRIMARY KEY');
    if (c.autoincrement) p.push('AUTOINCREMENT');
    if (c.notNull) p.push('NOT NULL');
    if (c.unique) p.push('UNIQUE');
    if (c.default !== undefined) p.push(`DEFAULT ${renderDefault(c.default)}`);
    if (c.references) p.push(`REFERENCES "${c.references.table}"(${c.references.column ?? 'id'})`);
    parts.push(p.join(' '));
  }
  const table = `CREATE TABLE IF NOT EXISTS "${desc.name}" (${parts.join(', ')})`;
  const extra = (desc.indexes ?? []).map((idx) => {
    const cols = idx.columns.map((c) => `"${c}"`).join(', ');
    const where = idx.where ? ` WHERE ${idx.where}` : '';
    return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${idx.name}" ON "${desc.name}" (${cols})${where}`;
  });
  return { table, extra };
}

export class TableRegistry {
  private db: Database.Database;
  private descriptors = new Map<string, TableDescriptor>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** 启动时从 registered_tables 载入历史注册的描述符并幂等建表，返回载入条数。 */
  loadPersisted(): number {
    const rows = this.db.prepare('SELECT name, descriptor FROM registered_tables').all() as {
      name: string;
      descriptor: string;
    }[];
    for (const row of rows) {
      try {
        const desc = normalizeDescriptor(JSON.parse(row.descriptor));
        this.ensureTable(desc);
        this.descriptors.set(desc.name, desc);
      } catch (err) {
        // 历史描述符损坏不阻断启动，仅告警
        console.warn(`[registry] 忽略损坏的描述符 ${row.name}: ${(err as Error).message}`);
      }
    }
    return rows.length;
  }

  /** 注册（或覆盖同名）表：建表 + 建索引 + 持久化描述符。 */
  register(desc: TableDescriptor): void {
    const normalized = normalizeDescriptor(desc);
    this.ensureTable(normalized);
    this.descriptors.set(normalized.name, normalized);
    this.db
      .prepare(
        `INSERT INTO registered_tables (name, descriptor) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET descriptor = excluded.descriptor, updated_at = datetime('now','localtime')`,
      )
      .run(normalized.name, JSON.stringify(normalized));
  }

  /** 注销：从注册表移除（generic CRUD 停止服务），实际数据表保留在磁盘。 */
  unregister(name: string): boolean {
    if (!this.descriptors.has(name)) return false;
    this.descriptors.delete(name);
    this.db.prepare('DELETE FROM registered_tables WHERE name = ?').run(name);
    return true;
  }

  get(name: string): TableDescriptor | undefined {
    return this.descriptors.get(name);
  }

  list(): TableDescriptor[] {
    return [...this.descriptors.values()];
  }

  isRegistered(name: string): boolean {
    return this.descriptors.has(name);
  }

  /** 取已注册表的通用 CRUD。 */
  crud<T extends Record<string, unknown> = Record<string, unknown>>(name: string): CrudApi<T> {
    const desc = this.descriptors.get(name);
    if (!desc) throw new Error(`表未注册: ${name}`);
    return createCrud<T>(this.db, desc);
  }

  private ensureTable(desc: TableDescriptor): void {
    const { table, extra } = buildCreateSql(desc);
    this.db.exec(table);
    for (const sql of extra) this.db.exec(sql);
  }
}

function createCrud<T extends Record<string, unknown>>(db: Database.Database, desc: TableDescriptor): CrudApi<T> {
  const table = desc.name;
  const cols = Object.keys(effectiveColumns(desc));
  const soft = !!desc.softDelete;

  const rowOut = (row: Record<string, unknown>) => ({ id: Number(row.id), ...row }) as unknown as T & { id: number };

  function whereClause(filter: Record<string, unknown>): { sql: string; args: unknown[] } {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (soft && filter.includeDeleted !== true) conds.push('is_deleted = 0');
    for (const [k, v] of Object.entries(filter)) {
      if (k === 'limit' || k === 'offset' || k === 'includeDeleted' || v === undefined) continue;
      if (!cols.includes(k)) continue;
      conds.push(`"${k}" = ?`);
      args.push(v);
    }
    return { sql: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', args };
  }

  return {
    insert(data) {
      const keys = Object.keys(data).filter((k) => cols.includes(k));
      if (keys.length === 0) throw new Error(`insert ${table}: 无有效字段`);
      const placeholders = keys.map(() => '?').join(', ');
      const info = db
        .prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})`)
        .run(...keys.map((k) => data[k] as unknown));
      return Number(info.lastInsertRowid);
    },
    getById(id) {
      const row = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      return row ? rowOut(row) : undefined;
    },
    list(filter = {}) {
      const { limit, offset } = filter as { limit?: number; offset?: number };
      const { sql, args } = whereClause(filter as Record<string, unknown>);
      let query = `SELECT * FROM "${table}"${sql}`;
      if (limit !== undefined) {
        query += ' LIMIT ?';
        args.push(limit);
      }
      if (offset !== undefined) {
        query += ' OFFSET ?';
        args.push(offset);
      }
      return (db.prepare(query).all(...args) as Record<string, unknown>[]).map(rowOut);
    },
    update(id, data) {
      const keys = Object.keys(data).filter((k) => cols.includes(k) && k !== 'id');
      if (keys.length === 0) return;
      const set = keys.map((k) => `"${k}" = ?`).join(', ');
      db.prepare(`UPDATE "${table}" SET ${set} WHERE id = ?`).run(...keys.map((k) => data[k] as unknown), id);
    },
    delete(id) {
      if (soft) {
        db.prepare(
          `UPDATE "${table}" SET is_deleted = 1, deleted_at = datetime('now','localtime') WHERE id = ?`,
        ).run(id);
      } else {
        db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
      }
    },
    count(filter = {}) {
      const { sql, args } = whereClause(filter as Record<string, unknown>);
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"${sql}`).get(...args) as { n: number };
      return row.n;
    },
    exists(id) {
      const row = db.prepare(`SELECT 1 AS x FROM "${table}" WHERE id = ?`).get(id) as { x: number } | undefined;
      return !!row;
    },
  };
}
