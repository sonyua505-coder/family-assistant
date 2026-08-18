/**
 * 调度器（M3，对应设计文档 §6 / ADR D9：内置 node-cron，不引外部任务队列）。
 *
 * 所有任务都是轻量检查 + 幂等，周期内的运行不会产生副作用；单个任务异常
 * 会被捕获记日志，不中断调度循环。可整体 start()/stop()（配合优雅关停）。
 */
import cron from 'node-cron';
import type Database from 'better-sqlite3';
import { runBillDigest, runDailyBrief, runNewsCleanup, runNewsFetch, runOutboxSweep, runReminderDue, runWorkDigest } from './tasks.js';

export interface SchedulerDeps {
  db: Database.Database;
  /** 调度日志（传 Fastify 的 app.log 即可） */
  log: (msg: string) => void;
  /** 时区（默认 Asia/Shanghai） */
  timezone?: string;
}

/** 包一层 try/catch（支持 async）：单个任务失败只记日志，不让 cron 循环崩掉。 */
async function safeRun(name: string, fn: () => number | Promise<number>, log: (msg: string) => void): Promise<void> {
  try {
    const n = await fn();
    if (n > 0) log(`[scheduler:${name}] 完成 ${n} 条`);
  } catch (err) {
    log(`[scheduler:${name}] 失败: ${(err as Error).message}`);
  }
}

export class Scheduler {
  private jobs: cron.ScheduledTask[] = [];
  private db: Database.Database;
  private log: (msg: string) => void;
  private timezone: string;

  constructor(deps: SchedulerDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.timezone = deps.timezone ?? 'Asia/Shanghai';
  }

  /** 注册并启动全部定时任务。 */
  start(): void {
    const opts = { timezone: this.timezone };

    // 任务提醒：每分钟查一次到期任务
    this.jobs.push(
      cron.schedule('* * * * *', () => safeRun('reminder_due', () => runReminderDue(this.db), this.log), opts),
    );

    // 账单日报：每 5 分钟检查一次是否已到当日推送时刻（settings 可动态改），靠幂等防重
    this.jobs.push(
      cron.schedule('*/5 * * * *', () => safeRun('bill_digest', () => runBillDigest(this.db), this.log), opts),
    );

    // 每日简报：同 bill_digest，按 settings 时刻 + 幂等
    this.jobs.push(
      cron.schedule('*/5 * * * *', () => safeRun('daily_brief', () => runDailyBrief(this.db), this.log), opts),
    );

    // 工作账单日报：同 bill_digest 时刻（settings bill_digest_time），独立 kind 幂等
    this.jobs.push(
      cron.schedule('*/5 * * * *', () => safeRun('work_digest', () => runWorkDigest(this.db), this.log), opts),
    );

    // outbox 终态清理：每 10 分钟
    this.jobs.push(
      cron.schedule('*/10 * * * *', () => void safeRun('outbox_sweep', () => runOutboxSweep(this.db), this.log), opts),
    );

    // 订阅抓取：每 6 小时（异步，单订阅失败不中断）
    this.jobs.push(
      cron.schedule('0 */6 * * *', () => void safeRun('news_fetch', () => runNewsFetch(this.db), this.log), opts),
    );

    // 新闻缓存清理：每小时
    this.jobs.push(
      cron.schedule('0 * * * *', () => void safeRun('news_cleanup', () => runNewsCleanup(this.db), this.log), opts),
    );
  }

  /** 停止全部任务（优雅关停用）。 */
  stop(): void {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }
}
