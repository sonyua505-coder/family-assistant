"""
家庭信息助理 · AstrBot Star 插件（M7 垂直切片）

接入层：让 QQ 机器人（鸡煲大人2.0）通过 LLM 工具调用 homeassistant API。
  - 身份：LLM 工具 get_my_identity / create_person，身份头由插件注入
    （x-platform=qq, x-openid=消息发送者 openid，见 src/lib/identity.ts）。
  - 记账：add_bill / list_bills / query_bill_stats（单笔直记，D20）。
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
