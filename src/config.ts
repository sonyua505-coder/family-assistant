/**
 * 环境配置（全部走 .env，零硬编码）。
 * 对应后端设计文档 §10.1 / §10.4 的环境差异表。
 */
export interface Config {
  apiPort: number;
  webPort: number;
  dbPath: string;
  apiKey: string;
  adminKey: string;
  tz: string;
  ztIp: string;
  publicWebBase: string;
  logLevel: string;
  /** 是否启动调度器（测试/调试可设 false） */
  schedulerEnabled: boolean;
  /** 每日冷备目录（ADR D22） */
  backupDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    apiPort: toInt(env.API_PORT, 3000),
    webPort: toInt(env.WEB_PORT, 8081),
    dbPath: env.DB_PATH ?? './data/dev.db',
    apiKey: env.X_API_KEY ?? '',
    adminKey: env.ADMIN_KEY ?? '',
    tz: env.TZ ?? 'Asia/Shanghai',
    ztIp: env.ZT_IP ?? '127.0.0.1',
    publicWebBase: env.PUBLIC_WEB_BASE ?? 'http://127.0.0.1:8081',
    logLevel: env.LOG_LEVEL ?? 'info',
    schedulerEnabled: env.SCHEDULER_ENABLED !== 'false',
    backupDir: env.BACKUP_DIR ?? './backup',
  };
  if (!cfg.apiKey) throw new Error('缺少 X_API_KEY（.env）');
  if (!cfg.adminKey) throw new Error('缺少 ADMIN_KEY（.env）');
  return cfg;
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
