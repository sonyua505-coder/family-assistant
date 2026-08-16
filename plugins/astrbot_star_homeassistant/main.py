"""
家庭信息助理 · AstrBot Star 插件（M7，全功能接入）

接入层：让 QQ 机器人（鸡煲大人2.0）通过 LLM 工具调用 homeassistant API。
  - 身份：get_my_identity / create_person / bind_person / unbind_identity /
    set_primary_identity，身份头由插件注入（x-platform=qq,
    x-openid=消息发送者 openid，见 src/lib/identity.ts）。
  - 账本：create_account / list_my_accounts / join_account。
  - 记账：add_bill / add_bills(批量) / update_bill / delete_bill / settle_bill /
    list_bills / get_bill / list_bill_trash / restore_bill / query_bill_stats /
    query_bill_changes（含 AA 分摊）。
  - 待办：add_task / list_tasks / complete_task / undo_task / update_task / delete_task。
  - 订阅/新闻：subscribe_source / list_subscriptions / unsubscribe / query_news。
  - 记忆：remember / search_memory / forget。
  - 抓取：fetch_source（SSRF 白名单由后端把关）。
  - 账本链接：create_ledger_link / list_ledger_links / revoke_ledger_link。
  - outbox：后台轮询 /api/v1/outbox/pending?channel=qq，经
    context.send_message(umo, ...) 主动推送到 QQ（C2C 无需 msg_id，
    见 qqofficial 适配器 _send_by_session_common），并回报 sent/failed。

配置（WebUI 插件面板 / _conf_schema.json）：
  api_base      家庭信息助理 API 地址（默认 http://homeassistant-api:3000，走共享网络）
  api_key       X_API_KEY（/opt/homeassistant/.env，勿外泄）
  poll_interval outbox 轮询间隔秒数
"""
import asyncio
import csv
import io
import os
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

import httpx

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import File
from astrbot.api.star import Context, Star
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.utils.astrbot_path import get_astrbot_temp_path, get_astrbot_workspaces_path
from astrbot.core.workspace import normalize_umo_for_workspace

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

    # 新 bill_stats / export_bills 上线后，验证期间按配置停用的旧查询/统计工具
    LEGACY_QUERY_TOOLS = [
        "list_bills",
        "get_bill",
        "query_bill_stats",
        "query_bill_changes",
        "list_bill_trash",
        "restore_bill",
    ]

    # ────────────────────────── 生命周期 ──────────────────────────

    async def initialize(self) -> None:
        """插件激活时按配置调整旧工具启停，并启动 outbox 轮询。"""
        self._apply_legacy_tool_policy()
        self._outbox_task = asyncio.create_task(self._outbox_loop())
        logger.info(
            f"[HomeAssistant] 插件已激活 api_base={self.api_base} "
            f"poll_interval={self.poll_interval}s"
        )

    def _apply_legacy_tool_policy(self) -> None:
        """按 disable_legacy_query_tools 配置停用/启用旧查询统计工具。

        deactivate/activate_llm_tool 均幂等：停用状态持久化到
        shared_preferences 的 inactivated_llm_tools，重启自动恢复。
        """
        disable = bool(self.config.get("disable_legacy_query_tools", False))
        action = "停用" if disable else "启用"
        for name in self.LEGACY_QUERY_TOOLS:
            try:
                ok = (
                    self.context.deactivate_llm_tool(name)
                    if disable
                    else self.context.activate_llm_tool(name)
                )
                logger.info(f"[HomeAssistant] {action}旧查询工具 {name}: ok={ok}")
            except ValueError as e:  # activate 在所属插件被禁用时会抛
                logger.warning(f"[HomeAssistant] 调整工具 {name} 被拒绝: {e}")
            except Exception as e:
                logger.warning(f"[HomeAssistant] 调整工具 {name} 失败: {e}")

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

    @staticmethod
    def _err_msg(data: dict) -> str:
        """把后端失败响应转成对用户友好的一句话。"""
        body = data.get("body") or data.get("error") or str(data)
        if "ACCOUNT_AMBIGUOUS" in str(body):
            return "你有多个账本，请先 list_my_accounts 查看账本 id，再带上 account_id 重试。"
        return f"操作失败：{body}"

    async def _api_raw(self, method: str, path: str, *, identity=None, json_body=None):
        """调 homeassistant API 并返回 (status_code, body_text)；网络异常返回失败 dict。

        _api 只支持 JSON 响应；导出 CSV 是纯文本，需要走这个原始接口。
        """
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if identity:
            headers["x-platform"] = identity[0]
            headers["x-openid"] = identity[1]
        url = f"{self.api_base}/{path.lstrip('/')}"
        try:
            async with httpx.AsyncClient(timeout=60) as client:  # 导出可能较慢，放宽超时
                resp = await client.request(method, url, json=json_body, headers=headers)
            return resp.status_code, resp.text
        except Exception as e:
            logger.error(f"[HomeAssistant] 请求失败 {method} {path}: {e}")
            return {"ok": False, "error": str(e)}

    def _workspace_root(self, event: AstrMessageEvent) -> Path:
        """当前会话工作区根目录（resolve 后），按 unified_msg_origin 隔离。"""
        root = Path(get_astrbot_workspaces_path()) / normalize_umo_for_workspace(
            event.unified_msg_origin
        )
        return root.resolve()

    def _resolve_workspace_rel(self, event: AstrMessageEvent, relative_path: str) -> Path:
        """把相对路径补全到会话工作区，并校验不越界（容器 root 无沙箱，必须插件自查）。"""
        rel = str(relative_path).strip().replace("\\", "/")
        if not rel or rel.startswith("/") or Path(rel).is_absolute():
            raise ValueError("必须是工作区内的相对路径")
        root = self._workspace_root(event)
        target = (root / rel).resolve()
        if target == root or not target.is_relative_to(root):
            raise ValueError(f"路径越界：{relative_path}")
        return target

    def _ensure_matplotlib(self) -> bool:
        """懒加载 matplotlib（Agg 后端 + 中文字体注册），失败返回 False。

        容器无显示、装失败不影响插件加载，故绝不在模块顶层 import。
        """
        if getattr(self, "_mpl_ok", None) is not None:
            return self._mpl_ok
        try:
            import matplotlib

            matplotlib.use("Agg")  # 容器无显示，必须用非交互后端
            from matplotlib import font_manager, pyplot as plt

            self._plt = plt
            font_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "fonts", "wqy-microhei.ttc"
            )
            if os.path.exists(font_path):
                font_manager.fontManager.addfont(font_path)
                family = font_manager.FontProperties(fname=font_path).get_name()
                plt.rcParams["font.family"] = [family, "DejaVu Sans"]
            else:
                logger.warning("[HomeAssistant] 中文字体缺失，图表中文可能显示为方块")
            plt.rcParams["axes.unicode_minus"] = False  # 修复负号显示
            self._mpl_ok = True
            return True
        except Exception as e:
            logger.error(f"[HomeAssistant] matplotlib 初始化失败: {e}")
            self._mpl_ok = False
            return False

    def _render_stats_png(self, stats: dict, period: str, out_path: str) -> None:
        """渲染统计图（CPU 密集，经 asyncio.to_thread 调用；金额单位：元，仅供用户看图）。

        一张 PNG 两个 subplot：左=支出分类构成（横向条形，Top6+其他），右=收支趋势（分组柱状）。
        qqofficial 一条消息只支持一个 Image，故合成单张。
        """
        import numpy as np

        plt = self._plt
        by_cat = [c for c in (stats.get("by_category") or []) if c.get("amount")]
        by_cat.sort(key=lambda c: c["amount"], reverse=True)
        trend = stats.get("trend") or []

        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5), dpi=150)
        fig.suptitle(f"家庭信息助理 · 收支统计 {period}", fontsize=13)

        # 左：支出分类构成 —— 横向条形图（part-to-whole 用条形，小屏标签可读）
        if by_cat:
            top = by_cat[:6]
            labels = [c["category"] for c in top]
            vals = [c["amount"] / 100 for c in top]
            rest = sum(c["amount"] for c in by_cat[6:]) / 100
            if rest > 0:
                labels.append("其他")
                vals.append(rest)
            y = np.arange(len(vals))[::-1]
            ax1.barh(y, vals, color="#2a78d6", height=0.62)
            ax1.set_yticks(y, labels)
            ax1.set_title("支出分类构成（元）")
            for yi, v in zip(y, vals):
                ax1.text(v, yi, f"{v:,.0f}", va="center", ha="left", fontsize=9)
            ax1.tick_params(axis="x", labelsize=8)
        else:
            ax1.text(0.5, 0.5, "暂无分类数据", ha="center", va="center", transform=ax1.transAxes)

        # 右：收支趋势 —— 分组柱状（收入蓝 / 支出橙）
        if trend:
            months = [t.get("month", "") for t in trend]
            inc = [t.get("income", 0) / 100 for t in trend]
            exp = [t.get("expense", 0) / 100 for t in trend]
            x = np.arange(len(months))
            w = 0.36
            b1 = ax2.bar(x - w / 2, inc, w, color="#2a78d6", label="收入")
            b2 = ax2.bar(x + w / 2, exp, w, color="#eb6834", label="支出")
            ax2.set_xticks(x, months, rotation=30, ha="right", fontsize=8)
            ax2.set_ylabel("元")
            ax2.legend(frameon=False)
            ax2.bar_label(b1, fontsize=8, padding=2)
            ax2.bar_label(b2, fontsize=8, padding=2)
        else:
            ax2.text(0.5, 0.5, "暂无趋势数据", ha="center", va="center", transform=ax2.transAxes)

        fig.tight_layout(rect=[0, 0, 1, 0.95])
        fig.savefig(out_path, bbox_inches="tight", facecolor="white")
        plt.close(fig)

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
        return f"已删除账单#{bill_id}（进了回收站，可 list_bill_trash 查看、restore_bill 恢复）。"

    @filter.llm_tool(name="list_bill_trash")
    async def list_bill_trash(self, event: AstrMessageEvent, account_id: int = None) -> str:
        """列出回收站里的账单（软删除、尚未恢复的）。

        Args:
            account_id(number): 记账账户 id（用户有多个账本时必须指定）。
        """
        qs = f"?account_id={account_id}" if account_id else ""
        data = await self._api(
            "GET", f"api/v1/bills/trash{qs}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        items = data.get("items") or []
        if not items:
            return "回收站是空的。"
        lines = []
        for it in items[:10]:
            kind = "支出" if it.get("type") == "expense" else "收入"
            lines.append(
                f"#{it.get('id')} {kind} {it.get('amount')}分 "
                f"{it.get('category') or ''} {it.get('note') or ''}"
            )
        return "回收站账单（可用 restore_bill 恢复）：\n" + "\n".join(lines)

    @filter.llm_tool(name="restore_bill")
    async def restore_bill(self, event: AstrMessageEvent, bill_id: int) -> str:
        """从回收站恢复一笔已删除的账单（软删除可反悔）。

        Args:
            bill_id(number): 账单 id（来自 delete_bill 的 #id 或回收站列表）。
        """
        data = await self._api(
            "POST", f"api/v1/bills/{bill_id}/restore", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"恢复失败：{data.get('body') or data.get('error') or data}"
        b = data.get("bill") or {}
        kind = "支出" if b.get("type") == "expense" else "收入"
        return (
            f"已恢复账单#{b.get('id')}：{kind} {b.get('amount')}分 "
            f"（{b.get('category') or '未分类'}）"
        )

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

    @filter.llm_tool(name="get_bill")
    async def get_bill(self, event: AstrMessageEvent, bill_id: int) -> str:
        """查询一笔账单的完整详情（含参与人、备注、发生时间）。

        Args:
            bill_id(number): 账单 id（来自记账或查账结果的 #id）。
        """
        data = await self._api(
            "GET", f"api/v1/bills/{bill_id}", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        parts = [f"#{data.get('id')}"]
        kind = "支出" if data.get("type") == "expense" else "收入"
        parts.append(f"{kind} {data.get('amount')}分")
        if data.get("category"):
            parts.append(f"分类:{data.get('category')}")
        if data.get("note"):
            parts.append(f"备注:{data.get('note')}")
        if data.get("occurred_at"):
            parts.append(f"时间:{data.get('occurred_at')}")
        if data.get("participants"):
            parts.append(f"参与人:{data.get('participants')}")
        if data.get("status"):
            parts.append(f"状态:{data.get('status')}")
        return "账单详情：" + "，".join(parts)

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

    @filter.llm_tool(name="undo_task")
    async def undo_task(self, event: AstrMessageEvent, task_id: int) -> str:
        """把一条已完成待办改回未完成（误点完成时可反悔）。

        Args:
            task_id(number): 事项 id。
        """
        data = await self._api(
            "POST", f"api/v1/tasks/{task_id}/undo", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"操作失败：{data.get('body') or data.get('error') or data}"
        return f"已把事项#{task_id} 改回未完成。"

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

    @filter.llm_tool(name="list_ledger_links")
    async def list_ledger_links(self, event: AstrMessageEvent) -> str:
        """列出当前用户已生成的账本网页链接（含过期状态）。

        Args:
        """
        data = await self._api(
            "GET", "api/v1/web/tokens", identity=self._identity(event),
        )
        if not data.get("ok", True):
            return f"查询失败：{data.get('body') or data.get('error') or data}"
        tokens = data.get("tokens") or []
        if not tokens:
            return "还没有生成过账本链接。"
        lines = []
        for t in tokens[:10]:
            state = "已过期" if t.get("is_expired") else "有效"
            lines.append(
                f"#{t.get('id')} {t.get('mode')} {state} 过期:{t.get('expires_at')}"
            )
        return "账本链接：\n" + "\n".join(lines)

    # ────────────────────────── 统计 / 导出（方向 A） ──────────────────────────

    @filter.llm_tool(name="bill_stats")
    async def bill_stats(
        self,
        event: AstrMessageEvent,
        year: int = None,
        month: int = None,
        from_date: str = None,
        to_date: str = None,
        category: str = None,
        amount_min: int = None,
        amount_max: int = None,
        account_id: int = None,
        chart: bool = True,
    ) -> str:
        """查询收支统计（可含图表）。按年份/月份/日期区间/分类/金额区间筛选；chart=True 时把统计图（支出构成+收支趋势）直接发给你。

        Args:
            year(number): 年份，如 2026（可选）。
            month(number): 月份 1-12，需配合 year（可选）。
            from_date(string): 起始日期 YYYY-MM-DD，优先于 year/month（可选）。
            to_date(string): 结束日期 YYYY-MM-DD，与 from_date 成对（可选）。
            category(string): 只看某一分类，如 餐饮（可选）。
            amount_min(number): 金额下限（单位：分，1 元 = 100 分）（可选）。
            amount_max(number): 金额上限（单位：分，1 元 = 100 分）（可选）。
            account_id(number): 记账账户 id（有多个账本时必须指定，否则返回 409）。
            chart(boolean): 是否同时生成并发送统计图，默认 true。
        """
        params = {}
        if year:
            params["year"] = year
        if month:
            params["month"] = month
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        if category:
            params["category"] = category
        if amount_min is not None:
            params["amount_min"] = amount_min
        if amount_max is not None:
            params["amount_max"] = amount_max
        if account_id:
            params["account_id"] = account_id
        qs = urlencode(params)
        data = await self._api(
            "GET", f"api/v1/bills/stats/range?{qs}", identity=self._identity(event)
        )
        if not data.get("ok", True):
            return self._err_msg(data)
        income = int(data.get("income") or 0)
        expense = int(data.get("expense") or 0)
        net = int(data.get("net") or 0)
        by_cat = data.get("by_category") or []
        trend = data.get("trend") or []
        applied = data.get("applied") or {}

        if income == 0 and expense == 0:
            return "该筛选区间暂无账单。"

        lines = ["收支统计："]
        lines.append(f"收入 {income} 分 / 支出 {expense} 分 / 结余 {net} 分")
        top = sorted(
            [c for c in by_cat if c.get("amount")],
            key=lambda c: c["amount"],
            reverse=True,
        )[:5]
        if top:
            lines.append(
                "支出分类 Top：" + "、".join(
                    f"{c['category']} {c['amount']}分({c.get('count', 0)}笔)"
                    for c in top
                )
            )
            if len(by_cat) > 5:
                lines.append(f"…共 {len(by_cat)} 个分类")
        if trend:
            lines.append(
                "趋势：" + "；".join(
                    f"{t.get('month', '')} 收{t.get('income', 0)}/支{t.get('expense', 0)}"
                    for t in trend
                )
            )
        if applied:
            lines.append(f"已生效筛选：{applied}")
        text = "\n".join(lines)

        if chart and (income > 0 or expense > 0):
            if not self._ensure_matplotlib():
                return text + "\n（图表生成失败，仅返回文字）"
            png = os.path.join(get_astrbot_temp_path(), f"ha_stats_{uuid.uuid4().hex}.png")
            try:
                # 渲染是 CPU 密集，丢到线程池避免卡住事件循环
                await asyncio.to_thread(self._render_stats_png, data, str(applied or {}), png)
                caption = f"收支统计（单位：元）· 结余 {net / 100:,.2f} 元"
                await self.context.send_message(
                    event.unified_msg_origin,
                    MessageChain().message(caption).file_image(png),
                )
            except Exception as e:
                logger.error(f"[HomeAssistant] 发送统计图失败: {e}")
            finally:
                if os.path.exists(png):
                    os.remove(png)
        return text

    @filter.llm_tool(name="export_bills")
    async def export_bills(
        self,
        event: AstrMessageEvent,
        type: str = None,
        category: str = None,
        status: str = None,
        participant: str = None,
        month: str = None,
        year: int = None,
        from_date: str = None,
        to_date: str = None,
        amount_min: int = None,
        amount_max: int = None,
        account_id: int = None,
        destination: str = "workspace",
        relative_path: str = None,
    ) -> str:
        """把账单导出为 CSV 文件。默认存到当前会话工作区（供 BOT 进一步处理后再发送），也可直接发文件给你或两者都做。

        Args:
            type(string): income 或 expense（可选）。
            category(string): 分类筛选，如 餐饮（可选）。
            status(string): 状态筛选，settled 或 pending（可选）。
            participant(string): 参与人名字筛选（可选）。
            month(string): 月份 YYYY-MM（可选）。
            year(number): 年份（可选）。
            from_date(string): 起始日期 YYYY-MM-DD（可选）。
            to_date(string): 结束日期 YYYY-MM-DD（可选）。
            amount_min(number): 金额下限（单位：分，1 元 = 100 分）（可选）。
            amount_max(number): 金额上限（单位：分，1 元 = 100 分）（可选）。
            account_id(number): 记账账户 id（有多个账本时必须指定）。
            destination(string): workspace=只存会话工作区；user=直接把 CSV 文件发给你；both=既存工作区又发文件。默认 workspace。
            relative_path(string): 工作区内的相对路径，如 exports/家庭账单.csv（可选，默认自动命名）。
        """
        params = {"format": "csv"}
        if type:
            params["type"] = type
        if category:
            params["category"] = category
        if status:
            params["status"] = status
        if participant:
            params["participant"] = participant
        if month:
            params["month"] = month
        if year:
            params["year"] = year
        if from_date:
            params["from"] = from_date
        if to_date:
            params["to"] = to_date
        if amount_min is not None:
            params["amount_min"] = amount_min
        if amount_max is not None:
            params["amount_max"] = amount_max
        if account_id:
            params["account_id"] = account_id
        qs = urlencode(params)

        ret = await self._api_raw(
            "GET", f"api/v1/bills/export?{qs}", identity=self._identity(event)
        )
        if isinstance(ret, dict):
            return self._err_msg(ret)
        http_status, csv_text = ret
        if http_status >= 400:
            return f"导出失败（HTTP {http_status}）：{csv_text[:300]}"
        if not isinstance(csv_text, str) or not csv_text.strip():
            return "导出失败：后端返回空内容。"
        try:
            # 用 csv.reader 精确统计行数（正确处理带引号换行的字段），不进 LLM 上下文
            row_count = max(0, sum(1 for _ in csv.reader(io.StringIO(csv_text))) - 1)
        except Exception:
            row_count = 0

        ws_path = None
        if destination in ("workspace", "both"):
            try:
                if relative_path:
                    target = self._resolve_workspace_rel(event, relative_path)
                else:
                    target = (
                        self._workspace_root(event)
                        / "exports"
                        / f"bills_{datetime.now():%Y%m%d_%H%M%S}.csv"
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "w", encoding="utf-8", newline="") as f:
                    f.write(csv_text)  # csv_text 自带 UTF-8 BOM
                ws_path = target.relative_to(self._workspace_root(event)).as_posix()
            except ValueError as e:
                return f"无效路径：{e}"

        if destination in ("user", "both"):
            filename = (
                os.path.basename(ws_path)
                if ws_path
                else f"bills_{datetime.now():%Y%m%d_%H%M%S}.csv"
            )
            tmp = os.path.join(get_astrbot_temp_path(), f"ha_export_{uuid.uuid4().hex}.csv")
            with open(tmp, "w", encoding="utf-8", newline="") as f:
                f.write(csv_text)
            try:
                ok = await self.context.send_message(
                    event.unified_msg_origin,
                    MessageChain([File(name=filename, file=tmp)]),
                )
                if not ok:
                    return f"文件已生成但发送失败（未匹配到平台）。工作区副本：{ws_path or filename}"
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)

        applied_note = f"筛选：{dict(params)}"
        if destination == "workspace":
            return (
                f"已导出 {row_count} 条账单到工作区：{ws_path}。\n"
                f"{applied_note}\n"
                f"可用文件工具读取/处理，或让我把它发给你。"
            )
        if destination == "user":
            return f"已把 {row_count} 条账单的 CSV 文件发给你。\n{applied_note}"
        return f"已导出 {row_count} 条账单到工作区：{ws_path}，并已把文件发给你。\n{applied_note}"

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
