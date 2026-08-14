/**
 * rss 适配器（key='rss'）：通用 RSS/Atom 抓取。
 * 支持 RSS 2.0 / Atom / RSS 1.0 (RDF)。对应《外部抓取适配器-实现说明》§5.1。
 *
 * 实现要点：
 *  - params.source_url 为必填；URL 白名单/SSRF 校验在注册表层，本适配器不校验也不绕过。
 *  - 带浏览器 UA（实测 ruanyifeng 等源无 UA 会被 Cloudflare 403）。
 *  - description/content:encoded 常是 HTML：剥标签 + 解码实体后截断，不返回 HTML。
 *  - 编码按 Content-Type / XML 声明探测，兼容 GBK/GB2312。
 *  - 无发布时间 → published_at: null。
 */
import { XMLParser } from 'fast-xml-parser';
import { asText, cleanHtml, fetchText, toLocalDateTime, truncate } from './net.js';
import type { FetchedItem, FetchAdapter } from './types.js';

interface RssItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
  date?: unknown; // RSS 1.0 的 dc:date（去前缀后为 date）
  guid?: unknown;
  encoded?: unknown; // content:encoded（去前缀后）
}

interface AtomEntry {
  title?: unknown;
  link?: unknown;
  id?: unknown;
  updated?: unknown;
  published?: unknown;
  summary?: unknown;
  content?: unknown;
}

/** fast-xml-parser 统一配置：去命名空间前缀、item/entry 恒为数组、保留属性。 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name: string) => name === 'item' || name === 'entry',
});

/** 从 Atom 的 <link> 取 href（优先 rel=alternate 的，兼容 string / 对象 / 数组）。 */
function atomLinkHref(link: unknown): string {
  if (typeof link === 'string') return link.trim();
  if (Array.isArray(link)) {
    for (const l of link) {
      const h = atomLinkHref(l);
      if (h) return h;
    }
    return '';
  }
  if (link !== null && typeof link === 'object') {
    const o = link as Record<string, unknown>;
    const rel = o['@_rel'];
    if (rel !== undefined && rel !== 'alternate' && rel !== 'via') return '';
    const href = o['@_href'];
    return typeof href === 'string' ? href.trim() : '';
  }
  return '';
}

/** 解析 RSS/Atom 文本 → 条目列表。格式自动识别（根元素名）。 */
export function parseFeed(xml: string): FetchedItem[] {
  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`RSS 解析失败: 非法 XML（${reason}）`);
  }

  // 空 feed（如无内容）直接返回空
  if (!root || typeof root !== 'object') return [];

  // ── RSS 2.0：rss.channel.item ──
  const rssNode = root.rss as Record<string, unknown> | undefined;
  if (rssNode) {
    const channel = rssNode.channel as Record<string, unknown> | undefined;
    if (!channel) throw new Error('RSS 解析失败: 缺少 <channel>');
    const items = (channel.item ?? []) as RssItem[];
    return items.map((item) => rss2Item(item)).filter((x): x is FetchedItem => x !== null);
  }

  // ── Atom：feed.entry ──
  const feedNode = root.feed as Record<string, unknown> | undefined;
  if (feedNode) {
    const entries = (feedNode.entry ?? []) as AtomEntry[];
    return entries.map((entry) => atomEntry(entry)).filter((x): x is FetchedItem => x !== null);
  }

  // ── RSS 1.0：RDF.item ──
  const rdfNode = root.RDF as Record<string, unknown> | undefined;
  if (rdfNode) {
    const items = (rdfNode.item ?? []) as RssItem[];
    return items.map((item) => rss2Item(item)).filter((x): x is FetchedItem => x !== null);
  }

  throw new Error('RSS 解析失败: 无法识别的 feed 格式（非 RSS/Atom）');
}

/** RSS 2.0 / 1.0 单条 → FetchedItem。标题或链接都缺就丢弃。 */
function rss2Item(item: RssItem): FetchedItem | null {
  const title = cleanHtml(asText(item.title));
  const link = asText(item.link) || asText(item.guid);
  if (!title && !link) return null;

  const descRaw = asText(item.description) || asText(item.encoded);
  const published_at = toLocalDateTime(asText(item.pubDate) || asText(item.date));
  const summary = descRaw ? truncate(cleanHtml(descRaw)) : undefined;

  return {
    title: title || '(无标题)',
    url: link,
    ...(summary !== undefined ? { summary } : {}),
    published_at,
  };
}

/** Atom 单条 → FetchedItem。标题或链接都缺就丢弃。 */
function atomEntry(entry: AtomEntry): FetchedItem | null {
  const title = cleanHtml(asText(entry.title));
  const link = atomLinkHref(entry.link) || asText(entry.id);
  if (!title && !link) return null;

  const descRaw = asText(entry.summary) || asText(entry.content);
  const published_at = toLocalDateTime(asText(entry.published) || asText(entry.updated));
  const summary = descRaw ? truncate(cleanHtml(descRaw)) : undefined;

  return {
    title: title || '(无标题)',
    url: link,
    ...(summary !== undefined ? { summary } : {}),
    published_at,
  };
}

/**
 * 抓取并解析一个 RSS/Atom 源。
 * params.source_url 必填；任何失败 throw 中文可读 message。
 */
async function fetchFeed(sourceUrl: string): Promise<FetchedItem[]> {
  // 只接受 http(s)；协议外的（如 file://、内部地址）直接拒绝，不自行校验主机名
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error(`rss 适配器: source_url 需为 http(s) 地址，收到: ${sourceUrl}`);
  }
  const xml = await fetchText(sourceUrl);
  return parseFeed(xml);
}

export const rss: FetchAdapter = {
  key: 'rss',
  label: '通用 RSS/Atom',
  async fetch(params) {
    const sourceUrl = params?.source_url;
    if (typeof sourceUrl !== 'string' || sourceUrl.trim() === '') {
      throw new Error('rss 适配器: 缺少参数 source_url（RSS/Atom 地址）');
    }
    return fetchFeed(sourceUrl.trim());
  },
};
