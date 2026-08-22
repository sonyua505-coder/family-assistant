// 临时脚本：直接用构建产物里的 mintToken 为「第一个 person」铸一个明文 token（绕过 API/身份/限流）
// 用法：node scripts/_mint.cjs  （需先 npm run build 且 dev.db 有 person）
const path = require('path');
const { pathToFileURL } = require('url');
const Database = require('better-sqlite3');

(async () => {
  const db = new Database('./data/dev.db');
  const person = db.prepare('SELECT id FROM persons ORDER BY id LIMIT 1').get();
  if (!person) {
    console.error('dev.db 没有 person，请先运行：node scripts/seed-dev.mjs');
    process.exit(1);
  }
  const { mintToken } = await import(
    pathToFileURL(path.resolve('dist/modules/bills_web/tokens.js')).href
  );
  const res = mintToken(db, person.id, 'write', 60 * 24);
  console.log(res.token);
  db.close();
})().catch((e) => {
  console.error('MINT_ERR:', e.message);
  process.exit(1);
});
