/**
 * delta_password_gate 适配器（key='delta_password_gate'）：抓《三角洲行动》每日密码门。
 * 对应《外部抓取适配器-实现说明》§5.3。内置目标，无需参数。
 *
 * 数据源（实测可用，公开 API 无需密钥）：
 *   https://xiaoqi.icofun.cn/API/delta_mima.php?type=json
 * 返回：{ latest_update_time, passwords: [...], count, status, msg, api_source }
 *   passwords 元素字段未在官方文档明文给出，此处做防御式字段名匹配
 *   （name/door/title/名称... 与 password/code/mima/密码...），解析不了就原样展示。
 *
 * 注意：
 *  - 密码每日约 9-10 点更新，此前 count=0。此时返回一条"暂无数据"提示条目，
 *    让实时抓取（"查一下密码门"）有可读反馈；不返回空数组。
 *  - 条目 url 带当日日期 fragment（#YYYY-MM-DD），使每日密码在 news_cache 去重时
 *    视为不同条目（否则同一门天天同 url 会被去重吞掉新密码）。
 */
import { fetchJson, todayLocal } from './net.js';
import type { FetchedItem, FetchAdapter } from './types.js';

export const DELTA_API_URL = 'https://xiaoqi.icofun.cn/API/delta_mima.php?type=json';

interface DeltaResponse {
  latest_update_time?: unknown;
  passwords?: unknown;
  count?: unknown;
  status?: unknown;
  msg?: unknown;
  api_source?: unknown;
}

/** 常见字段名（防御式匹配：官方文档未给出具体字段名）。 */
const NAME_KEYS = ['name', 'door', 'door_name', 'title', 'label', 'position', 'pos', 'location', '地点', '位置', '名称'];
const CODE_KEYS = ['password', 'passwd', 'pwd', 'code', 'mima', 'pass', 'value', '通行码', '密码'];

/** 从对象里按候选键取第一个非空字符串。 */
function pickValue(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/** 单条密码 → FetchedItem（title=门名称，summary=密码/说明，url=来源+当日日期）。导出便于单测。 */
export function toItem(item: unknown, date: string): FetchedItem {
  const url = `${DELTA_API_URL}#${date}`;

  if (typeof item === 'string') {
    // 兼容纯文本形如 "曼柏林城密码：1234"
    const m = item.match(/^(.+?)(?:密码|口令)[:：]\s*(\S+)$/);
    if (m) {
      return { title: m[1]!.trim(), url, summary: `密码：${m[2]!.trim()}`, published_at: null };
    }
    return { title: '密码门', url, summary: item, published_at: null };
  }

  if (Array.isArray(item)) return toItem(item[0], date); // 防御：取首元素

  if (item !== null && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const name = pickValue(obj, NAME_KEYS);
    const code = pickValue(obj, CODE_KEYS);
    if (name && code) {
      return { title: name, url, summary: `密码：${code}`, published_at: null };
    }
    // 只匹配到名字或密码之一：字段名没猜中，原样展示元素内容兜底
    if (name || code) {
      return {
        title: name || '密码门',
        url,
        summary: code ? `密码：${code}` : JSON.stringify(item),
        published_at: null,
      };
    }
    return { title: '密码门', url, summary: JSON.stringify(item), published_at: null };
  }

  return { title: '密码门', url, summary: String(item ?? ''), published_at: null };
}

export const deltaPasswordGate: FetchAdapter = {
  key: 'delta_password_gate',
  label: '三角洲密码门',
  async fetch() {
    const data = (await fetchJson(DELTA_API_URL)) as DeltaResponse;

    if (data.status !== undefined && data.status !== 'success') {
      const msg = typeof data.msg === 'string' ? data.msg : '';
      throw new Error(`三角洲密码门抓取失败: ${msg || String(data.status)}`);
    }
    if (!Array.isArray(data.passwords)) {
      throw new Error('三角洲密码门抓取失败: 返回结构异常（passwords 非数组）');
    }

    const date = todayLocal();
    const items = data.passwords.map((p) => toItem(p, date));

    // count=0（密码未到更新时间，约每日 9-10 点）→ 返回一条提示，而非空数组
    if (items.length === 0) {
      const updateTime =
        typeof data.latest_update_time === 'string' && data.latest_update_time.trim()
          ? data.latest_update_time.trim()
          : '未知';
      items.push({
        title: `三角洲行动密码门（${date}）暂无数据`,
        url: `${DELTA_API_URL}#${date}`,
        summary: `今日密码约 9-10 点更新，最新更新时间：${updateTime}`,
        published_at: null,
      });
    }
    return items;
  },
};
