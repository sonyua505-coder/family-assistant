/**
 * 抓取适配器汇总导出（M4）。
 * 主会话注册表直接 import 此数组；类型复用同一份 types.ts，避免契约漂移。
 */
import { rss } from './rss.js';
import { steamNews } from './steam_news.js';
import { deltaPasswordGate } from './delta_password_gate.js';
import { freeGame } from './free_game.js';
import type { FetchAdapter } from './types.js';

/** 注册表消费的适配器清单。 */
export const adapters: FetchAdapter[] = [rss, steamNews, deltaPasswordGate, freeGame];

export type { FetchedItem, FetchAdapter } from './types.js';
