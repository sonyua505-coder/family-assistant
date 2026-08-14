/**
 * 身份注入中间件（M1，对应设计文档 §4.4 / §5 / ADR D17）。
 *
 * 背景：插件（AstrBot）在每个请求头上带 x-platform + x-openid，
 * 后端据此解析出"这个人是谁"（person_id）。身份来自工具注入，
 * 绝不靠 LLM 从对话内容里猜。因此所有业务接口都要经过本中间件。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { resolveIdentityByPlatform } from '../modules/system/identity.js';
import { AppError } from './errors.js';

/** 当前请求的注入身份：请求头 + 解析出的 person（未绑定则 personId 为 null）。 */
export interface Identity {
  platform: string;          // 'wechat' | 'qq'
  openid: string;            // 平台 openid
  personId: number | null;   // 解析出的 person；未绑定为 null
  disabled: boolean;         // 该 person 是否被应急禁用
}

// 让 Fastify 的请求对象认识 req.identity 这个字段（类型声明扩展）
declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity | null;
  }
}

/** 目前仅支持的两个平台（设计文档限定 'wechat' | 'qq'）。 */
const VALID_PLATFORMS = new Set(['wechat', 'qq']);

/**
 * 创建一组身份鉴权钩子（闭包持有 db）。
 * 返回两个 preHandler 钩子，供路由按需选用：
 *  - requireIdentity    只要请求带合法身份头即可，未绑定 person 也放行（用于引导建人）
 *  - requireBoundPerson 除身份头外，还要求当前身份已绑定 person（否则引导 create/bind）
 */
export function createIdentityHooks(db: Database.Database) {
  /** 解析身份头并挂到 req.identity；身份头缺失/非法时直接 400。 */
  async function requireIdentity(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const platform = req.headers['x-platform'];
    const openid = req.headers['x-openid'];
    if (typeof platform !== 'string' || typeof openid !== 'string' || openid.length === 0) {
      throw new AppError(400, 'IDENTITY_REQUIRED', '缺少 x-platform / x-openid 请求头（身份由插件注入）');
    }
    if (!VALID_PLATFORMS.has(platform)) {
      throw new AppError(400, 'INVALID_PLATFORM', `平台不合法: ${platform}（应为 wechat/qq）`);
    }
    const resolved = resolveIdentityByPlatform(db, platform, openid);
    req.identity = {
      platform,
      openid,
      personId: resolved?.person_id ?? null,
      disabled: resolved?.disabled ?? false,
    };
  }

  /** 在 requireIdentity 基础上，要求已绑定 person；含应急禁用（persons.disabled=1）拦截。 */
  async function requireBoundPerson(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireIdentity(req, reply);
    if (!req.identity || req.identity.personId === null) {
      throw new AppError(401, 'IDENTITY_UNBOUND', '当前身份尚未绑定 person，请先 create_person 或 bind_person');
    }
    if (req.identity.disabled) {
      throw new AppError(403, 'PERSON_DISABLED', '该账号已被禁用，请联系管理员');
    }
  }

  return { requireIdentity, requireBoundPerson };
}
