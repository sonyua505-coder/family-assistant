/**
 * Bearer token 鉴权钩子（服务间共享密钥，容器网络内使用）。
 * 密钥比较用 timingSafeEqual，防时序侧信道。
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function extractBearer(authorization: string | undefined): string {
  if (!authorization) return '';
  const m = /^Bearer\s+(.+)$/.exec(authorization);
  return m ? m[1]!.trim() : '';
}

export function bearerMatches(req: FastifyRequest, expected: string): boolean {
  if (!expected) return false;
  return safeEqual(extractBearer(req.headers.authorization), expected);
}

/** 插件 X-API-Key 面：所有 /api/v1/* 业务接口鉴权。 */
export function requireApiKey(expected: string) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    if (!bearerMatches(req, expected)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid API key' });
    }
  };
}

/** 内部管理接口（表注册）管理员密钥，区别于 X_API_KEY。 */
export function requireAdminKey(expected: string) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    if (!bearerMatches(req, expected)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid admin key' });
    }
  };
}
