/**
 * steam_news 适配器（key='steam_news'）：抓某款 Steam 游戏的最新新闻。
 * 对应《外部抓取适配器-实现说明》§5.2。
 *
 * 数据源（实测可用）：Steam 商店官方 RSS
 *   https://store.steampowered.com/feeds/news/app/{appid}
 * 返回标准 RSS 2.0，每条 <link> 形如
 *   https://store.steampowered.com/news/app/{appid}/view/{postid}
 * 稳定唯一，直接做去重键。
 *
 * 备选（api.steampowered.com/ISteamNews/...）本机实测连接超时，故不用。
 */
import { XMLParser } from 'fast-xml-parser';
import { asText, cleanHtml, fetchText, toLocalDateTime, truncate } from './net.js';
import type { FetchedItem, FetchAdapter } from './types.js';

/** 缺省游戏：DOTA 2。 */
export const DEFAULT_APPID = 570;

interface SteamItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
  guid?: unknown;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name: string) => name === 'item',
});

/** 校验并归一 appid：合法返回数字字符串，否则 throw。 */
function normalizeAppid(raw: unknown): string {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,9}$/.test(s)) {
    throw new Error(`steam_news 适配器: appid 需为数字（Steam AppID），收到: ${String(raw)}`);
  }
  return s;
}

/** 解析 Steam 商店 RSS → 条目列表。 */
export function parseSteamFeed(xml: string): FetchedItem[] {
  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Steam 新闻解析失败: 非法 XML（${reason}）`);
  }
  const channel = (root.rss as Record<string, unknown> | undefined)?.channel as
    | Record<string, unknown>
    | undefined;
  if (!channel) throw new Error('Steam 新闻解析失败: 缺少 <channel>');
  const items = (channel.item ?? []) as SteamItem[];

  return items
    .map((item): FetchedItem | null => {
      const title = cleanHtml(asText(item.title));
      const link = asText(item.link) || asText(item.guid);
      if (!title || !link) return null; // 缺标题或链接的条目丢弃（link 是去重键）

      const descRaw = asText(item.description);
      const published_at = toLocalDateTime(asText(item.pubDate));
      const summary = descRaw ? truncate(cleanHtml(descRaw)) : undefined;

      return {
        title,
        url: link,
        ...(summary !== undefined ? { summary } : {}),
        published_at,
      };
    })
    .filter((x): x is FetchedItem => x !== null);
}

export const steamNews: FetchAdapter = {
  key: 'steam_news',
  label: 'Steam 新闻',
  async fetch(params) {
    const appid = normalizeAppid(params?.appid ?? DEFAULT_APPID);
    const url = `https://store.steampowered.com/feeds/news/app/${appid}`;
    const xml = await fetchText(url);
    return parseSteamFeed(xml);
  },
};
