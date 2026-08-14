/**
 * 抓取适配器联调脚本（对应《外部抓取适配器-实现说明》§8，不启动服务器）。
 *
 * 用法：
 *   npx tsx scripts/test-adapters.ts [key] [extra args...]
 *   key ∈ rss | steam_news | delta_password_gate
 *
 * 例：
 *   npx tsx scripts/test-adapters.ts rss https://www.ruanyifeng.com/blog/atom.xml
 *   npx tsx scripts/test-adapters.ts steam_news 570
 */
import { adapters } from '../src/modules/news/adapters/index.js';

const key = process.argv[2] ?? 'rss';
const adapter = adapters.find((a) => a.key === key);
if (!adapter) throw new Error(`未知适配器: ${key}`);

let params: Record<string, unknown> = {};
if (key === 'rss') params = { source_url: process.argv[3] ?? 'https://www.ruanyifeng.com/blog/atom.xml' };
if (key === 'steam_news') params = { appid: process.argv[3] ?? 570 };
if (key === 'free_game') {
  params = process.argv[3] && /^\d+$/.test(process.argv[3]) ? { id: Number(process.argv[3]) } : {};
}

console.log(`[${adapter.label}] 抓取中...`);
const items = await adapter.fetch(params);
console.log(`共 ${items.length} 条，前 5 条：`);
console.log(JSON.stringify(items.slice(0, 5), null, 2));
