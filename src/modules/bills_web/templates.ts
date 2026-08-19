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
  tasks: load('tasks.ejs'),
  work: load('work.ejs'),
  taskEdit: load('task_edit.ejs'),
  workEdit: load('work_edit.ejs'),
  taskStats: load('task_stats.ejs'),
  workStats: load('work_stats.ejs'),
};

/** HTML 转义（helper 生成的属性/文本用）。 */
function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 账本下拉选项（DRY：所有页面的账本切换 <select> 复用，避免重复 forEach）。
 *  series 传入 'daily'|'work'|'task' 时渲染复合选项：每个账本三行「XX · 日常账单 / XX · 工作账单 / XX · 待办」，
 *  option value 为 daily-<id> / work-<id> / task-<id>，由路由识别系列并跨页跳转（对应规划：选择器 = (account_id, series)）。
 *  不传 series 则为纯账本选项（待办列表/回收站等无系列页面用）。 */
export function opt(
  accounts: Array<{ id: number; name: string }>,
  accountId: number,
  series?: 'daily' | 'work' | 'task',
): string {
  if (series) {
    const out: string[] = [];
    for (const a of accounts) {
      out.push(
        `<option value="daily-${a.id}"${series === 'daily' && a.id === accountId ? ' selected' : ''}>${escapeHtml(a.name)} · 日常账单</option>`,
        `<option value="work-${a.id}"${series === 'work' && a.id === accountId ? ' selected' : ''}>${escapeHtml(a.name)} · 工作账单</option>`,
        `<option value="task-${a.id}"${series === 'task' && a.id === accountId ? ' selected' : ''}>${escapeHtml(a.name)} · 待办</option>`,
      );
    }
    return out.join('');
  }
  return accounts
    .map((a) => `<option value="${a.id}"${a.id === accountId ? ' selected' : ''}>${escapeHtml(a.name)}</option>`)
    .join('');
}

/** 金额千分位：整数/小数均支持（1234567.89 → 1,234,567.89）。 */
export function comma(v: unknown): string {
  const s = String(v ?? '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, dec] = body.split('.');
  const intFmt = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intFmt + (dec !== undefined ? '.' + dec : '');
}

/** 统一账本切换工具条：select + 切换按钮 + 一组操作链接。
 *  链接直接渲染为 <a class="btn">，避免 <a><button> 反模式（button 默认 submit 会触发表单而非跳转）。
 *  series 传入后账本下拉渲染「日常账单 / 工作账单 / 待办」复合选项（见 opt）。 */
export function switcher(opts: {
  token: string;
  action: string;
  accounts: Array<{ id: number; name: string }>;
  accountId: number;
  series?: 'daily' | 'work' | 'task';
  hidden?: Record<string, string>;
  links?: Array<{ href: string; label: string; className?: string }>;
}): string {
  const hidden = opts.hidden
    ? Object.entries(opts.hidden)
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join('')
    : '';
  const links = (opts.links ?? [])
    .map((l) => `<a class="btn ${l.className ?? ''}" href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
    .join('');
  return `<form class="toolbar" method="get" action="${escapeHtml(opts.action)}">
  <select name="account_id">${opt(opts.accounts, opts.accountId, opts.series)}</select>
  ${hidden}
  <button>切换账本</button>
  ${links}
</form>`;
}

/** 子模板 → 顶栏高亮项映射（work / 待收 不在顶栏，对应页不高亮）。 */
const NAV_BY_TEMPLATE = new Map<ejs.TemplateFunction, string>([
  [tpl.overview, 'home'],
  [tpl.bills, 'bills'],
  [tpl.stats, 'stats'],
  [tpl.aa, 'bills'],
  [tpl.trash, 'trash'],
  [tpl.tasks, 'tasks'],
  [tpl.taskStats, 'tasks'],
  [tpl.work, 'work'],
  [tpl.workStats, 'work'],
  [tpl.edit, 'bills'],
  [tpl.taskEdit, 'tasks'],
  [tpl.workEdit, 'work'],
]);

/** 渲染完整页面：子模板 → body（已转义），再套 layout。accountId 透传给 layout（nav 跨页保持账本）。
 *  注入 opt/comma/switcher/active 供所有子模板使用（DRY + 顶栏高亮）。 */
export function renderPage(
  title: string,
  token: string,
  mode: 'read' | 'write',
  bodyTemplate: ejs.TemplateFunction,
  data: Record<string, unknown>,
): string {
  const active = NAV_BY_TEMPLATE.get(bodyTemplate) ?? '';
  const body = bodyTemplate({ token, mode, opt, comma, switcher, active, ...data });
  const accountId = typeof data.accountId === 'number' ? data.accountId : 0;
  return tpl.layout({ title, token, mode, accountId, active, body });
}
