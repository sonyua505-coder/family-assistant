/**
 * 用户记忆数据访问层（M4，对应设计文档 §4.12 / §5.6 / ADR D13）。
 *
 * 设计：零散记忆按当前用户隔离（强制 person_id 过滤），BOT 按需检索（不每次注入上下文）。
 * 检索用 SQLite FTS5（trigram 分词器，支持中文子串）；<3 字符的查询回退 LIKE。
 * 注意：FTS5 是独立虚拟表，插入/删除必须手动同步，否则搜不到或残留。
 */
import type Database from 'better-sqlite3';

export interface MemoryRow {
  id: number;
  person_id: number;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
}

/** 建一条记忆（同时同步进 FTS 表），返回新 id。 */
export function createMemory(db: Database.Database, personId: number, content: string, category?: string): number {
  const info = db
    .prepare('INSERT INTO user_memories (person_id, content, category) VALUES (?, ?, ?)')
    .run(personId, content, category ?? 'general');
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO user_memories_fts (rowid, person_id, content) VALUES (?, ?, ?)').run(id, personId, content);
  return id;
}

/** 删一条记忆（同步删 FTS）。返回是否真的删到。 */
export function deleteMemory(db: Database.Database, id: number, personId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM user_memories WHERE id = ? AND person_id = ?')
    .get(id, personId);
  if (!row) return false;
  db.prepare('DELETE FROM user_memories_fts WHERE rowid = ?').run(id);
  db.prepare('DELETE FROM user_memories WHERE id = ?').run(id);
  return true;
}

/**
 * 检索当前用户的记忆：
 *  - q 非空且长度 >= 3 → FTS5 trigram MATCH（子串匹配，含中文）
 *  - q 非空但 < 3 字符 → LIKE '%q%'（trigram 最少 3 字符，短词走 LIKE）
 *  - q 为空 → 按 category / 时间列出最近
 * 一律按 person_id 强制隔离。
 */
export function searchMemories(
  db: Database.Database,
  personId: number,
  q?: string,
  category?: string,
): MemoryRow[] {
  const catCond = category && category.trim() ? 'AND category = ?' : '';
  const catArgs: unknown[] = category && category.trim() ? [category] : [];

  if (q && q.trim()) {
    const term = q.trim();
    if (term.length >= 3) {
      // 转成 FTS 安全查询串：每 token 加引号防注入 FTS 语法，AND 连接
      const query = tokenize(term)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' AND ');
      if (!query) return [];
      return db
        .prepare(
          `SELECT um.* FROM user_memories_fts f
           JOIN user_memories um ON um.rowid = f.rowid
           WHERE user_memories_fts MATCH ? AND f.person_id = ?
           ${catCond}
           ORDER BY um.updated_at DESC`,
        )
        .all(query, personId, ...catArgs) as MemoryRow[];
    }
    // 短词走 LIKE（escaping LIKE 通配符）
    const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    return db
      .prepare(
        `SELECT * FROM user_memories
         WHERE person_id = ? AND content LIKE '%' || ? || '%' ESCAPE '\\'
         ${catCond}
         ORDER BY updated_at DESC`,
      )
      .all(personId, escaped, ...catArgs) as MemoryRow[];
  }

  return db
    .prepare(`SELECT * FROM user_memories WHERE person_id = ? ${catCond} ORDER BY updated_at DESC LIMIT 50`)
    .all(personId, ...catArgs) as MemoryRow[];
}

/** 把查询串拆成检索 token（按空白拆分）。 */
function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

/** 供测试/上层确认 FTS 表状态。 */
export function ftsCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) n FROM user_memories_fts').get() as { n: number }).n;
}
