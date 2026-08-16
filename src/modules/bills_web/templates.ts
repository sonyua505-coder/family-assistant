/**
 * EJS 模板加载与页面渲染（M5）。
 * 模板启动时编译一次；所有数据经 <%= %>（EJS 自动 HTML 转义，防 XSS 窃令牌）。
 * layout 用 <%- body %> 注入已渲染的子页（子页内容已转义，安全）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'templates');

/** 编译单个模板（带 filename 以便 EJS 内部 include 可用）。 */
function load(name: string): ejs.TemplateFunction {
  const file = join(DIR, name);
  return ejs.compile(readFileSync(file, 'utf8'), { filename: file });
}

export const tpl = {
  layout: load('layout.ejs'),
  overview: load('overview.ejs'),
  bills: load('bills.ejs'),
  stats: load('stats.ejs'),
  aa: load('aa.ejs'),
  trash: load('trash.ejs'),
  edit: load('edit.ejs'),
};

/** 渲染完整页面：子模板 → body（已转义），再套 layout。 */
export function renderPage(
  title: string,
  token: string,
  mode: 'read' | 'write',
  bodyTemplate: ejs.TemplateFunction,
  data: Record<string, unknown>,
): string {
  const body = bodyTemplate({ token, mode, ...data });
  return tpl.layout({ title, token, mode, body });
}
