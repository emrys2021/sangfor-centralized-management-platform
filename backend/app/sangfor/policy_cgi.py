#! /usr/bin/env python3
# coding=utf-8
"""访问权限策略 + 应用目录树 CGI 能力（``netpolicy.cgi`` / ``acnetpolicy.cgi``）。"""
from __future__ import annotations

import copy
import re
from typing import Any

from app.sangfor.web_base import SangforWebError

# 旧固件 acnetpolicy.cgi 新建策略时 ssl 段需为完整默认结构（新固件 netpolicy.cgi 用 {}）。
# 取自南京 AC 真实「新建策略」抓包，SSL 识别默认关闭（include/enable 均 false）。
_ACNETPOLICY_SSL_DEFAULT = {
    "sslident": {
        "web": {
            "advance": {"act": "all"},
            "apprule": {"apps": []},
            "enable": False,
            "proxyall": 0,
            "decryptioncard": 0,
            "decryptmode": "MITM",
            "sites": (
                "mail.qq.com\ngmail.com\nemailgoogle.com\ngoogleemail.com\nmail.google.com\n"
                "www.gmail.com\ngroups.google.com\nsites.google.com\ndream4ever.org\nwx.qq.com\n"
                "wx2.qq.com\nftn.qq.com\nexmail.qq.com\n"
            ),
            "forbidquic": False,
        },
        "mail": {
            "advance": {"smtp": {"enable": True, "act": "all"}, "pop3": False},
            "enable": False,
            "excepts": "",
        },
        "include": False,
    }
}


class PolicyCgiMixin:
    """策略 list/listItem、编辑(modify) 往返、应用树 listAppTree、连接测试（mixin）。"""

    NETPOLICY_CGI = "/cgi-bin/netpolicy.cgi"

    # 不同固件版本的策略类型名映射（新固件 → 旧固件）
    _ACCESS_POLICY_TYPES = {"访问权限策略", "上网权限策略"}
    _SSL_POLICY_TYPES = {"SSL解密策略", "上网审计策略"}

    def list_policies(self) -> dict:
        """返回访问权限策略与 SSL 解密策略两组 policy_info。

        在 ``policy_info``（顺序/名称/描述/创建者/有效期/状态…）基础上，附带 ``applies_to``
        （取自 ``use_info.local``，即策略适用的用户/IP/组织），供列表「适用对象」列展示。

        兼容新旧固件：新固件类型名「访问权限策略」/「SSL解密策略」，
        旧固件类型名「上网权限策略」/「上网审计策略」。
        """
        self._ensure_policy_cgi()
        result = self._post(self.NETPOLICY_CGI, {"opr": "list", "start": 0, "limit": 50000, "type": 1})
        access, ssl = [], []
        for item in result.get("data", []) or []:
            if not isinstance(item, dict):
                continue
            raw_info = item.get("policy_info")
            if not isinstance(raw_info, dict):
                continue
            info = dict(raw_info)
            use_info = item.get("use_info") if isinstance(item.get("use_info"), dict) else {}
            info["applies_to"] = use_info.get("local", "") or ""  # 适用用户
            loc = use_info.get("location")
            info["location"] = ", ".join(loc) if isinstance(loc, list) else (str(loc) if loc else "")  # 适用位置
            tgt = use_info.get("target_area")
            info["target_area"] = ", ".join(tgt) if isinstance(tgt, list) else (str(tgt) if tgt else "")  # 适用目标区域
            if info.get("type") in self._ACCESS_POLICY_TYPES:
                access.append(info)
            elif info.get("type") in self._SSL_POLICY_TYPES:
                ssl.append(info)
        return {"access_policies": access, "ssl_decrypt_policies": ssl}

    def get_policy_detail(self, policy_name: str) -> dict:
        """返回单条访问权限策略的详情，并解析「策略 → 规则 → 引用应用/URL」结构。

        每个 ``appctrl.application.data[i]`` 视为一条规则；从中抽取：
        - 引用的应用 path 列表（区分内置/自定义：以「自定义」开头判定为自定义）；
        - 引用的 URL 库：优先从「访问网站/URL库名/能力」应用路径抽取，同时兼容明确的 URL 字段。

        同时返回原始 ``appctrl``，前端可折叠展示完整配置，避免信息丢失。
        """
        self._ensure_policy_cgi()  # 旧固件走 acnetpolicy.cgi，否则 listItem 404 会误判为「策略不存在」
        result = self._post(self.NETPOLICY_CGI, {"opr": "listItem", "name": policy_name})
        appctrl = result.get("appctrl", {}) or {}
        application = appctrl.get("application", {}) or {}
        rules_raw = application.get("data", []) or []
        application_include = bool(application.get("include"))

        def is_custom(path: str) -> bool:
            parts = [p.strip() for p in re.split(r"[/\\>＞]+", path or "") if p.strip()]
            return any(p.startswith("自定义") for p in parts)

        def access_website_url_name(path: str) -> str:
            """从「访问网站/URL库名/能力」应用路径中提取 URL 库名。"""
            parts = [p.strip() for p in re.split(r"[/\\>＞]+", path or "") if p.strip()]
            if len(parts) >= 2 and parts[0] == "访问网站":
                return parts[1]
            return ""

        url_section_keys = (
            "website",
            "websites",
            "web_url",
            "web_urls",
            "weburl",
            "weburls",
            "url",
            "urls",
            "urlgroup",
            "urlgroups",
            "url_group",
            "url_groups",
            "urlGroup",
            "urlGroups",
            "urlfilter",
            "urlfilters",
            "url_filter",
            "url_filters",
            "objurlgrp",
            "objurlgrps",
            "访问网站",
            "URL库",
            "url库",
        )

        def iter_ref_names(section) -> list[str]:
            """从应用/URL 引用段里递归抽取 path/name/text/value 等常见展示字段。"""
            names: list[str] = []
            ref_value_keys = ("id", "path", "name", "text", "value", "label")

            def add(raw) -> None:
                text = "" if raw is None else str(raw).strip()
                if text:
                    names.append(text)

            def walk(value, *, allow_scalar: bool = False) -> None:
                if isinstance(value, (str, int, float)):
                    if allow_scalar:
                        add(value)
                    return
                if isinstance(value, list):
                    for item in value:
                        walk(item, allow_scalar=True)
                    return
                if not isinstance(value, dict):
                    return
                for key in ref_value_keys:
                    if key in value:
                        add(value.get(key))
                for child in value.values():
                    if isinstance(child, (dict, list)):
                        walk(child, allow_scalar=False)

            walk(section, allow_scalar=True)
            return list(dict.fromkeys(names))

        def iter_url_sections(rule_item: dict) -> list[object]:
            """在整条规则里递归定位「访问网站 / URL库」配置段。"""
            sections: list[object] = []

            def walk(value) -> None:
                if isinstance(value, list):
                    for item in value:
                        walk(item)
                    return
                if not isinstance(value, dict):
                    return

                for key, child in value.items():
                    if key in url_section_keys:
                        sections.append(child)
                    walk(child)

            walk(rule_item)
            return sections

        def extract_urls(rule_item: dict) -> list[dict]:
            """从一条规则中尽量抽取 URL 库引用。

            不同固件字段命名不一，这里在常见键名中做容错收集。
            """
            urls: list[dict] = []
            seen: set[str] = set()

            def add_url(name: str) -> None:
                if not name or name in seen:
                    return
                seen.add(name)
                urls.append({"name": name, "custom": is_custom(name)})

            # AC 策略详情的「访问网站」会出现在 apps.apps[].path，格式为：
            # 访问网站/<URL库名>/<网站浏览|文件上传|HTTPS...>
            for key in ("apps", "app", "application", "applications", "appgroup", "app_group"):
                if key not in rule_item:
                    continue
                for path in iter_ref_names(rule_item.get(key)):
                    add_url(access_website_url_name(path))

            for section in iter_url_sections(rule_item):
                for name in iter_ref_names(section):
                    add_url(name)
            return urls

        allow_values = {"1", "true", "pass", "allow", "permit", "accept", "允许", "放行"}
        deny_values = {"0", "false", "deny", "block", "reject", "forbid", "drop", "拒绝", "禁止"}

        def extract_action(rule_item: dict) -> tuple[str, object]:
            """抽取规则动作并归一化为 allow / deny / unknown。

            不同固件字段命名不一，在常见动作键名中容错取值；取不到时返回 unknown，
            前端展示「未知」徽标。拿到真实报文后可按需补充键名/取值映射。
            """
            raw = None
            for key in ("action", "act", "rule_action", "permit", "control", "operate"):
                value = rule_item.get(key)
                if value is not None:
                    raw = value
                    break
            norm = "unknown"
            if raw is not None:
                s = str(raw).strip().lower()
                if s in allow_values:
                    norm = "allow"
                elif s in deny_values:
                    norm = "deny"
            return norm, raw

        def canonical_refs(rule_item: dict) -> list[dict]:
            """从规则的标准结构 ``apps.apps[]`` 抽取可往返编辑的引用。

            返回每个引用的 ``path/type/crc/extra`` 原值（前端编辑时原样回传，
            ``crc`` 始终来自设备读取，本系统不臆造），并附 ``custom``（是否自定义）
            与 ``kind``（``app`` / ``url``，URL 类引用带 ``extra=="url"``）便于前端分组着色。
            """
            refs: list[dict] = []
            apps_field = rule_item.get("apps")
            inner = apps_field.get("apps") if isinstance(apps_field, dict) else None
            if isinstance(inner, list):
                for ref in inner:
                    if not isinstance(ref, dict):
                        continue
                    path = str(ref.get("path") or "").strip()
                    if not path:
                        continue
                    extra = ref.get("extra")
                    extra_str = extra if isinstance(extra, str) else ""
                    refs.append(
                        {
                            "path": path,
                            "type": "" if ref.get("type") is None else str(ref.get("type")),
                            "crc": "" if ref.get("crc") is None else str(ref.get("crc")),
                            "extra": extra_str,
                            "custom": is_custom(path),
                            "kind": "url" if extra_str == "url" else "app",
                        }
                    )
            return refs

        rules: list[dict] = []
        for idx, item in enumerate(rules_raw, start=1):
            apps = []
            for key in ("apps", "app", "application", "applications", "appgroup", "app_group"):
                if key not in item:
                    continue
                for path in iter_ref_names(item.get(key)):
                    apps.append({"path": path, "custom": is_custom(path)})
            apps = list({app["path"]: app for app in apps}.values())
            action, action_raw = extract_action(item)
            raw_action = item.get("action")
            action_bool = raw_action if isinstance(raw_action, bool) else (action == "allow")
            rules.append(
                {
                    "index": idx,
                    "name": item.get("name") or item.get("text") or f"规则{idx}",
                    # rule_id 为设备侧规则标识（modify 往返按它匹配回原规则）
                    "rule_id": "" if item.get("name") is None else str(item.get("name")),
                    "time": "" if item.get("time") is None else str(item.get("time")),
                    "action": action,
                    "action_raw": action_raw,
                    "action_bool": bool(action_bool),
                    "apps": apps,
                    "urls": extract_urls(item),
                    "refs": canonical_refs(item),
                    "raw": item,
                }
            )

        return {
            "policy_name": policy_name,
            "rules": rules,
            "application_include": application_include,
            "enable": bool(result.get("enable", True)),
            "depict": "" if result.get("depict") is None else str(result.get("depict")),
            "appctrl": appctrl,
            "raw": result,
        }

    def create_policy(self, data: dict, *, dry_run: bool = True) -> dict:
        """新建访问权限策略（已据真实抓包确认 ``opr=add``，``data`` 结构同 modify）。

        ``data`` 为完整策略对象（见 :mod:`app.services.policy_template`）。适用用户由设备
        另一条 acnetpolicy 请求保存，不在此报文中。

        新旧固件 add 报文结构一致，唯一差异在 ``ssl`` 段：新固件用 ``{}``，旧固件
        （``acnetpolicy.cgi``）需完整的 ``ssl.sslident`` 默认结构——此处据探测到的路径自动补齐。
        """
        self._ensure_policy_cgi()
        data = dict(data)
        if self.NETPOLICY_CGI == self.ACNETPOLICY_CGI and not data.get("ssl"):
            data["ssl"] = copy.deepcopy(_ACNETPOLICY_SSL_DEFAULT)
        body = {"opr": "add", "data": data}
        return self._write_cgi(self.NETPOLICY_CGI, body, dry_run=dry_run)

    def delete_policy(self, policy_name: str, *, dry_run: bool = True) -> dict:
        """删除访问权限策略（已据真实抓包确认 ``opr=delete``，``name`` 为名称数组，支持批量）。"""
        self._ensure_policy_cgi()
        body = {"opr": "delete", "name": [policy_name]}
        return self._write_cgi(self.NETPOLICY_CGI, body, dry_run=dry_run)

    def move_policy(
        self,
        policy_name: str,
        direction: str,
        *,
        policy_type: str = "访问权限策略",
        dry_run: bool = True,
    ) -> dict:
        """上移 / 下移一条策略，调整其执行顺序（已据真实抓包确认）。

        :param direction: ``up``（moveup）或 ``down``（movedown）。
        报文：``{"opr":"moveup|movedown","data":[{"name":[<策略名>],"type":<类型>}]}``。
        """
        opr = {"up": "moveup", "down": "movedown"}.get(direction)
        if opr is None:
            raise SangforWebError(f"非法的移动方向：{direction!r}（应为 up/down）")
        self._ensure_policy_cgi()
        body = {"opr": opr, "data": [{"name": [policy_name], "type": policy_type}]}
        return self._write_cgi(self.NETPOLICY_CGI, body, dry_run=dry_run)

    def set_policies_status(self, names: list[str], *, enabled: bool, dry_run: bool = True) -> dict:
        """批量启用 / 禁用策略（已据真实抓包确认 ``opr=enable/disable``，``name`` 为名称数组）。"""
        self._ensure_policy_cgi()
        body = {"opr": "enable" if enabled else "disable", "name": list(names)}
        return self._write_cgi(self.NETPOLICY_CGI, body, dry_run=dry_run)

    # listItem 响应里属于「响应信封」而非策略本体的键，往返提交前需剔除。
    _POLICY_ENVELOPE_KEYS = {"success", "msg", "errcode", "errCode", "code", "total", "status", "result"}

    def modify_policy_application(
        self,
        policy_name: str,
        rules: list[dict],
        *,
        application_include: bool | None = None,
        enable: bool | None = None,
        depict: str | None = None,
        dry_run: bool = True,
    ) -> dict:
        """编辑访问权限策略中各规则引用的应用 / URL，并以 ``opr=modify`` 往返提交。

        采用「读—改—写」：先 ``listItem`` 取回**完整策略对象**，仅替换
        ``appctrl.application.data`` 中各规则的动作（允许 / 禁止）与引用列表
        （``apps.apps[]``），其余字段（keyword / filetype / saas / mail / 时间 / 标签…）
        原样保留，最大限度保证往返一致、避免误改未触及的配置。

        :param rules: 前端回传的有序规则列表，每条形如
            ``{"name": <规则ID>, "action": <bool>, "refs": [{"path","type","crc","extra"}...]}``。
            其中每个 ref 的 ``crc`` 必须来自设备读取——本系统不臆造内置/自定义应用的 crc
            （自定义应用的 crc 为设备分配、无法由路径推导）。
        :param application_include: 若给定，覆盖 ``application.include``（是否启用应用控制）。
        """
        self._ensure_policy_cgi()
        full = self._post(self.NETPOLICY_CGI, {"opr": "listItem", "name": policy_name})
        data = {k: v for k, v in full.items() if k not in self._POLICY_ENVELOPE_KEYS}
        data.setdefault("name", policy_name)

        appctrl = data.get("appctrl")
        if not isinstance(appctrl, dict):
            raise SangforWebError(f"策略 {policy_name} 缺少 appctrl，无法编辑")
        application = appctrl.get("application")
        if not isinstance(application, dict):
            raise SangforWebError(f"策略 {policy_name} 缺少 application 段，无法编辑")

        by_name = {
            str(r.get("name")): r for r in (application.get("data") or []) if isinstance(r, dict)
        }

        new_data: list[dict] = []
        for submitted in rules:
            name = str(submitted.get("name", ""))
            base = dict(by_name[name]) if name in by_name else {"name": name}
            if "action" in submitted:
                base["action"] = bool(submitted["action"])
            refs_out: list[dict] = []
            for ref in submitted.get("refs", []) or []:
                if not isinstance(ref, dict) or not ref.get("path"):
                    continue
                out = {
                    "path": str(ref["path"]),
                    "type": ref.get("type", ""),
                    "crc": "" if ref.get("crc") is None else str(ref.get("crc")),
                }
                if ref.get("extra"):
                    out["extra"] = ref["extra"]
                refs_out.append(out)
            apps_field = base.get("apps")
            if isinstance(apps_field, dict):
                apps_field = dict(apps_field)
                apps_field["apps"] = refs_out
                apps_field.setdefault("tags", [])
                apps_field.setdefault("extra", [])
            else:
                apps_field = {"apps": refs_out, "tags": [], "extra": []}
            base["apps"] = apps_field
            base.setdefault("time", "全天")
            new_data.append(base)

        application = dict(application)
        application["data"] = new_data
        if application_include is not None:
            application["include"] = bool(application_include)
        appctrl = dict(appctrl)
        appctrl["application"] = application
        data["appctrl"] = appctrl
        # 启用 / 描述 也可一并更新（仿原生编辑对话框顶部字段）
        if enable is not None:
            data["enable"] = bool(enable)
        if depict is not None:
            data["depict"] = str(depict)

        body = {"opr": "modify", "data": data}
        return self._write_cgi(self.NETPOLICY_CGI, body, dry_run=dry_run)

    # ------------------------------------------------------------------ #
    # 策略应用对象 / 应用目录树  (/cgi-bin/acnetpolicy.cgi)
    # ------------------------------------------------------------------ #
    ACNETPOLICY_CGI = "/cgi-bin/acnetpolicy.cgi"

    def list_app_tree(self, *, contain_url_type: bool = False, contain_file_type: bool = False) -> dict:
        """返回「选择适用应用」对话框的应用目录树（含每个节点的 crc）。

        这是策略规则编辑时挑选应用 / URL 的权威来源：树中每个节点带
        ``name`` / ``type``（``catagory`` 分类 / ``app`` 应用 / ``power`` URL 子类）/
        ``crc`` / ``value``（即引用 path，如 ``"Web流媒体/全部"``）/ ``children``。
        内置与自定义应用、以及「访问网站」下的各 URL 库（含其「网站浏览/文件上传/
        其他上传/HTTPS」4 个子类）都**内联**在这棵树里、crc 均为设备分配——前端选中
        节点后直接用其 ``value`` / ``type`` / ``crc`` 构造规则引用，无需臆造 crc。

        :param contain_url_type: 默认 ``False``，与 AC 原生「选择适用应用」对话框的请求一致；
            原生用 ``False`` 时「访问网站」子树（URL 库）已内联返回，置 ``True`` 反而会清空它。
        :param contain_file_type: 是否包含文件类型（属另一规则段，默认不含）。
        """
        result = self._post(
            self.ACNETPOLICY_CGI,
            {
                "opr": "listAppTree",
                "timeshare": 0,
                "containFileType": contain_file_type,
                "containUrlType": contain_url_type,
            },
        )
        return {"tags": result.get("tags", []) or [], "data": result.get("data", []) or []}

    # ------------------------------------------------------------------ #
    # 连接测试
    # ------------------------------------------------------------------ #
    _LIST_PAYLOAD = {"opr": "list", "start": 0, "limit": 1, "type": 1}

    def _ensure_policy_cgi(self) -> None:
        """探测并缓存正确的策略 CGI 路径（仅在必要时探测一次）。

        新版固件用 ``netpolicy.cgi``，旧版固件用 ``acnetpolicy.cgi``。
        探测结果以实例属性覆盖类属性，后续调用自动使用正确路径，无需重复探测。
        """
        if getattr(self, "_policy_cgi_detected", False):
            return
        try:
            self._post(self.NETPOLICY_CGI, self._LIST_PAYLOAD)
        except SangforWebError as exc:
            if "404" not in str(exc):
                raise
            # 旧版固件：策略接口在 acnetpolicy.cgi
            self._post(self.ACNETPOLICY_CGI, self._LIST_PAYLOAD)
            self.NETPOLICY_CGI = self.ACNETPOLICY_CGI
        self._policy_cgi_detected = True

    def ping(self) -> bool:
        """轻量鉴权探测：发一次最小的 list 请求验证会话与设备**确实可达**。

        自动探测旧版固件（``netpolicy.cgi`` → ``acnetpolicy.cgi``），后续所有策略操作
        自动走正确路径，无需重复探测。
        """
        self._ensure_policy_cgi()
        return True

    def test_connection(self) -> dict[str, Any]:
        """尝试登录并拉取一次策略列表，用于实例连通性测试。"""
        self.login()
        self._ensure_policy_cgi()
        policies = self.list_policies()
        return {
            "ok": True,
            "access_policy_count": len(policies["access_policies"]),
            "ssl_policy_count": len(policies["ssl_decrypt_policies"]),
        }
