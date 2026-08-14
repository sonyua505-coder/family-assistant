/**
 * 抓取适配器契约类型（M4，对应《外部抓取适配器-实现说明》§2）。
 * 主会话注册表 / 调度器直接复用本文件的类型，避免契约漂移。
 */

/** 抓取结果条目。url 为去重键（上层 sha256(url)）。 */
export interface FetchedItem {
  /** 必填：标题 */
  title: string;
  /** 必填：原文链接（去重键） */
  url: string;
  /** 可选：摘要/简介（纯文本，不带 HTML 标签） */
  summary?: string;
  /** 可选：发布时间 "YYYY-MM-DD HH:MM:SS"；未知传 null */
  published_at?: string | null;
}

/** 抓取适配器。失败一律 throw（中文可读 message），上层会捕获记日志。 */
export interface FetchAdapter {
  /** 唯一键，订阅 preset_key 指向它 */
  key: string;
  /** 展示名，如 'Steam 新闻' */
  label: string;
  /**
   * 抓取并返回条目。
   * params 约定：
   *   rss                  → { source_url }
   *   steam_news           → { appid? }
   *   delta_password_gate  → {}
   */
  fetch(params?: Record<string, unknown>): Promise<FetchedItem[]>;
}
