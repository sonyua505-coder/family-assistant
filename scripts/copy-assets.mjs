// 构建时把运行时非 TS 资源拷进 dist（tsc 只编译 .ts，不复制以下文件）：
//  - src/db/migrations/*.sql                迁移 SQL（node dist 也能跑迁移）
//  - src/modules/bills_web/templates/*.ejs  记账 Web EJS 模板（templates.ts 运行时读）
// 后续新增运行时静态资源都在这里登记。
import { cpSync, mkdirSync } from 'node:fs';

const ASSETS = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/modules/bills_web/templates', 'dist/modules/bills_web/templates'],
];

for (const [src, dest] of ASSETS) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`copied ${src} -> ${dest}`);
}
