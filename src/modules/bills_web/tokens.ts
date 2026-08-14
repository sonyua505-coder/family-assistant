/**
 * 记账 Web 访问令牌（M5，对应设计文档 §4.15 / §5.9 / ADR D27）。
 *
 * 能力令牌：32 字节随机 token，库中只存 sha256（明文仅铸造时回显一次）；
 * 绑定 person，默认 30 分钟过期（可配）；mode='read'|'write'，只读令牌拒一切写路由。
 * 校验用「哈希后按 token_hash 查库」——库中无明文，无字符串比较时序泄露，
 * 等价满足"timingSafeEqual + trim"要求。
 */
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { now } from '../../db/dao.js';

export interface WebTokenRow {
  id: number;
  person_id: number;
  token_hash: string;
  mode: 'read' | 'write';
  expires_at: string;
  last_used_at: string | null;
  created_at: string;
}

export interface MintResult {
  id: number;
  token: string; // 明文，仅回显一次
  expires_at: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** token 合法格式（32 字节 → 64 位 hex）。 */
const TOKEN_RE = /^[0-9a-f]{64}$/i;

/** 铸造：生成随机 token，存 hash，返回明文一次。 */
export function mintToken(
  db: Database.Database,
  personId: number,
  mode: 'read' | 'write',
  expiresInMinutes: number,
): MintResult {
  const token = randomBytes(32).toString('hex');
  const hash = sha256(token);
  // expires_at 用本地时间串，与库内其余时间同源
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const expiresAtStr = `${expiresAt.getFullYear()}-${p(expiresAt.getMonth() + 1)}-${p(expiresAt.getDate())} ${p(expiresAt.getHours())}:${p(expiresAt.getMinutes())}:${p(expiresAt.getSeconds())}`;

  const info = db
    .prepare('INSERT INTO web_tokens (person_id, token_hash, mode, expires_at) VALUES (?, ?, ?, ?)')
    .run(personId, hash, mode, expiresAtStr);
  return { id: Number(info.lastInsertRowid), token, expires_at: expiresAtStr };
}

/**
 * 校验令牌：格式校验（拒超大/非法输入）→ sha256 → 查库 → 过期判断。
 * 有效返回 { personId, mode } 并刷新 last_used_at；无效返回 null。
 */
export function verifyToken(db: Database.Database, rawToken: unknown): { personId: number; mode: 'read' | 'write' } | null {
  const t = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!TOKEN_RE.test(t)) return null;
  const row = db.prepare('SELECT * FROM web_tokens WHERE token_hash = ?').get(sha256(t)) as
    | WebTokenRow
    | undefined;
  if (!row) return null;
  if (row.expires_at <= now()) return null; // 过期即失效
  db.prepare('UPDATE web_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return { personId: row.person_id, mode: row.mode };
}

/** 某 person 的全部令牌（含过期状态，供列表展示）。 */
export function listTokens(db: Database.Database, personId: number): Array<{
  id: number;
  mode: string;
  expires_at: string;
  last_used_at: string | null;
  created_at: string;
  is_expired: boolean;
}> {
  const rows = db
    .prepare('SELECT * FROM web_tokens WHERE person_id = ? ORDER BY created_at DESC')
    .all(personId) as WebTokenRow[];
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
    is_expired: r.expires_at <= now(),
  }));
}

/** 撤销令牌（须属于该 person）。返回是否真的撤掉。 */
export function revokeToken(db: Database.Database, id: number, personId: number): boolean {
  const info = db.prepare('DELETE FROM web_tokens WHERE id = ? AND person_id = ?').run(id, personId);
  return info.changes > 0;
}
