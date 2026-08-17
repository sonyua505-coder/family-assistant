-- 005_work_bills.sql — 工作账单域（装修安装门记账，2026-08-18 决策）
-- 5 张表：委托方 / 单价表(按委托方区分价格) / 工作账单 / 明细 / 结算记录。
-- 金额一律 INTEGER「分」；明细 qty REAL（墙板等按㎡计小数）；金额契约与 bills 一致。
-- 挂 account（家庭共享，复用 resolveAccountId 权限）；与 bills 完全独立。
-- 明细/结算为子表只挂 bill_id（权限经父账单校验）。勿改已应用的 001-004。

-- 委托方（为谁做事 / 跟谁结算：A装修公司 / B装修公司 / 个人委托）
CREATE TABLE work_clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'company',   -- 'company' | 'personal'
  phone      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_work_clients_account ON work_clients(account_id);

-- 单价表（按委托方区分价格；同一委托方下品名唯一）
CREATE TABLE work_unit_prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  client_id  INTEGER NOT NULL REFERENCES work_clients(id),
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL DEFAULT '个',
  unit_price INTEGER NOT NULL,               -- 分
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (account_id, client_id, name)
);

-- 工作账单（某地点的一次安装工作）
CREATE TABLE work_bills (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  client_id    INTEGER NOT NULL REFERENCES work_clients(id),
  contact      TEXT NOT NULL DEFAULT '',     -- 服务对象（文本，不建表）
  address      TEXT NOT NULL DEFAULT '',
  occurred_at  TEXT NOT NULL,                -- 安装日期 YYYY-MM-DD
  note         TEXT NOT NULL DEFAULT '',
  final_amount INTEGER,                      -- 实际应收（分）；NULL=按明细计算
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_work_bills_account ON work_bills(account_id, occurred_at);
CREATE INDEX idx_work_bills_client ON work_bills(account_id, client_id);

-- 工作账单明细（安装内容行；单价快照，price_ref_id 指向单价表供 recalc 重算）
CREATE TABLE work_bill_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id      INTEGER NOT NULL REFERENCES work_bills(id),
  name         TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 1,      -- 数量（扇/个/套/㎡，㎡可小数）
  unit         TEXT NOT NULL DEFAULT '个',
  unit_price   INTEGER NOT NULL,             -- 单价快照（分）
  amount       INTEGER NOT NULL,             -- 小计 = round(qty × unit_price)
  price_ref_id INTEGER,                      -- 指向 work_unit_prices.id；手填单价为 NULL
  note         TEXT NOT NULL DEFAULT '',
  sort         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_work_bill_items_bill ON work_bill_items(bill_id);

-- 结算记录（一单可多笔、部分结算；amount 记实收，与计算金额解耦）
CREATE TABLE work_settlements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id    INTEGER NOT NULL REFERENCES work_bills(id),
  amount     INTEGER NOT NULL,               -- 实收（分）
  settled_at TEXT NOT NULL,                  -- 结算日期 YYYY-MM-DD
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_work_settlements_bill ON work_settlements(bill_id);
