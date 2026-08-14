"""
家庭信息助理 · AstrBot Star 插件（M7，全功能接入）

接入层：让 QQ 机器人（鸡煲大人2.0）通过 LLM 工具调用 homeassistant API。
  - 身份：get_my_identity / create_person / bind_person / unbind_identity /
    set_primary_identity，身份头由插件注入（x-platform=qq,
    x-openid=消息发送者 openid，见 src/lib/identity.ts）。
  - 账本：create_account / list_my_accounts / join_account。
  - 记账：add_bill / add_bills(批量) / update_bill / delete_bill / settle_bill /
    list_bills / query_bill_stats / query_bill_changes（含 AA 分摊）。
  - 待办：add_task / list_tasks / complete_task / update_task / delete_task。
  - 订阅/新闻：subscribe_source / list_subscriptions / unsubscribe / query_news。
  - 记忆：remember / search_memory / forget。
  - 抓取：fetch_source（SSRF 白名单由后端把关）。
  - 账本链接：create_ledger_link / revoke_ledger_link。
  - outbox：后台轮询 /api/v1/outbox/pending?channel=qq，经
    context.send_message(umo, ...) 主动推送到 QQ（C2C 无需 msg_id，
    见 qqofficial 适配器 _send_by_session_common），并回报 sent/failed。

配置（WebUI 插件面板 / _conf_schema.json）：
  api_base      家庭信息助理 API 地址（默认 http://homeassistant-api:3000，走共享网络）
  api_key       X_API_KEY（/opt/homeassistant/.env，勿外泄）
  poll_interval outbox 轮询间隔秒数
"""
import asyncio

import httpx

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.message.message_event_result import MessageChain

DEFAULT_API_BASE = "http://homeassistant-api:3000"
DEFAULT_POLL_INTERVAL = 15


class HomeAssistantStar(Star):
    def __init__(self, context: Context, config: dict = None):
        super().__init__(context)
        self.config = config or {}
        self.api_base = str(self.config.get("api_base") or DEFAULT_API_BASE).rstrip("/")
        self.api_key = str(self.config.get("api_key") or "").strip()
        try:
            self.poll_interval = max(5, int(self.config.get("poll_interval") or DEFAULT_POLL_INTERVAL))
        except (TypeError, ValueError):
            self.poll_interval = DEFAULT_POLL_INTERVAL
        # openid -> unified_msg_origin（从每个入站消息捕获），供 outbox 主动推送定位会话
        self._session_map: dict[str, str] = {}
        # qq_official 适配器的平台 id（UMO 首段），用于无注册表命中时构造 C2C 会话
        self._platform_id: str | None = None
        self._outbox_task: asyncio.Task | None = None

    # ────────────────────────── 生命周期 ──────────────────────────

    async def initialize(self) -> None:
        """插件激活时启动 outbox 轮询（官方建议在 initialize 里起后台任务）。"""
        self._outbox_task = asyncio.create_task(self._outbox_loop())
        logger.info(
            f"[HomeAssistant] 插件已激活 api_base={self.api_base} "
            f"poll_interval={self.poll_interval}s"
        )

    async def terminate(self) -> None:
        if self._outbox_task:
            self._outbox_task.cancel()
            try:
                await self._outbox_task
            except (asyncio.CancelledError, Exception):
                pass
            self._outbox_task = None

    # ────────────────────────── HTTP 帮助 ──────────────────────────

    async def _api(self, method: str, path: str, *, identity=None, json_body=None) -> dict:
        """调 homeassistant API；identity=(platform, openid) 时注入身份头。"""
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if identity:
            headers["x-platform"] = identity[0]
            headers["x-openid"] = identity[1]
        url = f"{self.api_base}/{path.lstrip('/')}"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.request(method, url, json=json_body, headers=headers)
            logger.debug(f"[HomeAssistant] {method} {path} -> {resp.status_code}")
            if resp.status_code >= 400:
                return {"ok": False, "http": resp.status_code, "body": resp.text[:500]}
            try:
                return resp.json()
            except ValueError:
                return {"ok": False, "http": resp.status_code, "body": resp.text[:500]}
        except Exception as e:  # 网络/超时等，统一返回失败字典，让工具层提示
            logger.error(f"[HomeAssistant] 请求失败 {method} {path}: {e}")
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _identity(event: AstrMessageEvent):
        return ("qq", event.get_sender_id())

    # ────────────────────────── 会话注册 ──────────────────────────

    @filter.regex(r".*")
    async def _capture_session(self, event: AstrMessageEvent):
        """每个入站消息记录 openid -> unified_msg_origin，供 outbox 定位会话。"""
        try:
            sender = event.get_sender_id()
            umo = event.unified_msg_origin
            if sender and umo:
                self._session_map[sender] = umo
                if self._platform_id is None:
                    self._platform_id = umo.split(":", 1)[0]
        except Exception as e:
            logger.debug(f"[HomeAssistant] 会话捕获跳过: {e}")

    # ────────────────────────── LLM 工具 ──────────────────────────

    @filter.llm_tool(name="get_my_identity")
    async def get_my_identity(self, event: AstrMessageEvent) -> str:
        """查询当前 QQ 用户是否已登记身份及其账户。

        Args:
        """
        data = await self._api("GET", "api/v1/identity", identity=self._identity(event))
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        if data.get("bound"):
            p = data.get("person") or {}
            name = p.get("display_name") or p.get("nickname") or "（无名字）"
            accounts = data.get("accounts") or []
            acc = "，".join(
                f"{a.get('name')}(#{a.get('id')})" for a in accounts
            ) or "无（请先创建账本）"
            return f"已登记：{name}。可用账本：{acc}"
        return "该用户尚未登记身份。请先询问用户希望怎么称呼，然后调用 create_person 登记。"

    @filter.llm_tool(name="create_person")
    async def create_person(self, event: AstrMessageEvent, display_name: str) -> str:
        """为当前 QQ 用户创建/登记身份（首次使用引导，幂等）。

        Args:
            display_name(string): 用户希望被称呼的名字。
        """
        data = await self._api(
            "POST", "api/v1/persons",
            identity=self._identity(event), json_body={"display_name": display_name},
        )
        if not data.get("ok", True):
            return f"登记失败：{data.get('body') or data.get('error') or data}"
        p = data.get("person") or {}
        name = p.get("display_name") or p.get("nickname") or display_name
        if data.get("already_bound"):
            return f"该账号已登记过身份（{name}），无需重复创建。"
        return (
            f"登记成功！以后称呼你为「{name}」。请先创建你的记账账本"
            f"（个人账本），创建后就可以记账了。"
        )

    @filter.llm_tool(name="create_account")
    async def create_account(
        self,
        event: AstrMessageEvent,
        type: str = "personal",
        name: str = None,
    ) -> str:
        """为当前用户创建一个记账账户（新用户首次记账前必须已有账户）。

        Args:
            type(string): personal（个人账本）或 family（家庭账本），默认 personal。
            name(string): 账本名称，如「我的账本」「我家」，可选。
        """
        body = {"type": type}
        if name:
            body["name"] = name
        data = await self._api(
            "POST", "api/v1/accounts", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"创建账本失败：{data.get('body') or data.get('error') or data}"
        a = data.get("account") or {}
        return (
            f"账本已创建：{a.get('name')}(#{a.get('id')})，类型 {a.get('type')}。"
            f"现在可以记账了，例如「记一笔：午饭 30 元」。"
        )

    @filter.llm_tool(name="list_my_accounts")
    async def list_my_accounts(self, event: AstrMessageEvent) -> str:
        """列出当前用户可用的记账账户（有多个账本时记账需指定 account_id）。"""
        data = await self._api("GET", "api/v1/accounts", identity=self._identity(event))
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        accounts = data.get("accounts") or []
        if not accounts:
            return "你还没有记账账户，请先调用 create_account 创建一个。"
        lines = [
            f"{a.get('name')}(#{a.get('id')})，类型 {a.get('type')}"
            for a in accounts
        ]
        return "你的账本：\n" + "\n".join(lines)

    @filter.llm_tool(name="add_bill")
    async def add_bill(
        self,
        event: AstrMessageEvent,
        type: str,
        amount: float,
        category: str = None,
        note: str = None,
        participants: list = None,
        account_id: int = None,
    ) -> str:
        """记录一笔账（单笔直记；AA/平摊时务必把参与者列出，之后可再结算）。

        Args:
            type(string): income 或 expense（收入/支出）。
            amount(number): 金额（单位：分，1 元 = 100 分）。
            category(string): 分类，如 餐饮/交通/购物。
            note(string): 备注。
            participants(array): AA 分摊的参与者名字列表，如 ["张三","李四"]。用户说「AA」「平摊」「垫付」时先问清参与者有谁再传；只有一人/无分摊则不传。
            account_id(number): 记账账户 id，用户有多个账本时必须指定。
        """
        body = {"type": type, "amount": int(amount)}
        if category:
            body["category"] = category
        if note:
            body["note"] = note
        if participants:
            body["participants"] = self._normalize_participants(participants)
        if account_id:
            body["account_id"] = account_id
        data = await self._api(
            "POST", "api/v1/bills", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"记账失败：{data.get('body') or data.get('error') or data}"
        b = data.get("bill") or {}
        kind = "支出" if b.get("type") == "expense" else "收入"
        aa = "（AA 待结算）" if b.get("status") == "pending" else ""
        return (
            f"已记录#{b.get('id')}：{kind} {b.get('amount')}分 "
            f"（{b.get('category') or '未分类'}）{aa}备注：{b.get('note') or '无'}"
        )

    @filter.llm_tool(name="settle_bill")
    async def settle_bill(
        self,
        event: AstrMessageEvent,
        bill_id: int,
        participant_name: str = None,
        all: bool = False,
    ) -> str:
        """结算一笔 AA 账单（标记某参与人已付款，或一次性全部结清）。

        Args:
            bill_id(number): 账单 id（来自记账或查账结果的 #id）。
            participant_name(string): 要结算的参与人名字（可选）。
            all(boolean): 是否全部结清（可选，默认 false）。
        """
        body = {}
        if participant_name:
            body["participant_name"] = participant_name
        if all:
            body["all"] = True
        data = await self._api(
            "POST", f"api/v1/bills/{bill_id}/settle",
            identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"结算失败：{data.get('body') or data.get('error') or data}"
        b = data.get("bill") or {}
        state = "已全部结清" if b.get("status") == "settled" else "仍待结算"
        return f"账单#{b.get('id')}：{state}。参与人：{b.get('participants')}"

    @filter.llm_tool(name="update_bill")
    async def update_bill(
        self,
        event: AstrMessageEvent,
        bill_id: int,
        type: str = None,
        amount: float = None,
        category: str = None,
        note: str = None,
        participants: list = None,
    ) -> str:
        """修改一笔已记录的账单（只需传要改的字段，其他不变）。

        Args:
            bill_id(number): 账单 id（来自记账或查账结果的 #id）。
            type(string): income 或 expense（可选）。
            amount(number): 金额（分）（可选）。
            category(string): 分类（可选）。
            note(string): 备注（可选）。
            participants(array): AA 参与者名单（可选）。
        """
        body = {}
        if type:
            body["type"] = type
        if amount is not None:
            body["amount"] = int(amount)
        if category:
            body["category"] = category
        if note:
            body["note"] = note
        if participants:
            body["participants"] = self._normalize_participants(participants)
        data = await self._api(
            "PATCH", f"api/v1/bills/{bill_id}",
            identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"修改失败：{data.get('body') or data.get('error') or data}"
        b = data.get("bill") or {}
        kind = "支出" if b.get("type") == "expense" else "收入"
        return (
            f"已修改#{b.get('id')}：{kind} {b.get('amount')}分 "
            f"（{b.get('category') or '未分类'}）备注：{b.get('note') or '无'}"
        )

    @filter.llm_tool(name="delete_bill")
    async def delete_bill(self, event: AstrMessageEvent, bill_id: int) -> str:
        """删除一笔账单（软删除，进回收站，可恢复）。

        Args:
            bill_id(number): 账单 id。
        """
        data = await self._api(
            "DELETE", f"api/v1/bills/{bill_id}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"删除失败：{data.get('body') or data.get('error') or data}"
        return f"已删除账单#{bill_id}（进了回收站，如需恢复可再说）。"

    @staticmethod
    def _normalize_participants(participants: list) -> list:
        """把 LLM 可能给出的 ["张三","李四"] 或 [{"name":"张三"}] 归一成 API 需要的 [{"name":...}]。"""
        out = []
        for p in participants:
            if isinstance(p, str) and p.strip():
                out.append({"name": p.strip()})
            elif isinstance(p, dict) and p.get("name"):
                out.append({"name": p["name"]})
        return out

    @filter.llm_tool(name="list_bills")
    async def list_bills(
        self,
        event: AstrMessageEvent,
        account_id: int = None,
        month: str = None,
    ) -> str:
        """列出用户最近的账单。

        Args:
            account_id(number): 记账账户 id（用户有多个账本时必须指定）。
            month(string): 月份筛选，格式 YYYY-MM（可选）。
        """
        params = {}
        if account_id:
            params["account_id"] = account_id
        if month:
            params["month"] = month
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        data = await self._api(
            "GET", f"api/v1/bills?{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        items = data.get("items") or []
        if not items:
            return "暂无账单。"
        lines = []
        for it in items[:10]:
            kind = "支出" if it.get("type") == "expense" else "收入"
            lines.append(
                f"#{it.get('id')} {it.get('occurred_at', '')} {kind} {it.get('amount')}分 "
                f"{it.get('category') or ''} {it.get('note') or ''}"
            )
        return "最近账单：\n" + "\n".join(lines)

    @filter.llm_tool(name="query_bill_stats")
    async def query_bill_stats(
        self,
        event: AstrMessageEvent,
        year: int = None,
        month: int = None,
        account_id: int = None,
    ) -> str:
        """查询账单统计汇总（支出/收入）。

        Args:
            year(number): 年份，如 2026（可选）。
            month(number): 月份 1-12（可选）。
            account_id(number): 记账账户 id（用户有多个账本时必须指定）。
        """
        params = {}
        if year:
            params["year"] = year
        if month:
            params["month"] = month
        if account_id:
            params["account_id"] = account_id
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        data = await self._api(
            "GET", f"api/v1/bills/stats?{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        return f"账单统计：{data}"

    # ────────────────────────── 批量/变动 ──────────────────────────

    @filter.llm_tool(name="add_bills")
    async def add_bills(
        self,
        event: AstrMessageEvent,
        bills: list,
        account_id: int = None,
    ) -> str:
        """批量补录多笔账单（先向用户复述清单、确认无误后再调用本工具入库）。

        Args:
            bills(array): 账单数组，每笔含 {type, amount, category?, note?, occurred_at?, participants?}。
            account_id(number): 记账账户 id（可选）。
        """
        body = {"bills": []}
        for b in bills or []:
            if not isinstance(b, dict):
                continue
            item = {"type": b.get("type"), "amount": int(b.get("amount") or 0)}
            if b.get("category"):
                item["category"] = b["category"]
            if b.get("note"):
                item["note"] = b["note"]
            if b.get("occurred_at"):
                item["occurred_at"] = b["occurred_at"]
            if b.get("participants"):
                item["participants"] = self._normalize_participants(b["participants"])
            body["bills"].append(item)
        if account_id:
            body["account_id"] = account_id
        data = await self._api(
            "POST", "api/v1/bills/batch", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"批量录入失败：{data.get('body') or data.get('error') or data}"
        return f"已批量录入 {data.get('count')} 笔，ids={data.get('bill_ids')}"

    @filter.llm_tool(name="query_bill_changes")
    async def query_bill_changes(self, event: AstrMessageEvent, date: str = None) -> str:
        """查询某天的账单变动汇总（新增/修改/删除/恢复/AA结算）。

        Args:
            date(string): 日期 YYYY-MM-DD，默认今天（可选）。
        """
        qs = f"?date={date}" if date else ""
        data = await self._api(
            "GET", f"api/v1/bills/changes{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        return f"账单变动：{data}"

    # ────────────────────────── 待办事项 ──────────────────────────

    @filter.llm_tool(name="add_task")
    async def add_task(
        self,
        event: AstrMessageEvent,
        content: str,
        category: str = None,
        remind_at: str = None,
        account_id: int = None,
    ) -> str:
        """添加一条家庭待办事项。

        Args:
            content(string): 事项内容。
            category(string): 分类（可选）。
            remind_at(string): 提醒时间，格式 YYYY-MM-DD HH:MM（可选）。
            account_id(number): 归属账户 id（可选）。
        """
        body = {"content": content}
        if category:
            body["category"] = category
        if remind_at:
            body["remind_at"] = remind_at
        if account_id:
            body["account_id"] = account_id
        data = await self._api(
            "POST", "api/v1/tasks", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"添加失败：{data.get('body') or data.get('error') or data}"
        t = data.get("task") or {}
        return f"已添加事项#{t.get('id')}：{t.get('content')}（{t.get('category') or '未分类'}）"

    @filter.llm_tool(name="list_tasks")
    async def list_tasks(
        self,
        event: AstrMessageEvent,
        is_done: bool = None,
        account_id: int = None,
    ) -> str:
        """列出家庭待办事项。

        Args:
            is_done(boolean): 是否只显示已完成（可选，默认未完成）。
            account_id(number): 归属账户 id（可选）。
        """
        params = {}
        if is_done is not None:
            params["is_done"] = "1" if is_done else "0"
        if account_id:
            params["account_id"] = account_id
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        data = await self._api(
            "GET", f"api/v1/tasks?{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        items = data.get("items") or []
        if not items:
            return "暂无待办事项。"
        lines = []
        for it in items[:15]:
            done = "✅" if it.get("is_done") else "⬜"
            remind = f" 提醒:{it.get('remind_at')}" if it.get("remind_at") else ""
            lines.append(f"{done} #{it.get('id')} {it.get('content')}{remind}")
        return "待办事项：\n" + "\n".join(lines)

    @filter.llm_tool(name="complete_task")
    async def complete_task(self, event: AstrMessageEvent, task_id: int) -> str:
        """标记一条待办已完成。

        Args:
            task_id(number): 事项 id。
        """
        data = await self._api(
            "POST", f"api/v1/tasks/{task_id}/done", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"操作失败：{data.get('body') or data.get('error') or data}"
        return f"已完成事项#{task_id}。"

    @filter.llm_tool(name="update_task")
    async def update_task(
        self,
        event: AstrMessageEvent,
        task_id: int,
        content: str = None,
        category: str = None,
        remind_at: str = None,
    ) -> str:
        """修改一条待办的内容/分类/提醒时间。

        Args:
            task_id(number): 事项 id。
            content(string): 新内容（可选）。
            category(string): 新分类（可选）。
            remind_at(string): 新提醒时间（可选）。
        """
        body = {}
        if content:
            body["content"] = content
        if category:
            body["category"] = category
        if remind_at:
            body["remind_at"] = remind_at
        data = await self._api(
            "PATCH", f"api/v1/tasks/{task_id}", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"修改失败：{data.get('body') or data.get('error') or data}"
        return f"已修改事项#{task_id}。"

    @filter.llm_tool(name="delete_task")
    async def delete_task(self, event: AstrMessageEvent, task_id: int) -> str:
        """删除一条待办。

        Args:
            task_id(number): 事项 id。
        """
        data = await self._api(
            "DELETE", f"api/v1/tasks/{task_id}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"删除失败：{data.get('body') or data.get('error') or data}"
        return f"已删除事项#{task_id}。"

    # ────────────────────────── 订阅与新闻 ──────────────────────────

    @filter.llm_tool(name="subscribe_source")
    async def subscribe_source(
        self,
        event: AstrMessageEvent,
        source_type: str,
        name: str = None,
        source_url: str = None,
        preset_key: str = None,
    ) -> str:
        """订阅一个信息源（RSS 或预设适配器）。

        Args:
            source_type(string): rss 或 preset。
            name(string): 订阅名称（可选）。
            source_url(string): RSS 地址（source_type=rss 时必填）。
            preset_key(string): 预设适配器键名，如 steam_news（source_type=preset 时必填）。
        """
        body = {"source_type": source_type}
        if name:
            body["name"] = name
        if source_url:
            body["source_url"] = source_url
        if preset_key:
            body["preset_key"] = preset_key
        data = await self._api(
            "POST", "api/v1/subscriptions", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"订阅失败：{data.get('body') or data.get('error') or data}"
        s = data.get("subscription") or {}
        return f"已订阅：{s.get('name') or name}（#{s.get('id')}）"

    @filter.llm_tool(name="list_subscriptions")
    async def list_subscriptions(self, event: AstrMessageEvent) -> str:
        """列出当前用户的订阅源。"""
        data = await self._api(
            "GET", "api/v1/subscriptions", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        subs = data.get("subscriptions") or []
        if not subs:
            return "暂无订阅。"
        lines = [
            f"#{s.get('id')} {s.get('name')}（{s.get('source_type')}）"
            for s in subs
        ]
        return "订阅源：\n" + "\n".join(lines)

    @filter.llm_tool(name="unsubscribe")
    async def unsubscribe(self, event: AstrMessageEvent, subscription_id: int) -> str:
        """退订一个信息源。

        Args:
            subscription_id(number): 订阅 id。
        """
        data = await self._api(
            "DELETE", f"api/v1/subscriptions/{subscription_id}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"退订失败：{data.get('body') or data.get('error') or data}"
        return f"已退订订阅#{subscription_id}。"

    @filter.llm_tool(name="query_news")
    async def query_news(
        self,
        event: AstrMessageEvent,
        subscription_id: int = None,
        limit: int = None,
    ) -> str:
        """查询已缓存的信息源新闻。

        Args:
            subscription_id(number): 指定订阅的新闻（可选）。
            limit(number): 返回条数（可选，默认 10）。
        """
        params = {}
        if subscription_id:
            params["subscription_id"] = subscription_id
        if limit:
            params["limit"] = limit
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        data = await self._api(
            "GET", f"api/v1/news?{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        items = data.get("items") or []
        if not items:
            return "暂无新闻。"
        lines = []
        for it in items[:limit or 10]:
            lines.append(f"- {it.get('title') or it.get('summary') or '(无标题)'}")
        return "新闻：\n" + "\n".join(lines)

    # ────────────────────────── 记忆 ──────────────────────────

    @filter.llm_tool(name="remember")
    async def remember(self, event: AstrMessageEvent, content: str, category: str = None) -> str:
        """记住一条关于用户的零散记忆（如喜好、WiFi、习惯等）。

        Args:
            content(string): 要记住的内容。
            category(string): 分类（可选）。
        """
        body = {"content": content}
        if category:
            body["category"] = category
        data = await self._api(
            "POST", "api/v1/memories", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"记住失败：{data.get('body') or data.get('error') or data}"
        return f"已记住#{data.get('id')}：{content}"

    @filter.llm_tool(name="search_memory")
    async def search_memory(self, event: AstrMessageEvent, q: str = None) -> str:
        """检索关于用户的记忆。

        Args:
            q(string): 关键词（可选，空则列最近记忆）。
        """
        qs = f"?q={q}" if q else ""
        data = await self._api(
            "GET", f"api/v1/memories{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"检索失败：{data.get('body') or data.get('error') or data}"
        items = data.get("items") or []
        if not items:
            return "没有找到相关记忆。"
        lines = [f"#{it.get('id')} {it.get('content')}" for it in items[:10]]
        return "记忆：\n" + "\n".join(lines)

    @filter.llm_tool(name="forget")
    async def forget(self, event: AstrMessageEvent, memory_id: int) -> str:
        """删除一条记忆。

        Args:
            memory_id(number): 记忆 id。
        """
        data = await self._api(
            "DELETE", f"api/v1/memories/{memory_id}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"删除失败：{data.get('body') or data.get('error') or data}"
        return f"已删除记忆#{memory_id}。"

    # ────────────────────────── 实时抓取 ──────────────────────────

    @filter.llm_tool(name="fetch_source")
    async def fetch_source(
        self,
        event: AstrMessageEvent,
        source_type: str,
        source_url: str = None,
        preset_key: str = None,
        params: dict = None,
    ) -> str:
        """实时抓取一次信息源（RSS/URL/预设适配器）。

        Args:
            source_type(string): rss、url 或 preset。
            source_url(string): 目标 URL（source_type=rss|url 时用）。
            preset_key(string): 预设适配器键名（source_type=preset 时用）。
            params(object): 附加参数（可选）。
        """
        body = {"source_type": source_type}
        if source_url:
            body["source_url"] = source_url
        if preset_key:
            body["preset_key"] = preset_key
        if params:
            body["params"] = params
        data = await self._api(
            "POST", "api/v1/fetch", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"抓取失败：{data.get('body') or data.get('error') or data}"
        items = data.get("items") or []
        lines = []
        for it in items[:10]:
            lines.append(f"- {it.get('title') or it.get('summary') or '(无标题)'}")
        return f"抓取到 {data.get('count', len(items))} 条：\n" + "\n".join(lines)

    # ────────────────────────── 身份/账户补充 ──────────────────────────

    @filter.llm_tool(name="bind_person")
    async def bind_person(self, event: AstrMessageEvent, person_id: int) -> str:
        """把当前用户绑定到已有的账号（如家人把你拉进家庭）。

        Args:
            person_id(number): 要绑定的账号 id。
        """
        data = await self._api(
            "POST", f"api/v1/persons/{person_id}/bind", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"绑定失败：{data.get('body') or data.get('error') or data}"
        return f"绑定成功。"

    @filter.llm_tool(name="join_account")
    async def join_account(self, event: AstrMessageEvent, account_id: int) -> str:
        """加入一个家庭账本。

        Args:
            account_id(number): 家庭账本 id。
        """
        data = await self._api(
            "POST", f"api/v1/accounts/{account_id}/join", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"加入失败：{data.get('body') or data.get('error') or data}"
        return f"已加入账本#{account_id}。"

    @filter.llm_tool(name="unbind_identity")
    async def unbind_identity(
        self,
        event: AstrMessageEvent,
        person_id: int,
        platform: str,
        openid: str,
    ) -> str:
        """把某平台身份从账号解绑。

        Args:
            person_id(number): 账号 id。
            platform(string): 平台，qq 或 wechat。
            openid(string): 要解绑的 openid。
        """
        data = await self._api(
            "DELETE", f"api/v1/persons/{person_id}/identities/{platform}/{openid}",
            identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"解绑失败：{data.get('body') or data.get('error') or data}"
        return f"已解绑 {platform}/{openid}。"

    @filter.llm_tool(name="set_primary_identity")
    async def set_primary_identity(
        self,
        event: AstrMessageEvent,
        platform: str,
        openid: str,
    ) -> str:
        """把主平台切换为本人名下另一身份。

        Args:
            platform(string): 平台，qq 或 wechat。
            openid(string): 目标身份 openid。
        """
        data = await self._api(
            "PATCH", "api/v1/persons/me/primary-identity",
            identity=self._identity(event), json_body={"platform": platform, "openid": openid},
        )
        if not data.get("ok", True):
            return f"切换失败：{data.get('body') or data.get('error') or data}"
        return f"主身份已切换为 {platform}/{openid}。"

    # ────────────────────────── 记账 Web 链接 ──────────────────────────

    @filter.llm_tool(name="create_ledger_link")
    async def create_ledger_link(
        self,
        event: AstrMessageEvent,
        mode: str = "read",
        expires_in: int = None,
    ) -> str:
        """生成一个可查看/修改账本的网页链接（家人可在浏览器打开）。

        Args:
            mode(string): read 或 write，默认 read。
            expires_in(number): 有效期（分钟，1-1440），默认 30。
        """
        body = {"mode": mode}
        if expires_in:
            body["expires_in"] = int(expires_in)
        data = await self._api(
            "POST", "api/v1/web/tokens", identity=self._identity(event), json_body=body,
        )
        if not data.get("ok", True):
            return f"生成失败：{data.get('body') or data.get('error') or data}"
        return (
            f"账本链接（{data.get('mode')}，{data.get('expires_at')} 过期）：\n{data.get('url')}"
        )

    @filter.llm_tool(name="revoke_ledger_link")
    async def revoke_ledger_link(self, event: AstrMessageEvent, token_id: int) -> str:
        """撤销一个已生成的账本链接。

        Args:
            token_id(number): 链接 token 的 id。
        """
        data = await self._api(
            "DELETE", f"api/v1/web/tokens/{token_id}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"撤销失败：{data.get('body') or data.get('error') or data}"
        return f"已撤销链接#{token_id}。"

    # ────────────────────────── outbox 轮询 ──────────────────────────

    async def _outbox_loop(self) -> None:
        while True:
            try:
                await self._poll_outbox()
            except Exception as e:
                logger.error(f"[HomeAssistant] outbox 轮询出错: {e}")
            await asyncio.sleep(self.poll_interval)

    async def _poll_outbox(self) -> None:
        if not self.api_key:
            return
        data = await self._api("GET", "api/v1/outbox/pending?channel=qq&limit=10")
        for item in data.get("items") or []:
            await self._deliver_outbox(item)

    async def _deliver_outbox(self, row: dict) -> None:
        oid = row.get("id")
        target = row.get("target_id") or ""
        content = row.get("content") or ""
        if not oid or not target or not content:
            return
        try:
            umo = self._session_map.get(target) or self._build_umo(target)
            if not umo:
                logger.warning(
                    f"[HomeAssistant] outbox#{oid} 无法定位会话（target={target}）"
                )
                await self._receipt(oid, "failed", "no session for target")
                return
            ok = await self.context.send_message(umo, MessageChain().message(content))
            if ok:
                logger.info(f"[HomeAssistant] outbox#{oid} 已投递到 QQ")
                await self._receipt(oid, "sent")
            else:
                logger.warning(f"[HomeAssistant] outbox#{oid} send_message 未匹配到平台")
                await self._receipt(oid, "failed", "send_message no platform matched")
        except Exception as e:
            logger.error(f"[HomeAssistant] outbox#{oid} 投递异常: {e}")
            await self._receipt(oid, "failed", str(e)[:300])

    def _build_umo(self, openid: str) -> str | None:
        """无注册表命中时按 QQ 官方 C2C 格式构造会话：platform_id:FriendMessage:openid"""
        if not self._platform_id or not openid:
            return None
        return f"{self._platform_id}:FriendMessage:{openid}"

    async def _receipt(self, oid: int, status: str, error: str = None) -> None:
        body = {"status": status}
        if error:
            body["error"] = error
        await self._api("POST", f"api/v1/outbox/{oid}/delivery", json_body=body)
