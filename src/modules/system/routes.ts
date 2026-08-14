/**
 * system 模块路由。
 *
 * M0：settings 键值读写。
 * M1：身份与账户（对应设计文档 §5.8）——
 *   persons / person_identities / accounts / account_members + 身份注入。
 *
 * 统一约定：
 *  - 所有业务接口先过 onAuth（X-API-Key 鉴权），再按需过身份钩子。
 *  - 身份钩子从请求头 x-platform / x-openid 解析 person（由插件注入，不靠 LLM 猜）。
 *  - requireIdentity    未绑定也放行（建人/绑人前，引导用）。
 *  - requireBoundPerson 必须已绑定（业务操作）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { requireApiKey } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import type { createIdentityHooks } from '../../lib/identity.js';
import { getAllSettings, setSetting } from './settings.js';
import {
  createPerson,
  getPerson,
  getPersonIdentities,
  isIdentityBound,
  bindIdentity,
  unlinkIdentity,
  setPrimaryIdentity,
} from './identity.js';
import {
  createAccount,
  getAccount,
  listAccountsForPerson,
  getFamilyMembers,
  addFamilyMember,
} from './accounts.js';
import { enqueue } from '../outbox/index.js';

export interface SystemRouteDeps {
  db: Database.Database;
  apiKey: string;
  /** createIdentityHooks 的返回值：{ requireIdentity, requireBoundPerson } */
  identity: ReturnType<typeof createIdentityHooks>;
}

export async function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): Promise<void> {
  const { db, apiKey, identity } = deps;
  const onAuth = requireApiKey(apiKey);
  const { requireIdentity, requireBoundPerson } = identity;

  // ──────────────────────────────────────────────
  // settings（M0）
  // ──────────────────────────────────────────────

  // 读全部配置：返回 { key: value } 对象
  app.get('/api/v1/system/settings', { preHandler: onAuth }, async () => getAllSettings(db));

  // 写单个配置：body { key, value }（二期网页管理用，本期 API 预留）
  app.patch('/api/v1/system/settings', { preHandler: onAuth }, async (req) => {
    const body = req.body as { key?: unknown; value?: unknown };
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof body.key !== 'string' ||
      body.key.length === 0 ||
      typeof body.value !== 'string'
    ) {
      throw new AppError(400, 'INVALID_BODY', 'body 需 { key: string, value: string }');
    }
    setSetting(db, body.key, body.value);
    return { ok: true, key: body.key };
  });

  // ──────────────────────────────────────────────
  // 身份查询（M1）—— 工具 get_my_identity
  // ──────────────────────────────────────────────

  // 返回当前注入身份的绑定状态与 person 信息。
  // 未绑定也放行（bound:false），让 BOT 据此引导 create_person / bind_person。
  const identityHandler = async (req: FastifyRequest) => {
    const id = req.identity!;
    if (id.personId === null) {
      return { platform: id.platform, openid: id.openid, bound: false, person: null, accounts: [] };
    }
    const person = getPerson(db, id.personId)!;
    const identities = getPersonIdentities(db, id.personId);
    const primary = identities.find((i) => i.is_primary === 1);
    const accounts = listAccountsForPerson(db, id.personId);
    return {
      platform: id.platform,
      openid: id.openid,
      bound: true,
      person: {
        id: person.id,
        display_name: person.display_name,
        nickname: person.nickname,
        disabled: person.disabled === 1,
        identities: identities.map((i) => ({
          platform: i.platform,
          openid: i.openid,
          is_primary: i.is_primary === 1,
        })),
        primary: primary ? { platform: primary.platform, openid: primary.openid } : null,
      },
      accounts: accounts.map((a) => accountSummary(db, a.id, a.role)),
    };
  };
  // §5.5 供插件调试的 /system/identity 与 §5.8 工具用的 /identity 返回同一份数据
  app.get('/api/v1/identity', { preHandler: [onAuth, requireIdentity] }, identityHandler);
  app.get('/api/v1/system/identity', { preHandler: [onAuth, requireIdentity] }, identityHandler);

  // ──────────────────────────────────────────────
  // 创建 person（M1）—— 工具 create_person，首次使用引导
  // ──────────────────────────────────────────────

  // 用当前注入身份创建一个 person 并把该身份绑为主平台（is_primary=1）。
  // 幂等友好：当前身份若已绑定，不报错，直接返回已有 person。
  app.post('/api/v1/persons', { preHandler: [onAuth, requireIdentity] }, async (req) => {
    const id = req.identity!;
    const body = req.body as { display_name?: unknown; nickname?: unknown };

    // 已绑定过：直接返回已有 person（幂等，避免重复建人）
    if (id.personId !== null) {
      const existing = getPerson(db, id.personId)!;
      return {
        ok: true,
        already_bound: true,
        person: { id: existing.id, display_name: existing.display_name, nickname: existing.nickname },
      };
    }

    // 新身份：建 person + 绑定（主平台）
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    const personId = createPerson(db, { display_name: displayName, nickname });
    bindIdentity(db, id.platform, id.openid, personId, true);
    return {
      ok: true,
      already_bound: false,
      person: { id: personId, display_name: displayName, nickname },
    };
  });

  // ──────────────────────────────────────────────
  // 绑定到已有 person（M1）—— 工具 bind_person
  // ──────────────────────────────────────────────

  // 把当前注入身份绑定到一个已存在的 person（如家人把你拉进"我家"）。
  // 绑定即生效（Open Item #13：风险低不做阻塞确认），但会给该 person 所有已绑身份发 outbox 通知，
  // 且本人可 unbind_identity 解除，防冒认。新绑身份 is_primary=0（主平台仍是最早绑定）。
  app.post('/api/v1/persons/:id/bind', { preHandler: [onAuth, requireIdentity] }, async (req) => {
    const id = req.identity!;
    const { id: personIdParam } = req.params as { id: string };
    const personId = Number(personIdParam);

    // 当前身份已绑定过：无需再绑（同一身份不能属于两个人）
    if (id.personId !== null) {
      throw new AppError(409, 'IDENTITY_ALREADY_BOUND', '当前身份已绑定 person，无需再绑');
    }
    if (!Number.isInteger(personId) || personId <= 0) {
      throw new AppError(404, 'PERSON_NOT_FOUND', `person 引用非法: ${personIdParam}`);
    }
    const person = getPerson(db, personId);
    if (!person) throw new AppError(404, 'PERSON_NOT_FOUND', '找不到该 person');

    bindIdentity(db, id.platform, id.openid, person.id, false);
    notifyPersonBound(db, person.id, id.platform, id.openid);
    return {
      ok: true,
      person: { id: person.id, display_name: person.display_name, nickname: person.nickname },
    };
  });

  // ──────────────────────────────────────────────
  // 解绑身份（M1）—— 工具 unbind_identity
  // ──────────────────────────────────────────────

  // 把某平台身份从 person 上解绑。须本人操作（当前身份必须是该 person 的已绑身份）。
  // 不能解绑最后一个身份（否则该 person 将无法被任何端联系）；解绑主平台时自动移交主身份给最早剩余身份。
  app.delete('/api/v1/persons/:id/identities/:platform/:openid', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const id = req.identity!;
    const { id: personIdParam, platform, openid } = req.params as {
      id: string;
      platform: string;
      openid: string;
    };
    const personId = Number(personIdParam);

    // 只能操作自己的 person
    if (!Number.isInteger(personId) || id.personId !== personId) {
      throw new AppError(403, 'FORBIDDEN', '只能操作自己的身份绑定');
    }
    const identities = getPersonIdentities(db, personId);
    const target = identities.find((i) => i.platform === platform && i.openid === openid);
    if (!target) throw new AppError(404, 'IDENTITY_NOT_FOUND', '该身份不属于此 person');
    if (identities.length <= 1) {
      throw new AppError(400, 'CANNOT_UNBIND_LAST', '不能解绑最后一个身份（否则该 person 将无法被联系）');
    }

    const wasPrimary = target.is_primary === 1;
    unlinkIdentity(db, platform, openid, personId);

    // 主身份被解绑：把主身份移交给最早绑定的剩余身份
    if (wasPrimary) {
      const remaining = getPersonIdentities(db, personId);
      const next = remaining[0]!; // 已按 created_at,id 排序，[0] 即最早绑定
      setPrimaryIdentity(db, personId, next.platform, next.openid);
    }
    return { ok: true };
  });

  // ──────────────────────────────────────────────
  // 改主平台（M1）—— 工具 set_primary_identity
  // ──────────────────────────────────────────────

  // 把主平台从当前身份切换到本人名下的另一个平台身份（用于引导提示语优先回哪个端）。
  app.patch('/api/v1/persons/me/primary-identity', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const id = req.identity!;
    const body = req.body as { platform?: unknown; openid?: unknown };
    if (typeof body.platform !== 'string' || typeof body.openid !== 'string') {
      throw new AppError(400, 'INVALID_BODY', 'body 需 { platform, openid }');
    }
    // 目标身份必须是本人名下的已绑身份
    const identities = getPersonIdentities(db, id.personId!);
    const target = identities.find((i) => i.platform === body.platform && i.openid === body.openid);
    if (!target) throw new AppError(404, 'IDENTITY_NOT_FOUND', '目标身份不属于当前 person');

    setPrimaryIdentity(db, id.personId!, body.platform, body.openid);
    return { ok: true, primary: { platform: body.platform, openid: body.openid } };
  });

  // ──────────────────────────────────────────────
  // 画像 / 人设（M4）—— 仅 QQ Agent 每次对话前注入（ADR D13/D23）
  // ──────────────────────────────────────────────

  // 读当前注入身份的画像文本（persons.profile_text）；未绑定返回空串
  app.get('/api/v1/profile', { preHandler: [onAuth, requireIdentity] }, async (req) => {
    const id = req.identity!;
    if (id.personId === null) return { profile_text: '' };
    const person = getPerson(db, id.personId)!;
    return { profile_text: person.profile_text };
  });

  // 设置画像文本（写 persons.profile_text；设计文档未列路由，为可用性补的扩展）
  app.patch('/api/v1/persons/me/profile', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const id = req.identity!;
    const body = req.body as { profile_text?: unknown };
    const text = typeof body.profile_text === 'string' ? body.profile_text : '';
    db.prepare('UPDATE persons SET profile_text = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(text, id.personId!);
    return { ok: true, profile_text: text };
  });

  // ──────────────────────────────────────────────
  // 账户（M1）—— 工具 create_account / list_my_accounts / join_account
  // ──────────────────────────────────────────────

  // 建记账账户。type='personal' 个人账本（只属自己）；type='family' 家庭账本（owner 自动入成员）。
  app.post('/api/v1/accounts', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const id = req.identity!;
    const body = req.body as { type?: unknown; name?: unknown };
    if (typeof body.type !== 'string' || (body.type !== 'personal' && body.type !== 'family')) {
      throw new AppError(400, 'INVALID_ACCOUNT_TYPE', 'type 需为 personal 或 family');
    }
    const name =
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : body.type === 'family'
          ? '我家'
          : '我的账本';
    const accountId = createAccount(db, { type: body.type, name, ownerPersonId: id.personId! });
    return { ok: true, account: accountSummary(db, accountId, 'owner') };
  });

  // 列出当前 person 可见的全部账户（个人/家庭，含角色与成员）
  app.get('/api/v1/accounts', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const id = req.identity!;
    const accounts = listAccountsForPerson(db, id.personId!);
    return { accounts: accounts.map((a) => accountSummary(db, a.id, a.role)) };
  });

  // 加入家庭账户（工具 join_account）。个人账户不可加入；重复加入幂等。
  app.post('/api/v1/accounts/:id/join', { preHandler: [onAuth, requireBoundPerson] }, async (req) => {
    const id = req.identity!;
    const { id: accountIdParam } = req.params as { id: string };
    const accountId = Number(accountIdParam);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `账户引用非法: ${accountIdParam}`);
    }
    const account = getAccount(db, accountId);
    if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '找不到该账户');
    if (account.type !== 'family') {
      throw new AppError(400, 'CANNOT_JOIN_PERSONAL', '个人账户不可加入');
    }
    addFamilyMember(db, accountId, id.personId!);
    return { ok: true, account: accountSummary(db, accountId, 'member') };
  });
}

// ──────────────────────────────────────────────
// 私有辅助函数（本文件内使用）
// ──────────────────────────────────────────────

/**
 * 组装账户的对外展示结构：基本字段 + 当前角色的全部成员列表。
 * family 账户列出全体成员；personal 账户成员即 owner 本人。
 */
function accountSummary(db: Database.Database, accountId: number, role: string) {
  const account = getAccount(db, accountId)!;
  const memberRows =
    account.type === 'family'
      ? getFamilyMembers(db, accountId)
      : [{ account_id: accountId, person_id: account.owner_person_id, role: 'owner' as const }];
  const members = memberRows.map((m) => {
    const p = getPerson(db, m.person_id)!;
    return { id: p.id, display_name: p.display_name, nickname: p.nickname, role: m.role };
  });
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    owner_person_id: account.owner_person_id,
    role,
    members,
  };
}

/**
 * bind_person 后的安全通知（Open Item #13）：给该 person 的所有已绑身份
 * 各写一条 outbox 消息，提示有新身份绑定（防冒认），本人可解绑。
 */
function notifyPersonBound(
  db: Database.Database,
  personId: number,
  newPlatform: string,
  newOpenid: string,
): void {
  const person = getPerson(db, personId);
  const identities = getPersonIdentities(db, personId);
  const name = person?.display_name ?? '';
  for (const it of identities) {
    enqueue(db, {
      personId,
      channel: it.platform,
      targetId: it.openid,
      kind: 'notice',
      content: `「${newPlatform}」身份（${newOpenid}）已绑定到账号「${name}」。如非本人操作，可在本人端用解绑命令解除。`,
    });
  }
}
