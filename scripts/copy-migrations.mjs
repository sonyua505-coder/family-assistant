// 构建时把 migrations/*.sql 拷进 dist，使 node dist/index.js 也能跑迁移。
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('migrations copied to dist');
