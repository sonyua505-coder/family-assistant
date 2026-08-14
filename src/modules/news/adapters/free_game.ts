/**
 * free_game 适配器（key='free_game'）：FreeToGame 免费游戏库（无需认证，只读 JSON，限流 10 次/秒）。
 * 对应《外部抓取适配器-实现说明》之外的自选扩展，契约一致：返回 FetchedItem[]。
 *
 * 数据源：https://www.freetogame.com/api
 *   /games              列表（支持 platform / category / sort-by 过滤）
 *   /game?id={id}       单游戏详情（description 更完整）
 *
 * params 约定：
 *   { id? }             给 id 抓单游戏详情
 *   { platform?, category?, sort? }   列表；缺省按 release-date（最新免费游戏）倒序
 *
 * 注意：本 API 无发布时间概念，release_date 为游戏发售日（可能为空串）；
 *  url 用 game_url（官方游戏页，按游戏唯一），可做去重键。
 */
import { cleanHtml, fetchJson, toLocalDateTime, truncate } from './net.js';
import type { FetchedItem, FetchAdapter } from './types.js';

const BASE = 'https://www.freetogame.com/api';

interface FtGame {
  id?: number;
  title?: string;
  short_description?: string;
  description?: string;
  game_url?: string;
  genre?: string;
  platform?: string;
  release_date?: string;
}

/** 把单游戏对象 → FetchedItem（long=true 用完整 description）。 */
function toItem(g: FtGame, long = false): FetchedItem {
  const title = (g.title ?? '').trim() || '（未命名游戏）';
  const url = (g.game_url ?? '').trim();

  const base = long ? cleanHtml(g.description ?? '') : (g.short_description ?? '').trim();
  const meta = [g.genre, g.platform].filter((s): s is string => typeof s === 'string' && s.trim() !== '').join(' / ');
  const summaryText = meta ? `${base}（${meta}）` : base;
  const summary = truncate(cleanHtml(summaryText));

  // release_date 形如 "2026-07-27"；空串/非法 → null
  const published_at = /^\d{4}-\d{2}-\d{2}$/.test(g.release_date ?? '')
    ? toLocalDateTime(`${g.release_date} 00:00:00`)
    : null;

  return { title, url, summary, published_at };
}

export const freeGame: FetchAdapter = {
  key: 'free_game',
  label: '免费游戏',
  async fetch(params) {
    // 单游戏详情
    if (params?.id !== undefined) {
      const id = typeof params.id === 'number' ? params.id : Number(String(params.id));
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`free_game 适配器: id 需为正整数，收到: ${String(params.id)}`);
      }
      const data = (await fetchJson(`${BASE}/game?id=${id}`)) as FtGame;
      return [toItem(data, true)];
    }

    // 列表：platform / category / sort 透传（非法值由 API 校验，返回空数组即可）
    const platform = typeof params?.platform === 'string' && params.platform.trim() ? params.platform.trim() : '';
    const category = typeof params?.category === 'string' && params.category.trim() ? params.category.trim() : '';
    const sort = typeof params?.sort === 'string' && params.sort.trim() ? params.sort.trim() : 'release-date';
    const qs = new URLSearchParams({ 'sort-by': sort });
    if (platform) qs.set('platform', platform);
    if (category) qs.set('category', category);

    const list = (await fetchJson(`${BASE}/games?${qs}`)) as FtGame[];
    return list.map((g) => toItem(g, false));
  },
};
