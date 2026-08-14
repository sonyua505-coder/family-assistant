/**
 * 记账账户数据访问层（M1，对应设计文档 §4.3 / §4.4 / ADR D18）。
 *
 * 账户分两类，互不互通：
 *  - personal（个人账本）：只属 owner 一人，不建成员表（owner 隐含）。
 *  - family（家庭账本）：owner 自动成为成员，他人可 join 加入，全家共享。
 */
import type Database from 'better-sqlite3';

export interface AccountRow {
  id: number;
  type: string;              // 'personal' | 'family'
  name: string;
  owner_person_id: number;
  created_at: string;
}

export interface AccountMemberRow {
  account_id: number;
  person_id: number;
  role: string;              // 'owner' | 'member'
  created_at: string;
}

/**
 * 建账户。type='family' 时自动给 owner 插入一条 role='owner' 的成员行
 * （family 账户的归属都从 account_members 判断，所以 owner 也要有成员行）。
 * 返回新账户 id。
 */
export function createAccount(
  db: Database.Database,
  input: { type: 'personal' | 'family'; name: string; ownerPersonId: number },
): number {
  const info = db
    .prepare('INSERT INTO accounts (type, name, owner_person_id) VALUES (?, ?, ?)')
    .run(input.type, input.name, input.ownerPersonId);
  const accountId = Number(info.lastInsertRowid);
  if (input.type === 'family') {
    db.prepare('INSERT INTO account_members (account_id, person_id, role) VALUES (?, ?, ?)').run(
      accountId,
      input.ownerPersonId,
      'owner',
    );
  }
  return accountId;
}

/** 取单个账户；不存在返回 undefined。 */
export function getAccount(db: Database.Database, accountId: number): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
}

/**
 * 列出某 person 可见的全部账户及其角色：
 *  - personal：本人 owner（从 owner_person_id 判断）
 *  - family：经 account_members 是成员（含 owner）
 */
export function listAccountsForPerson(
  db: Database.Database,
  personId: number,
): (AccountRow & { role: string })[] {
  return db
    .prepare(
      `SELECT a.*, 'owner' AS role FROM accounts a WHERE a.owner_person_id = ? AND a.type = 'personal'
       UNION ALL
       SELECT a.*, m.role FROM accounts a JOIN account_members m ON m.account_id = a.id
         WHERE m.person_id = ? AND a.type = 'family'
       ORDER BY id`,
    )
    .all(personId, personId) as (AccountRow & { role: string })[];
}

/** 某 person 是否 family 账户的成员。 */
export function isAccountMember(db: Database.Database, accountId: number, personId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM account_members WHERE account_id = ? AND person_id = ?')
    .get(accountId, personId);
  return !!row;
}

/** 某 person 是否某账户的 owner。 */
export function isAccountOwner(db: Database.Database, accountId: number, personId: number): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM accounts WHERE id = ? AND owner_person_id = ?')
    .get(accountId, personId);
  return !!row;
}

/** family 账户的全部成员（含 owner）。 */
export function getFamilyMembers(db: Database.Database, accountId: number): AccountMemberRow[] {
  return db
    .prepare('SELECT * FROM account_members WHERE account_id = ? ORDER BY role, created_at')
    .all(accountId) as AccountMemberRow[];
}

/** 把 person 加为 family 账户成员（INSERT OR IGNORE：已是成员则静默跳过）。 */
export function addFamilyMember(db: Database.Database, accountId: number, personId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO account_members (account_id, person_id, role) VALUES (?, ?, ?)',
  ).run(accountId, personId, 'member');
}

/**
 * 按"引用"解析账户（join_account 用）：
 *  - 数字 → account id
 *  - 字符串 → name 精确匹配；同名多个返回 'ambiguous'
 *  - 其余 → undefined
 */
export function resolveAccountRef(
  db: Database.Database,
  ref: unknown,
): AccountRow | 'ambiguous' | undefined {
  if (typeof ref === 'number' && Number.isInteger(ref)) {
    return getAccount(db, ref);
  }
  if (typeof ref === 'string' && ref.length > 0) {
    const rows = db.prepare('SELECT * FROM accounts WHERE name = ?').all(ref) as AccountRow[];
    if (rows.length === 0) return undefined;
    if (rows.length > 1) return 'ambiguous';
    return rows[0]!;
  }
  return undefined;
}
