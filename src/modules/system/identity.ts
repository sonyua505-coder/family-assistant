/**
 * 身份与自然人（person）的数据访问层（M1，对应设计文档 §4.1 / §4.2 / §5.8）。
 *
 * 概念澄清：
 *  - person（自然人）：真实的人，如"张三"。必须创建。
 *  - person_identities（平台身份）：某人名下的某个平台账号，
 *    如 张三 = QQ(openid_1) + 微信(openid_2)。一个人可挂多个平台身份。
 *  - is_primary（主平台）：最早绑定（创建端）的身份置 1，可改。
 */
import type Database from 'better-sqlite3';

export interface PersonRow {
  id: number;
  display_name: string;   // 数据稳定名（账单/AA/任务里显示，创建时定，少改）
  nickname: string;       // BOT 聊天称呼（空则回落 display_name）
  profile_text: string;   // 画像文本（仅 QQ 端注入）
  disabled: number;       // 应急禁用标志 0/1
  created_at: string;
  updated_at: string;
}

export interface PersonIdentityRow {
  platform: string;       // 'wechat' | 'qq'
  openid: string;
  person_id: number;
  is_primary: number;     // 1=主平台
  created_at: string;
}

/**
 * 按注入身份解析 person。
 * 查 person_identities 联 persons，命中返回 person_id + 禁用状态；未绑定返回 null。
 */
export function resolveIdentityByPlatform(
  db: Database.Database,
  platform: string,
  openid: string,
): { person_id: number; disabled: boolean } | null {
  const row = db
    .prepare(
      `SELECT pi.person_id, p.disabled
       FROM person_identities pi
       JOIN persons p ON p.id = pi.person_id
       WHERE pi.platform = ? AND pi.openid = ?`,
    )
    .get(platform, openid) as { person_id: number; disabled: number } | undefined;
  return row ? { person_id: row.person_id, disabled: row.disabled === 1 } : null;
}

/** 取单个 person；不存在返回 undefined。 */
export function getPerson(db: Database.Database, personId: number): PersonRow | undefined {
  return db.prepare('SELECT * FROM persons WHERE id = ?').get(personId) as PersonRow | undefined;
}

/**
 * 取某 person 的全部已绑平台身份（按绑定先后排序）。
 * 注意：person_identities 表没有自增 id 列（主键是 (platform, openid) 唯一键），
 * 所以排序用 created_at + platform/openid 作 tiebreaker，绝不能用 id。
 */
export function getPersonIdentities(db: Database.Database, personId: number): PersonIdentityRow[] {
  return db
    .prepare('SELECT * FROM person_identities WHERE person_id = ? ORDER BY created_at, platform, openid')
    .all(personId) as PersonIdentityRow[];
}

/** 新建 person（display_name / nickname 缺省为空串）。返回新 id。 */
export function createPerson(
  db: Database.Database,
  input: { display_name?: string; nickname?: string },
): number {
  const info = db
    .prepare('INSERT INTO persons (display_name, nickname) VALUES (?, ?)')
    .run(input.display_name ?? '', input.nickname ?? '');
  return Number(info.lastInsertRowid);
}

/** 该平台身份是否已绑定过任何人。 */
export function isIdentityBound(db: Database.Database, platform: string, openid: string): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM person_identities WHERE platform = ? AND openid = ?')
    .get(platform, openid);
  return !!row;
}

/** 绑定一个平台身份到 person。isPrimary=true 时作为主平台（创建人场景）。 */
export function bindIdentity(
  db: Database.Database,
  platform: string,
  openid: string,
  personId: number,
  isPrimary: boolean,
): void {
  db.prepare(
    'INSERT INTO person_identities (platform, openid, person_id, is_primary) VALUES (?, ?, ?, ?)',
  ).run(platform, openid, personId, isPrimary ? 1 : 0);
}

/** 解绑某身份。返回是否真的删到了（false=该身份不属于该 person）。 */
export function unlinkIdentity(
  db: Database.Database,
  platform: string,
  openid: string,
  personId: number,
): boolean {
  const info = db
    .prepare('DELETE FROM person_identities WHERE platform = ? AND openid = ? AND person_id = ?')
    .run(platform, openid, personId);
  return info.changes > 0;
}

/** 设某身份为该 person 的主平台（其余置 0），在事务内完成。 */
export function setPrimaryIdentity(
  db: Database.Database,
  personId: number,
  platform: string,
  openid: string,
): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE person_identities SET is_primary = 0 WHERE person_id = ?').run(personId);
    db.prepare(
      'UPDATE person_identities SET is_primary = 1 WHERE person_id = ? AND platform = ? AND openid = ?',
    ).run(personId, platform, openid);
  });
  tx();
}

/**
 * 按"引用"解析 person（bind_person 用）：
 *  - 数字 → person id
 *  - 字符串 → display_name 精确匹配；同名多个返回 'ambiguous'（调用方需报歧义）
 *  - 其余 → undefined
 */
export function resolvePersonRef(
  db: Database.Database,
  ref: unknown,
): PersonRow | 'ambiguous' | undefined {
  if (typeof ref === 'number' && Number.isInteger(ref)) {
    return getPerson(db, ref);
  }
  if (typeof ref === 'string' && ref.length > 0) {
    const rows = db.prepare('SELECT * FROM persons WHERE display_name = ?').all(ref) as PersonRow[];
    if (rows.length === 0) return undefined;
    if (rows.length > 1) return 'ambiguous';
    return rows[0]!;
  }
  return undefined;
}
