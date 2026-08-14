-- 001_init.sql — 初始核心表（对应后端设计文档 §4.1-4.12、§4.15、§4.16 的表）
-- schema_migrations 由 runner 自行创建，不在本文件。
-- 约定：金额 INTEGER 单位分；时间 TEXT ISO8601（SQLite localtime）；软删除 is_deleted+deleted_at。

-- 4.1 自然人（必须创建）
CREATE TABLE persons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name  TEXT NOT NULL DEFAULT '',  -- 数据稳定名（账单/AA/任务里显示，创建时定，少改）
  nickname      TEXT NOT NULL DEFAULT '',  -- BOT 称呼名（空则回落 display_name）
  profile_text  TEXT NOT NULL DEFAULT '',  -- 画像/偏好文本（仅 QQ 端每次对话注入）
  disabled      INTEGER NOT NULL DEFAULT 0,  -- 应急一键禁用（中间件拦截）
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 4.2 平台身份 → person 映射
CREATE TABLE person_identities (
  platform   TEXT NOT NULL,                 -- 'wechat'|'qq'
  openid     TEXT NOT NULL,                 -- 平台 openid
  person_id  INTEGER NOT NULL REFERENCES persons(id),
  is_primary INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (platform, openid)
);
CREATE INDEX idx_person_identities_person ON person_identities(person_id);
CREATE UNIQUE INDEX idx_person_identities_primary ON person_identities(person_id) WHERE is_primary = 1;

-- 4.3 记账账户（个人/家庭，双账户不互通）
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,              -- 'personal'|'family'
  name            TEXT NOT NULL,
  owner_person_id INTEGER NOT NULL REFERENCES persons(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 4.4 家庭账户成员（personal 账户不建成员，owner 隐含）
CREATE TABLE account_members (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  person_id  INTEGER NOT NULL REFERENCES persons(id),
  role       TEXT NOT NULL DEFAULT 'member',   -- 'owner'|'member'
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (account_id, person_id)
);

-- 4.5 账单（归属账户；记录人=垫付者）
CREATE TABLE bills (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  person_id     INTEGER NOT NULL REFERENCES persons(id),   -- 记录人（=垫付者）
  type          TEXT NOT NULL DEFAULT 'expense',         -- 'income'|'expense'
  amount        INTEGER NOT NULL,                        -- 单位：分
  category      TEXT NOT NULL DEFAULT '其他',
  note          TEXT NOT NULL DEFAULT '',
  occurred_at   TEXT NOT NULL,                           -- 发生时间，默认=记账时间
  status        TEXT NOT NULL DEFAULT 'settled',         -- 'settled'已结清 | 'pending'待结算(AA)
  participants  TEXT NOT NULL DEFAULT '[]',              -- JSON：[{name,status,paid_at}]
  is_deleted    INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_bills_account ON bills(account_id, occurred_at);
CREATE INDEX idx_bills_status ON bills(account_id, status);

-- 4.6 家庭共享任务（family 账户共享；personal 账户下即个人待办）
CREATE TABLE tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts(id),
  creator_id     INTEGER NOT NULL REFERENCES persons(id),
  platform       TEXT NOT NULL DEFAULT '',      -- 创建时的注入平台；reminder 推送目标通道
  content        TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT '',
  is_done        INTEGER NOT NULL DEFAULT 0,
  done_at        TEXT,
  remind_at      TEXT,                          -- 可选，到点写 outbox
  reminded       INTEGER NOT NULL DEFAULT 0,
  linked_bill_id INTEGER,                       -- 可选，关联待结算账单
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_tasks_account ON tasks(account_id, is_done);

-- 4.7 订阅源（个人级，主要 QQ 端）
CREATE TABLE subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES persons(id),
  platform    TEXT NOT NULL,                  -- 创建时的注入平台；推送目标=该平台
  source_type TEXT NOT NULL,                  -- 'rss' | 'preset'
  name        TEXT NOT NULL,
  source_url  TEXT,                           -- rss 时必填
  preset_key  TEXT,                           -- preset 时填内置适配器键名
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 4.8 新闻缓存
CREATE TABLE news_cache (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  published_at    TEXT,
  url_hash        TEXT NOT NULL,               -- 去重用（sha256(url)）
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  is_read         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (subscription_id, url_hash)
);
CREATE INDEX idx_news_fetch ON news_cache(fetched_at);

-- 4.9 待推送队列
CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES persons(id),   -- 接收人（推送目标）
  channel    TEXT NOT NULL,                             -- 'wechat'|'qq'
  target_id  TEXT NOT NULL,                             -- 目标 openid / 群 id
  content    TEXT NOT NULL,                             -- 纯文本消息内容
  kind       TEXT NOT NULL DEFAULT 'notice',            -- 'reminder'|'daily_brief'|'bill_digest'|'news'|'notice'
  due_at     TEXT NOT NULL,                             -- 可发送时间
  status     TEXT NOT NULL DEFAULT 'pending',           -- 'pending'|'sent'|'failed'
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_outbox_pending ON outbox(status, due_at);

-- 4.10 操作日志/审计
CREATE TABLE operation_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER,          -- 涉及账户（可空）
  person_id   INTEGER,          -- 操作人（可空）
  action      TEXT NOT NULL,    -- 'bill.create' / 'bill.update' / 'task.done' …
  entity      TEXT NOT NULL,    -- 表名
  entity_id   INTEGER,
  before_data TEXT,             -- JSON，变更前
  after_data  TEXT,             -- JSON，变更后
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 4.11 键值配置
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 4.12 用户记忆（零散记忆，BOT 按需检索）+ FTS5 全文检索
CREATE TABLE user_memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES persons(id),
  content    TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE VIRTUAL TABLE user_memories_fts USING fts5(person_id UNINDEXED, content);

-- 4.15 记账 Web 访问令牌（能力令牌，只存 sha256）
CREATE TABLE web_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id    INTEGER NOT NULL REFERENCES persons(id),
  token_hash   TEXT NOT NULL UNIQUE,
  mode         TEXT NOT NULL DEFAULT 'read',   -- 'read'|'write'
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_web_tokens_exp ON web_tokens(expires_at);

-- 4.14 表注册机制：注册表描述符持久化（registry 自动建表 + 记录）
CREATE TABLE registered_tables (
  name       TEXT PRIMARY KEY,
  descriptor TEXT NOT NULL,      -- JSON 描述符
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
