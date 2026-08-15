# 家庭信息助理 · BOT 工作区机制（现状记录）

> **定位**：记录 2026-08-15 对 AstrBot 工作区/文件能力的源码实测结论与讨论结论，供后续开发参考。
> **相关**：《云端接入与维护手册.md》（权威接口）、`homeassistant-tools-inventory.md`（36 个工具实测基准）。
> 注：不包含本地开发方向规划；那些在本地另行设计。

---

## 1. 背景

BOT 现有能力只覆盖"后端 API 数据层"（记账/待办/记忆/订阅）。讨论目标是确认：能否给 BOT 一个**隔离工作区**，用于文件级数据处理（导入数据、存中间产物、导出结果、发文件给用户）。

## 2. 已定决策

1. **不开放任意 python/shell**：`computer_use_require_admin` 保持 `true`，任意代码执行仅管理员。关掉它会连锁放开文件路径限制 + shell，等于把容器级权限交给群成员，不可接受。
2. **工作区存 `/opt/astrbot/data/workspaces/`**，随 data 持久化备份。
3. **文件保存由 LLM 自行调用工具决定**（不自动保存）。由极简独立插件提供"保存入站文件"工具，与家庭助理身份体系解耦。
4. **路径统一走"相对路径自动补全"**：工具只收相对路径，内部补全到当前会话工作区根，`resolve + is_relative_to` 校验，拒绝绝对路径/`../`。
5. **BOT 发文件给用户**：用内置 `send_message_to_user`（type=file）；成员限工作区/tmp 内文件，发到其他会话需 admin。

## 3. 工作区隔离粒度（源码实证）

工作区根 = `{data}/workspaces/{normalize(umo)}`，`umo = 平台:消息类型:会话ID`。QQ 官方适配器（`qqofficial_platform_adapter.py`）：

| 通道 | 会话ID | 工作区归属 |
|------|--------|-----------|
| 私聊 C2C | openid（`adapter.py:239,249`） | 同一用户所有私聊**恒同**一个工作区（QQ 无"新对话"概念） |
| 群聊 | 群号（`adapter.py:204,216`） | **全群共享**一个工作区 |
| 频道 | 频道id | 按频道 |

webchat 才有 `session/project/custom` 更细工作区；当前仅 qq_official，用不到。
严格按人隔离（尤其群聊）需插件从 `x-openid` 映射 person 建子目录。

## 4. 文件工具权限（`computer_use_runtime=local` 时）

| 工具 | 普通成员 | 管理员 |
|------|---------|--------|
| `astrbot_file_read_tool` / `grep_tool` | ✅ 仅工作区 + skills + tmp | ✅ 任意容器路径 |
| `astrbot_file_write_tool` / `edit_tool` | ✅ 仅工作区 + tmp | ✅ 任意 |
| `astrbot_execute_python` / `execute_shell` | ❌ 拒绝 | ✅（cwd=工作区） |

- 成员逃逸被 `allowed_roots` + `is_relative_to` 拦截（`fs.py`）。
- 容器**无 docker.sock、无 `/opt/homeassistant/.env` 挂载** → 摸不到 Docker、宿主、X_API_KEY 源头。
- 容器内进程 **root，插件无沙箱**（插件就是普通 Python，`open/os.makedirs/os.remove` 直接可用）。
- 插件可 `from astrbot.core.utils.astrbot_path import get_astrbot_workspaces_path` + `from astrbot.core.workspace import normalize_umo_for_workspace` 解析路径（已验证可行）。

## 5. 文件处理机制

### 5.1 入站文件（用户 → 工作区）
- QQ 官方收到文件 → `File(name, url)`；agent 侧 `await comp.get_file()` 已下载到 temp（`_apply_file_extract`，`astr_main_agent.py:310`）。**AstrBot 原生无"存工作区"工具**，只读提取。
- 方案：极简插件 `save_uploaded_file(relative_path)`：`await comp.get_file()` → 自动补全到工作区 → `shutil.copy` → `os.remove` temp 副本。**LLM 自行判断是否保存**。
- ⚠️ 异步上下文必须用 `await comp.get_file()`，用 `comp.file` 会返回空串并告警；temp 副本不随事件清理，须手动删。

### 5.2 导出（后端数据 → 工作区）
- 后端加导出端点（如 `GET /api/v1/bills/export?format=json|csv`，按身份头导出本人数据）；插件 `export_ledger_to_workspace(relative_path, format?)` 写入工作区。
- 与 5.1 共用同一套路径 helper。

### 5.3 发文件（工作区 → 用户）
- 内置 `send_message_to_user`（`type: file, path: 相对路径`，按工作区根解析）。
- QQ 官方以 `msg_type=7` 真实文件消息送达（`adapter.py:421/479`），走媒体上传（可能有平台大小限制）。

### 5.4 删除/清理
- **成员 LLM 工具层无删除工具**（内置 fs 无 delete）。
- 讨论结论：清理走"记录 → 统一删"（后端记录删除请求，类 outbox；插件消费删除并清记录），审计在后端、执行在插件。**未实现**。
- 工作区**无自动清理、无大小配额**（`temp_dir_max_size` 只管 temp）。

## 6. 安全红线

1. `computer_use_require_admin=true` 保持；不向成员开放 python/shell。
2. 插件新增工具只收相对路径，内部补全 + `resolve` + `is_relative_to` 校验。
3. 容器 root + 插件无沙箱 → 路径校验必须在插件内做，不依赖 LLM 诚实。
4. 敏感物：`/opt/astrbot/data/cmd_config.json`（面板密码/jwt/provider key）、`data/config/astrbot_star_homeassistant_config.json`（X_API_KEY）。容器可读，仅 admin python 能到；勿下放 runtime。
5. 后端容器（homeassistant-api）**未挂载**工作区目录 → 后端无法直接删工作区文件；若要后端统一删，需插件代删，或给后端挂载（挂载后读工作区文件当数据不当指令，防 prompt-injection 写入的恶意内容）。

## 7. 关键代码参考

| 主题 | 位置 |
|------|------|
| 内置文件工具/权限 | `astrbot/core/tools/computer_tools/fs.py` |
| 发文件工具 | `astrbot/core/tools/message_tools.py`（`send_message_to_user`） |
| 入站文件下载 | `astrbot/core/astr_main_agent.py`（`_apply_file_extract`）、`core/message/components.py`（`File.get_file`） |
| 工作区路径解析 | `astrbot/core/utils/astrbot_path.py`、`astrbot/core/workspace.py` |
| QQ 官方文件收发 | `astrbot/core/platform/sources/qqofficial/qqofficial_platform_adapter.py` |
