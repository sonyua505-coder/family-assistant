# 家庭信息助理系统 · 后端

以 QQ/微信（AstrBot）为交互界面、自然语言为统一入口的个人/家庭信息助理系统后端。

**技术栈**：Node.js 22 + TypeScript + Fastify + SQLite(WAL) + better-sqlite3
**配套文档**：《家庭信息助理系统-需求文档-v2.1.md》《家庭信息助理系统-后端设计文档.md》

## 开发

```bash
npm install
cp .env.example .env    # 首次
npm run migrate         # 建表/迁移
npm run dev             # 开发（tsx watch，默认 http://127.0.0.1:3000）
```

- 健康检查：`GET http://127.0.0.1:3000/healthz` → `{"ok":true}`
- API 鉴权：`Authorization: Bearer <X_API_KEY>`
- 内部表注册接口（管理员密钥）：`POST /api/v1/_internal/tables`

## 里程碑（M0-M8）

- M0 ✅ 项目骨架 + db 层（迁移/表注册/DAO/settings）+ /healthz —— 本地
- M1 ✅ 身份与账户（persons/identities/accounts + 身份注入中间件）—— 本地
- M2 ✅ 记账核心（bills CRUD/软删回收站/AA/stats/batch/changes/日志）—— 本地
- M3 调度 + outbox —— 本地
- M4 任务/订阅新闻/记忆//fetch —— 本地
- M5 记账 Web 服务（token 门控）—— 本地
- M6 云端部署（Docker Compose + ZeroTier）—— 云端
- M7 AstrBot 插件 —— 云端
- M8 通道实测 + 端到端联调 —— 云端

## 目录结构

```
src/
├── index.ts              # 入口
├── app.ts                # Fastify 应用装配
├── config.ts             # .env 配置
├── db/
│   ├── index.ts          # 连接工厂（WAL/外键）
│   ├── migrations.ts     # 迁移 runner
│   ├── migrate.ts        # 迁移 CLI 脚本
│   ├── registry.ts       # 表注册机制（描述符→建表+通用 CRUD）
│   ├── dao.ts            # DAO 基座
│   └── migrations/       # *.sql 迁移文件
└── modules/
    └── system/           # settings / 健康检查 / 内部接口
```
