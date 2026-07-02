#! /usr/bin/env python3
# coding=utf-8
"""深信服 AC Web/CGI 传输与鉴权基类。

封装 RSA 登录 + 多步 CSRF token 握手、通用 ``_post`` 请求，以及写操作统一入口
``_write_cgi``（dry-run 安全闸 + :data:`CONFIRMED_WRITES` 白名单）。各 CGI 能力以
mixin 形式拆到同目录的 ``customrule_cgi`` / ``url_cgi`` / ``policy_cgi``，最终在
:mod:`app.sangfor.web_client` 组合成 :class:`SangforWebClient`。
"""
from __future__ import annotations

import hashlib
import json
import re
import ssl
import threading

import requests
import rsa
import urllib3
from requests.adapters import HTTPAdapter

from app.config import settings

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# ------------------------------------------------------------------------- #
# 全局并发限流：限制对**同一台 AC**（按 origin）的在途 CGI 请求数，跨请求生效。
# 各分析/对比/搜索单次请求内部虽已用线程池并行（大小 = settings.fetch_concurrency），但多个
# 请求同时跑会叠加；这里用 per-origin 信号量把对单台设备的实际并发封顶到
# ``settings.global_fetch_concurrency``，避免高峰压垮设备。
# ------------------------------------------------------------------------- #
_host_sems: dict[str, threading.BoundedSemaphore] = {}
_host_sems_lock = threading.Lock()


def _host_semaphore(origin: str) -> threading.BoundedSemaphore:
    """取（或惰性创建）某台 AC 的全局并发信号量。"""
    sem = _host_sems.get(origin)
    if sem is None:
        with _host_sems_lock:
            sem = _host_sems.get(origin)
            if sem is None:
                sem = threading.BoundedSemaphore(max(1, int(settings.global_fetch_concurrency)))
                _host_sems[origin] = sem
    return sem


class _LegacyTLSAdapter(HTTPAdapter):
    """允许 TLS 1.0/1.1 的 HTTP 适配器，用于旧版深信服 AC 固件。

    现代 Python/OpenSSL 默认禁用 TLS 1.0/1.1；旧版 AC 固件仅支持这两个版本，
    握手失败在 Windows 上会以 FileNotFoundError 的形式报出。
    """

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        # 降低安全级别以允许旧版 TLS 与弱密码套件
        ctx.set_ciphers("ALL:@SECLEVEL=0")
        try:
            ctx.minimum_version = ssl.TLSVersion.TLSv1
        except AttributeError:
            pass  # 某些 Python 构建不支持此属性，依赖 SECLEVEL=0 降级
        kwargs["ssl_context"] = ctx
        super().init_poolmanager(*args, **kwargs)


# 已抓包确认可安全提交的写操作 (cgi_path, opr) 白名单。
# 未在此集合中的写操作在 dry_run=False 时会被拒绝，防止误写。
# - customrule 的「新增(add)」「编辑(modify)」「删除(delete)」均已据真实抓包确认。
CONFIRMED_WRITES: set[tuple[str, str]] = {
    ("/cgi-bin/customrule.cgi", "add"),
    ("/cgi-bin/customrule.cgi", "modify"),
    ("/cgi-bin/customrule.cgi", "delete"),
    # 访问权限策略「编辑」已据真实抓包确认：opr=modify，data 为完整策略对象。
    ("/cgi-bin/netpolicy.cgi", "modify"),
    # 访问权限策略「上移/下移」（调整顺序）已据真实抓包确认。
    ("/cgi-bin/netpolicy.cgi", "moveup"),
    ("/cgi-bin/netpolicy.cgi", "movedown"),
    # 访问权限策略「批量启用/禁用」已据真实抓包确认（name 为名称数组）。
    ("/cgi-bin/netpolicy.cgi", "enable"),
    ("/cgi-bin/netpolicy.cgi", "disable"),
    # 访问权限策略「新建」已据真实抓包确认：opr=add，data 结构同 modify。
    ("/cgi-bin/netpolicy.cgi", "add"),
    # 访问权限策略「删除」已据真实抓包确认：opr=delete，name 为名称数组（支持批量）。
    ("/cgi-bin/netpolicy.cgi", "delete"),
    # 旧固件（acnetpolicy.cgi）策略写：「新建」已据南京 AC 真实抓包确认（结构同 netpolicy，
    # 仅 ssl 段为完整默认结构，由 create_policy 自动补齐）；「编辑」走读—改—写、回填设备自身
    # 完整对象仅替换规则，结构由设备保证一致，故一并放行。
    ("/cgi-bin/acnetpolicy.cgi", "add"),
    ("/cgi-bin/acnetpolicy.cgi", "modify"),
    # 自定义 URL 库「新增/编辑/删除」已据真实抓包确认。
    ("/cgi-bin/objurlgrp.cgi", "add"),
    ("/cgi-bin/objurlgrp.cgi", "modify"),
    ("/cgi-bin/objurlgrp.cgi", "delete"),
}


class SangforWebError(RuntimeError):
    """Web/CGI 调用失败。"""


class SangforWebBase:
    """传输 + 鉴权基类：登录、CSRF 握手、``_post``、``_write_cgi``。"""

    rsa_e = 0x10001

    def __init__(
        self,
        protocol: str,
        host: str,
        port: int | str,
        user_name: str,
        password: str,
        timeout: int = 30,
        verify: bool | str = False,
    ) -> None:
        self.origin = f"{protocol}://{host}:{port}"
        self.user_name = user_name
        self.password = password
        self.timeout = int(timeout)
        # requests 的 verify：False（不校验）/ True（系统 CA）/ CA 证书路径
        self.verify = verify
        self.session = requests.Session()
        # 挂载兼容旧版 TLS 的适配器，支持仅支持 TLS 1.0/1.1 的旧版 AC 固件
        _adapter = _LegacyTLSAdapter()
        self.session.mount("https://", _adapter)
        self.session.mount("http://", _adapter)
        self.rsa_key: str | None = None
        self._logged_in = False
        self._login_lock = threading.Lock()  # 串行化（重）登录，支持并发分析

    def clone_session(self) -> "SangforWebBase":
        """复制一个共享登录态、但拥有独立 ``requests.Session`` 的客户端。

        用于并发分析：``requests.Session`` 并非线程安全，多个 worker 共用同一 session
        可能出现 cookie/header 状态交叉。本方法在已登录的客户端上克隆出独立 session
        （复制 cookies 与 headers、沿用 RSA/登录态），供线程池中每个 worker 独占使用，
        既避免共享可变状态、又无需各自重新登录。
        """
        import copy

        clone = copy.copy(self)  # 浅拷贝属性（origin/user/password/rsa_key/_logged_in/verify…）
        clone.session = requests.Session()
        _adapter = _LegacyTLSAdapter()
        clone.session.mount("https://", _adapter)
        clone.session.mount("http://", _adapter)
        clone.session.headers.update(self.session.headers)
        clone.session.cookies.update(self.session.cookies)
        clone._login_lock = threading.Lock()
        return clone

    # ------------------------------------------------------------------ #
    # 登录 / 鉴权（流程严格沿用已验证实现）
    # ------------------------------------------------------------------ #
    @staticmethod
    def get_domain(domain: str) -> str | None:
        """提取字符串中出现的第一个域名。"""
        domains = re.findall(r"\w+[\w\-\.]*\.[\w-]{2,}", domain)
        return domains[0] if domains else None

    def _encrypt(self, plain: str) -> str:
        pubkey = rsa.key.PublicKey(int(self.rsa_key, 16), self.rsa_e)
        cipher = rsa.encrypt(plain.encode(), pubkey)
        return "".join(f"{x:02x}" for x in cipher)

    def _get_rsa_key(self) -> None:
        url = f"{self.origin}/cgi-bin/login.cgi"
        try:
            r = self.session.post(url, json={"opr": "rsakey"}, verify=self.verify, timeout=self.timeout)
        except requests.RequestException as exc:
            raise SangforWebError(f"无法连接 AC（{self.origin}）：{exc}") from exc
        r.encoding = r.apparent_encoding
        if r.status_code != 200:
            raise SangforWebError(f"获取 RSA 公钥失败 HTTP {r.status_code}")
        try:
            result = r.json()
        except ValueError:
            raise SangforWebError(f"获取 RSA 公钥响应非 JSON：{(r.text or '')[:200]!r}")
        if not result.get("success"):
            raise SangforWebError(result.get("msg", "获取 RSA 公钥失败"))
        self.rsa_key = result.get("key")

    def login(self) -> None:
        """执行登录并准备好 CSRF token。已登录则跳过。

        所有网络异常与登录态缺失统一包装为 :class:`SangforWebError`，便于上层路由
        返回友好错误而非 500。并发场景下用锁双检，避免多个线程同时重登。
        """
        if self._logged_in:
            return
        with self._login_lock:
            if self._logged_in:
                return
            self._do_login()

    def _do_login(self) -> None:
        self._get_rsa_key()
        login_url = f"{self.origin}/cgi-bin/login.cgi"
        login_data = {
            "opr": "login",
            "data": {"user": self.user_name, "pwd": self._encrypt(self.password)},
        }
        phpsession_url = f"{self.origin}/php/phpsession.php"
        gcs_url = f"{self.origin}/cgi-bin/gcs_webui.cgi"

        try:
            r = self.session.post(login_url, json=login_data, verify=self.verify, timeout=self.timeout)
            r.encoding = r.apparent_encoding
            if r.status_code == 200:
                try:
                    result = r.json()
                except ValueError:
                    raise SangforWebError(f"登录响应非 JSON：{(r.text or '')[:200]!r}")
                if not result.get("success"):
                    raise SangforWebError(result.get("msg", "登录失败"))

            # 获取并设置 CSRF token（多步握手，沿用原实现）
            self.session.post(phpsession_url, data={"opr": "read"}, verify=self.verify, timeout=self.timeout)
            self.session.get(gcs_url, params={"requestname": 22}, verify=self.verify, timeout=self.timeout)
            anti_csrf = self.session.cookies.get("x-anti-csrf-gcs")
            if not anti_csrf:
                raise SangforWebError("登录失败：未获取到 CSRF cookie，请检查用户名/密码")
            csrf_token_hash = hashlib.md5(anti_csrf.encode("utf-8")).hexdigest()
            for data in (
                {"requestname": 0, "requestarg": 3, "csrf": csrf_token_hash},
                {"requestname": 23, "requestarg": 0, "csrf": csrf_token_hash},
                {"requestname": 19, "csrf": csrf_token_hash},
                {"requestname": 5, "requestarg": 1, "clicktype": 9, "csrf": csrf_token_hash},
            ):
                self.session.post(gcs_url, data=data, verify=self.verify, timeout=self.timeout)

            session_id = self.session.cookies.get("sangfor_session_id")
            if not session_id:
                raise SangforWebError("登录失败：未获取到会话 cookie，请检查凭据")
            csrf_token = hashlib.md5(session_id.encode("utf-8")).hexdigest()
        except requests.RequestException as exc:
            raise SangforWebError(f"登录过程网络异常（{self.origin}）：{exc}") from exc

        self.session.headers.update({"x-sangfor-anticsrf": csrf_token, "X-Requested-With": "XMLHttpRequest"})
        self._logged_in = True

    # ------------------------------------------------------------------ #
    # 通用请求
    # ------------------------------------------------------------------ #
    # 提示登录态失效的关键词（响应 msg 命中时自动重登重试一次）
    _AUTH_ERROR_HINTS = ("登录", "login", "会话", "session", "未授权", "csrf", "重新登录", "超时")

    def _post(self, path: str, payload: dict, _retry: bool = True) -> dict:
        """对 CGI 发送 JSON POST，返回解析后的 result，校验 success。

        响应非 JSON 或 msg 提示登录态失效时，丢弃登录态并自动重登重试一次；仍失败则
        抛出带响应片段的 :class:`SangforWebError`，便于定位（而非 500）。
        """
        self.login()
        url = f"{self.origin}/{path.lstrip('/')}"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            # 全局限流：同一台 AC 的在途 CGI 请求数不超过 settings.fetch_concurrency
            with _host_semaphore(self.origin):
                r = self.session.post(
                    url,
                    data=data,
                    headers={"Content-Type": "application/json; charset=utf-8"},
                    verify=self.verify,
                    timeout=self.timeout,
                )
        except requests.RequestException as exc:
            raise SangforWebError(f"网络请求失败（{path}）：{exc}") from exc
        r.encoding = r.apparent_encoding
        if r.status_code != 200:
            raise SangforWebError(f"HTTP {r.status_code}: {r.text[:200]}")

        try:
            result = r.json()
        except ValueError:
            # 响应非 JSON（多为登录态失效返回空/HTML）：重登重试一次
            if _retry:
                self._logged_in = False
                return self._post(path, payload, _retry=False)
            snippet = (r.text or "").strip()[:200]
            raise SangforWebError(
                f"接口 {path} 返回非 JSON（可能登录态失效或凭据有误）：{snippet!r}"
            )

        if not result.get("success", True):
            msg = str(result.get("msg", ""))
            if _retry and any(h in msg.lower() for h in self._AUTH_ERROR_HINTS):
                self._logged_in = False
                return self._post(path, payload, _retry=False)
            # 带上 path / opr 与设备原始响应，便于定位（设备常不给 msg）
            opr = payload.get("opr", "")
            if not msg:
                snippet = json.dumps(result, ensure_ascii=False)[:300]
                msg = f"设备未返回错误描述，响应：{snippet}"
            raise SangforWebError(f"{path}（opr={opr}）返回失败：{msg}")
        return result

    def _write_cgi(self, path: str, payload: dict, *, dry_run: bool) -> dict:
        """写操作统一入口。

        - ``dry_run=True``：不发送，返回将提交的 ``{url, payload}``，供前端预览。
        - ``dry_run=False``：仅当 (path, opr) 在 :data:`CONFIRMED_WRITES` 中才真正提交，
          否则抛错，避免在报文未抓包确认前误写设备。
        """
        opr = str(payload.get("opr", ""))
        url = f"{self.origin}/{path.lstrip('/')}"
        if dry_run:
            return {"dry_run": True, "url": url, "payload": payload}
        if (path, opr) not in CONFIRMED_WRITES:
            raise SangforWebError(
                f"写操作 ({path}, opr={opr}) 尚未抓包确认，已阻止提交。请先在 AC 控制台抓包并登记到 CONFIRMED_WRITES。"
            )
        result = self._post(path, payload)
        return {"dry_run": False, "result": result}
