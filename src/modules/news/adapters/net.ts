/**
 * 抓取适配器共享工具：HTTP 抓取（内置 fetch + 超时 + UA）、charset 解码、
 * 时间格式化、HTML 清洗。三个适配器共用，避免重复。
 *
 * 约定：
 *  - 抓取一律带浏览器 UA（实测部分 RSS 源无 UA 会被 Cloudflare 403 拦截）。
 *  - 失败统一 throw 中文可读 message（如 "抓取失败: url（原因）"），上层捕获记日志。
 *  - 不碰数据库、不做 SSRF 校验（校验在注册表层）。
 */

/** 默认浏览器 UA（部分源无 UA 会被风控拦截，如 ruanyifeng 403）。 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 抓取原始字节 + 内容类型。网络失败/非 2xx/超时都 throw。 */
export async function fetchBuffer(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ buf: ArrayBuffer; contentType: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`抓取失败: ${url}（${reason}）`);
  }
  if (!res.ok) {
    throw new Error(`抓取失败: ${url}（HTTP ${res.status}）`);
  }
  return { buf: await res.arrayBuffer(), contentType: res.headers.get('content-type') };
}

/**
 * 按 charset 把响应字节解码成文本。
 * charset 优先级：Content-Type 头 → XML 声明 → 默认 utf-8。
 * GBK/GB2312 统一映射到 gb18030（TextDecoder 支持）。
 */
export function decodeText(buf: ArrayBuffer, contentType: string | null, xmlDecl?: string): string {
  let charset: string | null = null;
  const ct = (contentType ?? '').match(/charset\s*=\s*["']?([\w-]+)/i);
  if (ct) charset = ct[1]!;
  if (!charset && xmlDecl) {
    const m = xmlDecl.match(/encoding\s*=\s*["']([\w-]+)["']/i);
    if (m) charset = m[1]!;
  }
  const enc = (charset ?? 'utf-8').toLowerCase().replace(/^gbk$|^gb2312$/, 'gb18030');
  // fatal:true —— 编码选错会抛错而非悄悄产出乱码，便于排查
  return new TextDecoder(enc, { fatal: true }).decode(buf);
}

/** 抓取文本（自动解码 charset），可选传入 XML 声明用于探测编码。 */
export async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; xmlDecl?: string } = {},
): Promise<string> {
  const { buf, contentType } = await fetchBuffer(url, opts);
  return decodeText(buf, contentType, opts.xmlDecl);
}

/** 抓取并解析 JSON。编码按 utf-8 优先、gb18030 兜底。 */
export async function fetchJson(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<unknown> {
  const { buf, contentType } = await fetchBuffer(url, opts);
  // 该 API 返回中文内容，兼容 utf-8 与 gb18030 两种编码
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('gb18030').decode(buf);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`解析 JSON 失败: ${url}（${reason}）`);
  }
}

/**
 * 把任意时间输入转成本地时间串 "YYYY-MM-DD HH:MM:SS"（与 db/dao.ts 的 now() 同源）。
 * 无效输入返回 null（供 published_at 用）。
 */
export function toLocalDateTime(input: string | number | Date | null | undefined): string | null {
  if (input === null || input === undefined || input === '') return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 今天的本地日期串 "YYYY-MM-DD"（自给自足，不依赖 db）。 */
export function todayLocal(): string {
  return toLocalDateTime(new Date())?.slice(0, 10) ?? '';
}

/**
 * 清洗 HTML → 纯文本摘要：先去 CDATA 标记、剥标签、解码实体、折叠空白。
 * 不返回原始 HTML（契约要求 summary 为纯文本）。
 */
export function cleanHtml(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** summary 截断上限（避免塞入超长正文）。 */
export const SUMMARY_MAX_LEN = 300;

/** 截断到上限并补省略号。 */
export function truncate(text: string, max = SUMMARY_MAX_LEN): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把 fast-xml-parser 解析出的标签值归一成纯文本。
 * 兼容：字符串/数字、含 #text/__cdata 的对象、数组（取首个）。
 */
export function asText(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (Array.isArray(v)) return asText(v[0]);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['#text', '__cdata', '_', '@_']) {
      if (o[k] !== undefined) return asText(o[k]);
    }
    for (const k of Object.keys(o)) {
      const val = o[k];
      if (typeof val === 'string' || typeof val === 'number') return String(val);
    }
  }
  return '';
}
