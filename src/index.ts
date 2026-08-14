/**
 * 服务入口：加载配置 → 打开库 → 迁移 → 载入注册表 → 启动 Fastify。
 */
import 'dotenv/config';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { applyMigrations } from './db/migrations.js';
import { TableRegistry } from './db/registry.js';
import { buildApp } from './app.js';
import { Scheduler } from './scheduler/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const db = openDb(config.dbPath);
  applyMigrations(db);
  const registry = new TableRegistry(db);
  const restored = registry.loadPersisted();
  if (restored > 0) console.log(`[registry] 已恢复 ${restored} 个注册表`);

  const app = buildApp({ db, registry, config });

  // 调度器（SCHEDULER_ENABLED=false 可关闭，测试/调试用）
  const scheduler = new Scheduler({ db, log: (msg) => app.log.info(msg) });
  if (config.schedulerEnabled) {
    scheduler.start();
    app.log.info('调度器已启动（reminder/bill_digest/daily_brief/outbox_sweep）');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    scheduler.stop();
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.apiPort, host: '0.0.0.0' });
  app.log.info(`homeassistant API 已启动: http://127.0.0.1:${config.apiPort}`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
