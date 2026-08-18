# 家庭信息助理 · AstrBot 插件 LLM 工具清单（实测）

> 来源：云端运行态 `/opt/homeassistant/plugins/astrbot_star_homeassistant/main.py`
> 整理日期：2026-08-15（2026-08-16 同步到 42 个：方向 A 新增 bill_stats / export_bills；方向 B 新增 save_uploaded_file / parse_bills_file / import_bills / delete_file；**2026-08-17 调整为 40 个**：移除记忆域 remember/search_memory/forget，新增待办导出 export_tasks；**2026-08-18 新增 15 个 work_* 工具 → 55 个，随后删除 6 个旧查询工具 → 49 个，再新增 work_bill_stats → 50 个**：工作账单域 + 移除 list_bills/get_bill/query_bill_stats/query_bill_changes/list_bill_trash/restore_bill（已被 bill_stats/export_bills 等替代）+ keyword 搜索/统计/日报/WEB 页面）
> 用途：本地设计文档的权威对照。**新增工具不得与下表重名/同义**；本地要加新工具时，先在文档里追加条目再开发，避免云端部署时撞名。

## 0. 插件骨架（非工具，但契约相关）

| 项 | 实现 |
|----|------|
| 插件名 | `astrbot_star_homeassistant`（display: 家庭信息助理） |
| 配置 | `api_base`（默认 `http://homeassistant-api:3000`）、`api_key`（=X_API_KEY）、`poll_interval`（默认 15s） |
| 身份注入 | 插件按入站事件自动加 `x-platform=qq`、`x-openid=发送者openid`，**不是 LLM 参数** |
| 会话捕获 | `@filter.regex(r".*")` 记录 openid→UMO 映射，供主动推送定位会话 |
| outbox 主动推送 | 后台轮询 `GET /api/v1/outbox/pending?channel=qq&limit=10` → `context.send_message` → 回执 `POST /api/v1/outbox/{id}/delivery` |
| 平台 id | 从 UMO 首段推断（qq_official），无命中时按 `{platform}:FriendMessage:{openid}` 构造 C2C 会话 |

## 1. 工具总表（50 个）

| # | 工具名 | 功能 | 后端端点 |
|---|--------|------|----------|
| 1 | `get_my_identity` | 查询当前用户身份 + 可用账本 | GET `api/v1/identity` |
| 2 | `create_person` | 登记身份（首用引导，幂等） | POST `api/v1/persons` |
| 3 | `create_account` | 创建记账账户 | POST `api/v1/accounts` |
| 4 | `list_my_accounts` | 列出当前用户账本 | GET `api/v1/accounts` |
| 5 | `add_bill` | 单笔记账 | POST `api/v1/bills` |
| 6 | `add_bills` | 批量补录账单 | POST `api/v1/bills/batch` |
| 7 | `update_bill` | 修改账单 | PATCH `api/v1/bills/{id}` |
| 8 | `delete_bill` | 删除账单（软删进回收站） | DELETE `api/v1/bills/{id}` |
| 9 | `settle_bill` | AA 结算 | POST `api/v1/bills/{id}/settle` |
| 10 | `add_task` | 添加待办 | POST `api/v1/tasks` |
| 11 | `list_tasks` | 列出待办 | GET `api/v1/tasks` |
| 12 | `complete_task` | 完成待办 | POST `api/v1/tasks/{id}/done` |
| 13 | `undo_task` | 改回未完成 | POST `api/v1/tasks/{id}/undo` |
| 14 | `update_task` | 修改待办 | PATCH `api/v1/tasks/{id}` |
| 15 | `delete_task` | 删除待办 | DELETE `api/v1/tasks/{id}` |
| 16 | `subscribe_source` | 订阅信息源 | POST `api/v1/subscriptions` |
| 17 | `list_subscriptions` | 列出订阅源 | GET `api/v1/subscriptions` |
| 18 | `unsubscribe` | 退订 | DELETE `api/v1/subscriptions/{id}` |
| 19 | `query_news` | 查已缓存新闻 | GET `api/v1/news` |
| 20 | `fetch_source` | 实时抓取信息源 | POST `api/v1/fetch` |
| 21 | `bind_person` | 绑定已有账号 | POST `api/v1/persons/{id}/bind` |
| 22 | `join_account` | 加入家庭账本 | POST `api/v1/accounts/{id}/join` |
| 23 | `unbind_identity` | 解绑平台身份 | DELETE `api/v1/persons/{id}/identities/{platform}/{openid}` |
| 24 | `set_primary_identity` | 切换主身份 | PATCH `api/v1/persons/me/primary-identity` |
| 25 | `create_ledger_link` | 生成账本网页链接 | POST `api/v1/web/tokens` |
| 26 | `list_ledger_links` | 列出已生成账本链接 | GET `api/v1/web/tokens` |
| 27 | `revoke_ledger_link` | 撤销账本链接 | DELETE `api/v1/web/tokens/{id}` |
| 28 | `bill_stats` | 收支统计（含图表，chart=true 发统计图） | GET `api/v1/bills/stats/range` |
| 29 | `export_bills` | 账单明细查询/CSV 导出（text/workspace/user/both） | GET `api/v1/bills/export` |
| 30 | `save_uploaded_file` | 保存用户发送的文件到会话工作区 | —（无后端，文件落盘工作区） |
| 31 | `parse_bills_file` | 解析工作区账单文件（xlsx/xls/csv）为结构化明细 | —（读工作区文件） |
| 32 | `import_bills` | 解析工作区账单文件并批量导入（宽容，坏行跳过） | POST `api/v1/bills/import` |
| 33 | `delete_file` | 删除工作区文件/目录（不可恢复） | —（无后端） |
| 34 | `export_tasks` | 待办明细查询/CSV 导出（text/workspace/user/both） | GET `api/v1/tasks/export` |
| 35 | `add_work_client` | 新建委托方（装修公司/个人） | POST `api/v1/work-clients` |
| 36 | `list_work_clients` | 列出委托方 | GET `api/v1/work-clients` |
| 37 | `update_work_client` | 修改委托方 | PATCH `api/v1/work-clients/{id}` |
| 38 | `delete_work_client` | 删除委托方（有账单不可删） | DELETE `api/v1/work-clients/{id}` |
| 39 | `set_work_price` | 设置单价（按委托方，upsert） | POST `api/v1/work-unit-prices` |
| 40 | `list_work_prices` | 列出单价表 | GET `api/v1/work-unit-prices` |
| 41 | `delete_work_price` | 删除单价记录 | DELETE `api/v1/work-unit-prices/{id}` |
| 42 | `add_work_bill` | 新建工作账单（明细内嵌，自动带价） | POST `api/v1/work-bills` |
| 43 | `list_work_bills` | 列出工作账单（宽过滤 + applied 回显） | GET `api/v1/work-bills` |
| 44 | `get_work_bill` | 查看账单完整明细 + 对账 | GET `api/v1/work-bills/{id}` |
| 45 | `update_work_bill` | 修改账单（items 全量替换） | PATCH `api/v1/work-bills/{id}` |
| 46 | `delete_work_bill` | 删除账单（软删） | DELETE `api/v1/work-bills/{id}` |
| 47 | `settle_work_bill` | 记录一笔结算实收（可多次/部分） | POST `api/v1/work-bills/{id}/settle` |
| 48 | `recalc_work_bills` | 批量重算未结算单（dry_run 预览/apply） | POST `api/v1/work-bills/recalc` |
| 49 | `export_work_bills` | 账单查询/CSV 导出（summary/statement） | GET `api/v1/work-bills/export` |
| 50 | `work_bill_stats` | 工作账单统计（合计应收/已收/欠款 + 按委托方/月份，chart 出图） | GET `api/v1/work-bills/stats` |

## 2. 各工具 LLM 参数签名

参数均走 LLM 工具签名（snake_case），`?` 为可选。

### 身份域
- `get_my_identity()` — 无参数。返回是否已登记 + 名字 + 可用账本
- `create_person(display_name: string)` — 首用引导，幂等
- `bind_person(person_id: int)` — 绑到已有账号
- `unbind_identity(person_id: int, platform: str, openid: str)` — platform ∈ {qq, wechat}
- `set_primary_identity(platform: str, openid: str)`

### 账本域
- `create_account(type: str="personal", name: str?)` — type ∈ {personal, family}
- `list_my_accounts()`
- `join_account(account_id: int)`

### 记账域
- `add_bill(type: str, amount: float, category?: str, note?: str, participants?: list, account_id?: int)` — type ∈ {income, expense}
- `add_bills(bills: list, account_id?: int)` — bills 元素 {type, amount, category?, note?, occurred_at?, participants?}
- `update_bill(bill_id: int, type?: str, amount?: float, category?: str, note?: str, participants?: list, occurred_at?: str)` — occurred_at 格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS（2026-08-17 补，修正导入的日期错误）
- `delete_bill(bill_id: int)` — 软删进回收站；回收站查看/恢复走记账网页「回收站」页（旧 list_bill_trash/restore_bill 工具已删除）
- `settle_bill(bill_id: int, participant_name?: str, all?: bool)`
- `bill_stats(year?: int, month?: int, from_date?: str, to_date?: str, category?: str, amount_min?: int, amount_max?: int, account_id?: int, chart?: bool=True)` — 区间统计（`from_date/to_date` 优先于 `year/month`；金额单位「分」；`chart=True` 时 matplotlib 渲染「支出构成+收支趋势」PNG 并发送，金额展示为「元」）；后端 `GET /api/v1/bills/stats/range`
- `export_bills(type?: str, category?: str, status?: str, participant?: str, month?: str, year?: int, from_date?: str, to_date?: str, amount_min?: int, amount_max?: int, account_id?: int, destination?: str="text", relative_path?: str, limit?: int=20)` — destination ∈ {text, workspace, user, both}；text 走 json 明细（**每行带 `#id`**，供 update_bill/delete_bill 定位；limit 上限 50），文件导出走 csv（workspace 存当前会话工作区按 `relative_path` 或自动命名，user 直接发 CSV 文件，both 两者）；后端 `GET /api/v1/bills/export`

### 文件导入域（方向 B，2026-08-16 云端上线）
- `save_uploaded_file(relative_path?: str)` — 把用户发送的文件（只处理第一个附件）保存到当前会话工作区；相对路径缺省用原文件名；成功后删 temp 副本
- `parse_bills_file(relative_path: str, limit?: int=20)` — 解析工作区 xlsx/xls/csv 为结构化账单行（文件金额默认「元」→ 显示为「分」；坏行跳过并说明原因）
- `import_bills(relative_path: str, account_id?: int)` — 解析文件 + POST `/api/v1/bills/import`（宽容：坏行记 `failures` 不阻断，≤500 笔）；返回 ok_count + 失败行 `index/code/message`
- `delete_file(relative_path: str)` — 删除工作区文件/目录（不可恢复，插件日志记录）

### 待办域
- `add_task(content: str, category?: str, remind_at?: str, account_id?: int)` — remind_at 格式 YYYY-MM-DD HH:MM
- `list_tasks(is_done?: bool, q?: str, category?: str, from_date?: str, to_date?: str, page?: int, page_size?: int, account_id?: int)` — 默认只看未完成（is_done 不传即未完成）；`q` 内容关键词空格分隔多个词须全部命中；`from_date/to_date` 为创建日期 YYYY-MM-DD；回复带 `total` + 「已生效筛选」自验证（读工具标准形态，2026-08-17 增强）
- `complete_task(task_id: int)`
- `undo_task(task_id: int)` — 误标完成时改回未完成
- `update_task(task_id: int, content?: str, category?: str, remind_at?: str)`
- `delete_task(task_id: int)`
- `export_tasks(is_done?: bool, q?: str, category?: str, from_date?: str, to_date?: str, account_id?: int, destination?: str="text", relative_path?: str, limit?: int=20)` — destination ∈ {text, workspace, user, both}；**is_done 缺省 = 全部**（区别于 list_tasks 的默认未完成）；text 走 json 明细（每行带 `#id`），文件导出走 csv（workspace 存当前会话工作区 / user 直接发 CSV / both 两者）；后端 `GET /api/v1/tasks/export`

### 工作账单域（2026-08-18）
- `add_work_client(name: str, type?: str="company", phone?: str, note?: str, account_id?: int)` — type ∈ {company, personal}
- `list_work_clients(q?: str, account_id?: int)`
- `update_work_client(client_id: int, name?: str, type?: str, phone?: str, note?: str)`
- `delete_work_client(client_id: int)` — 其下还有未删除账单时后端 `CLIENT_HAS_BILLS`
- `set_work_price(client_id: int, name: str, unit_price: int, unit?: str="个", note?: str, account_id?: int)` — **按委托方区分价格**；unit_price 单位「分」（1 元 = 100 分）；同名 upsert
- `list_work_prices(client_id?: int, q?: str, account_id?: int)`
- `delete_work_price(price_id: int, account_id?: int)` — 历史账单单价快照不受影响
- `add_work_bill(client_id: int, items: list, address?: str, contact?: str, occurred_at?: str, note?: str, final_amount?: int, account_id?: int)` — items=[{name, qty?, unit?, unit_price?, note?}]；**unit_price 缺省自动按该委托方单价表带出**（表内无价则必须传）；`金额 = Σ(qty×unit_price)`；final_amount 单位「分」= 实际应收覆盖
- `list_work_bills(client_id?: int, contact?: str, keyword?: str, status?: str, from_date?: str, to_date?: str, account_id?: int, page?: int, page_size?: int)` — status ∈ {unsettled, partial, settled}（派生）；`keyword`=地址或备注包含（多 token AND）；回显 `total` + 「已生效筛选」
- `get_work_bill(bill_id: int)` — 完整明细 + 式子 + 应收/已收/欠款/状态
- `update_work_bill(bill_id: int, client_id?: int, address?: str, contact?: str, occurred_at?: str, note?: str, final_amount?: int, items?: list)` — **items 全量替换**；final_amount=0 清除
- `delete_work_bill(bill_id: int)` — 软删
- `settle_work_bill(bill_id: int, amount: int, settled_at?: str, note?: str)` — amount 单位「分」**实收**（可多次/部分，与计算金额解耦）
- `recalc_work_bills(bill_ids?: list, client_id?: int, from_date?: str, to_date?: str, apply?: bool=False)` — **改单价不自动级联**；默认 dry_run 预览 diff，apply=true 才提交；只重算未完全结算单（已结算锁定）
- `export_work_bills(mode?: str="summary", client_id?: int, keyword?: str, from_date?: str, to_date?: str, status?: str, account_id?: int, destination?: str="text", relative_path?: str, limit?: int=20)` — mode ∈ {summary=日常简版, statement=结账版（含计算式子）}；`keyword`=地址或备注包含；destination 四模式同 export_bills；后端 `GET /api/v1/work-bills/export`
- `work_bill_stats(year?: int, month?: int, from_date?: str, to_date?: str, client_id?: int, status?: str, account_id?: int, chart?: bool=False)` — 区间统计 `GET /api/v1/work-bills/stats`：合计应收/已收/欠款 + 按委托方（欠款降序）+ 按月份；`chart=True` 时 matplotlib 渲染「按委托方欠款 + 按月应收/已收」PNG 发送（单位元）

### 订阅/新闻域
- `subscribe_source(source_type: str, name?: str, source_url?: str, preset_key?: str)` — source_type ∈ {rss, preset}
- `list_subscriptions()`
- `unsubscribe(subscription_id: int)`
- `query_news(subscription_id?: int, limit?: int)`

### 抓取域
- `fetch_source(source_type: str, source_url?: str, preset_key?: str, params?: dict)` — source_type ∈ {rss, url, preset}

### 账本链接域
- `create_ledger_link(mode: str="read", expires_in?: int)` — mode ∈ {read, write}，expires_in 分钟 1-1440
- `list_ledger_links()` — 列出已生成链接及过期状态
- `revoke_ledger_link(token_id: int)`

## 3. 契约要点（LLM 工具签名层的硬约束）

1. **金额单位是「分」**：`amount` 工具层强制 `int(amount)`，1 元 = 100 分。所有返回里的金额也带「分」字。
2. **AA 分摊**：`add_bill` 带 `participants`（名字数组）→ 账单 `status=pending` → `settle_bill` 结算。用户说「AA/平摊/垫付」时要先问清参与者再传。
3. **多账本歧义**：用户有多个账本时，记账/查账/待办必须传 `account_id`，否则后端返回 ACCOUNT_AMBIGUOUS，由 LLM 引导指定。
4. **软删除闭环**：`delete_bill` 软删进回收站；回收站查看/恢复走记账网页「回收站」页（LLM 侧旧 list_bill_trash/restore_bill 工具已于 2026-08-18 删除，替代工具实测无问题）。
5. **日期格式**：`month`=YYYY-MM、`date`=YYYY-MM-DD、`remind_at`=YYYY-MM-DD HH:MM。
6. **source_type 因工具而异**：`subscribe_source` 只收 rss|preset；`fetch_source` 收 rss|url|preset。
7. **身份不在 LLM 参数里**：x-platform/x-openid 由插件注入，LLM 猜不到也传不了——本地设计文档不要设计「让 LLM 传身份」的工具。
8. **`get_my_identity` 未登记时返回引导语**，引导链：create_person → create_account → add_bill。
9. **新查询/统计工具（方向 A，2026-08-16 云端上线）**：`export_bills`/`bill_stats` 对接 `/bills/export` 与 `/bills/stats/range`；金额过滤单位「分」；后端回显 `applied`（实际生效筛选），工具回复带「已生效筛选」供 LLM 自验证；`bill_stats` 图表由插件 matplotlib 渲染 PNG 直接发送。
10. **旧查询/统计工具已删除（2026-08-18）**：list_bills/get_bill/query_bill_stats/query_bill_changes/list_bill_trash/restore_bill 六工具与其 `disable_legacy_query_tools` 停用机制一并移除（替代工具 bill_stats/export_bills 实测通过）。**后端端点 `/bills/trash`、`/bills/{id}/restore`、`/bills/changes`、`/bills/stats` 仍保留**，仅插件不再暴露为 LLM 工具。
11. **文件导入（方向 B，2026-08-16 云端上线）**：`save_uploaded_file` → `parse_bills_file`（预览确认）→ `import_bills`（宽容入库）→ `delete_file`（清理）。文件金额默认「元」，插件解析时换算为「分」（区别于 LLM 工具参数约定——文件解析是插件职责，不做整批 400，坏行在 `failures` 里反馈 LLM 自修正）。工作区文件路径一律相对路径，插件 `resolve + is_relative_to` 校验防逃逸。

## 4. 新工具开发约定（写进本地文档）

- 新增工具**先确认不与上表 50 个重名**（含语义相同仅改名的，如已有 `add_bill` 就别再写 `record_bill`/`log_expense`）。
- 每个工具 = `@filter.llm_tool(name="...")` + async 方法 + **带 Args 的 docstring**（AstrBot 用 docstring 生成 LLM 工具描述，参数名/类型/单位/枚举都要写清楚）。
- 走 `self._api(method, path, identity=self._identity(event), json_body=...)`，统一错误返回为失败字典。
- 工具描述里写明行为约定（如 add_bill 的 AA 规则、participants 格式），LLM 靠描述触发正确调用。
