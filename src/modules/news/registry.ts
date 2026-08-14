/**
 * 抓取适配器注册表（M4，对应设计文档 §4.16 / ADR D28）。
 *
 * /fetch 与订阅抓取共用这张注册表：新信息源 = 注册一个 FetchAdapter 函数，核心零改动。
 * SSRF 防护收敛在注册表层：
 *  - preset 适配器的目标 URL 写死在各自文件里，不接受任意 url；
 *  - rss / url 模式接受用户给的 source_url，但必须先过 validateFetchUrl()。
 */
import { AppError } from '../../lib/errors.js';
import { adapters, type FetchedItem, type FetchAdapter } from './adapters/index.js';
import { cleanHtml, fetchText, truncate } from './adapters/net.js';

const byKey = new Map<string, FetchAdapter>(adapters.map((a) => [a.key, a]));

/** 按 preset_key 取适配器；不存在返回 undefined。 */
export function getAdapter(key: string): FetchAdapter | undefined {
  return byKey.get(key);
}

/** 全部已注册适配器的 key 列表（供订阅创建时校验 preset_key）。 */
export function listAdapterKeys(): string[] {
  return [...byKey.keys()];
}

/** 调 preset 适配器抓取；key 不存在抛 400。 */
export async function fetchByPreset(
  key: string,
  params?: Record<string, unknown>,
): Promise<FetchedItem[]> {
  const adapter = getAdapter(key);
  if (!adapter) {
    throw new AppError(400, 'INVALID_PRESET', `未知预设信息源: ${key}（可选: ${listAdapterKeys().join('/')}）`);
  }
  return adapter.fetch(params);
}

/** 通用 RSS/Atom 抓取（source_url 已由调用方过 validateFetchUrl）。 */
export async function fetchRss(sourceUrl: string): Promise<FetchedItem[]> {
  const adapter = getAdapter('rss');
  if (!adapter) throw new AppError(500, 'ADAPTER_MISSING', 'rss 适配器未注册');
  return adapter.fetch({ source_url: sourceUrl });
}

/** 通用 url 模式：抓任意经校验的 http(s) 页面，把正文文本作为一条条目返回。 */
export async function fetchUrlAsItem(url: string): Promise<FetchedItem[]> {
  await validateFetchUrl(url);
  const text = await fetchText(url);
  const summary = truncate(cleanHtml(text));
  return [{ title: url, url, summary, published_at: null }];
}

// ── SSRF 校验（设计文档 §9）──

/** IPv4 是否私网/环回/链路本地/云元数据/CGNAT 等禁止段。 */
function ipv4Private(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 私网
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18/15 基准测试段（本机假 IP 代理专用，勿直连）
  return false;
}

/** IPv6 是否环回/私网(ULA)/链路本地/IPv4 映射私网。 */
function ipv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7).split(':').pop() ?? '';
    return ipv4Private(v4) || v4 === '127.0.0.1';
  }
  return false;
}

/**
 * 校验抓取 URL（SSRF 防护）：
 *  - 仅 http(s)；带用户名/密码拒绝；
 *  - 主机名/IP 字面量不得是 localhost、私网、环回、链路本地、云元数据、benchmark 段。
 *
 * 不做 DNS 解析校验：本部署位于假 IP 代理之后（Clash 类代理把外部域名映射成
 * 198.18/15 与 fd00::/7 假地址再路由），域名解析由代理控制、DNS 重绑定攻击
 * 已被代理消解，且真实 fetch 走代理能正常访问外部站点；若再做"解析到私网即拒"
 * 会把所有走代理的合法域名（如 Steam、RSS 源）误杀。字面量校验已覆盖主要风险
 * （URL 直写 127.0.0.1 / 10.x / 192.168.x / 169.254.169.254 等）。
 */
export async function validateFetchUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError(400, 'INVALID_FETCH_URL', `URL 非法: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_FETCH_URL', `仅支持 http(s)，收到: ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new AppError(400, 'INVALID_FETCH_URL', 'URL 不允许携带用户名/密码');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new AppError(400, 'INVALID_FETCH_URL', `URL 主机非法: ${host}`);
  }
  if (ipv4Private(host) || ipv6Private(host)) {
    throw new AppError(400, 'INVALID_FETCH_URL', `URL 指向内网/受限地址: ${host}`);
  }
}
