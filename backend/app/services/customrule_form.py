#! /usr/bin/env python3
# coding=utf-8
"""自定义应用（customrule）表单字段 <-> AC 报文 的解析与构造。

报文结构依据真实抓包（编辑/modify）确定：

    {"opr": "modify", "data": {
        "basic": {"name": ..., "depict": ..., "type": ..., "appname": ...},
        "packet": {
            "0": <方向LAN<->WAN>, "1": <LAN->WAN>, "2": <WAN->LAN>,
            "direction": "0"|"1"|"2",
            "protocol": <int>, "pn": <int 协议号>,
            "port": "all_port"|"specified_port", "all_port": <bool>,
            "specified_port": {"port_range": ..., "enable": <bool>},
            "ip": "all_ip"|"specified_ip", "all_ip": <bool>,
            "specified_ip": {"ip_range": ..., "enable": <bool>},
            "site": <匹配目标域名>
        },
        "enable": <bool 启用应用>
    }}

``opr`` 由 :mod:`app.sangfor.web_client` 负责包裹（modify / add）；本模块只产出 ``data``。
应用类型 / 应用名称在界面里固定带「自定义应用_」前缀，报文中存的是去前缀后的值，
故解析时去前缀、构造时按去前缀值提交。
"""

from __future__ import annotations

PREFIX = "自定义应用_"

# UI 方向枚举 <-> 报文 direction 编码
_DIR_TO_UI = {"0": "both", "1": "lan2wan", "2": "wan2lan"}
_UI_TO_DIR = {"both": "0", "lan2wan": "1", "wan2lan": "2"}


def _strip_prefix(value: str | None) -> str:
    value = value or ""
    return value[len(PREFIX):] if value.startswith(PREFIX) else value


def _to_int(value, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def parse_form(summary: dict, detail: dict) -> dict:
    """AC 概要(list) + 详情(listItem.data) -> 前端表单字段。"""
    summary = summary or {}
    packet = (detail or {}).get("packet", {}) or {}
    sip = packet.get("specified_ip", {}) or {}
    sport = packet.get("specified_port", {}) or {}

    # 端口/IP 模式优先看 port/ip 字符串，回退到 all_port/all_ip 布尔
    if packet.get("port") is not None:
        port_all = packet.get("port") == "all_port"
    else:
        port_all = bool(packet.get("all_port", True))
    if packet.get("ip") is not None:
        ip_all = packet.get("ip") == "all_ip"
    else:
        ip_all = bool(packet.get("all_ip", True))

    return {
        "status": bool(summary.get("status", (detail or {}).get("enable", True))),
        "rulename": summary.get("rulename", "") or "",
        "depict": summary.get("depict", "") or "",
        "apptype": _strip_prefix(summary.get("apptype", "")),
        "appname": _strip_prefix(summary.get("appname", "")),
        "direction": _DIR_TO_UI.get(str(packet.get("direction", "0")), "both"),
        "protocol": str(packet.get("protocol", 0)),
        "protocol_num": "" if packet.get("pn", "") in (None, "") else str(packet.get("pn")),
        "port_mode": "all" if port_all else "specified",
        "port_range": sport.get("port_range", "") or "",
        "ip_mode": "all" if ip_all else "specified",
        "ip_range": sip.get("ip_range", "") or "",
        "domain": packet.get("site", "") or "",
    }


def build_payload(form: dict) -> dict:
    """前端表单字段 -> AC 写入报文的 ``data`` 部分。"""
    dir_code = _UI_TO_DIR.get(form.get("direction", "both"), "0")
    port_specified = form.get("port_mode") == "specified"
    ip_specified = form.get("ip_mode") == "specified"

    # 协议号：留空时报文用空串（与抓包一致），有值时转 int
    pn_raw = str(form.get("protocol_num", "")).strip()
    pn_value: object = _to_int(pn_raw, 0) if pn_raw != "" else ""

    return {
        "basic": {
            "name": form.get("rulename", ""),
            "depict": form.get("depict", ""),
            "type": _strip_prefix(form.get("apptype", "")),
            "appname": _strip_prefix(form.get("appname", "")),
        },
        "packet": {
            "0": dir_code == "0",
            "1": dir_code == "1",
            "2": dir_code == "2",
            "direction": dir_code,
            "protocol": _to_int(form.get("protocol", 0), 0),
            "pn": pn_value,
            "port": "specified_port" if port_specified else "all_port",
            "all_port": not port_specified,
            "specified_port": {
                "port_range": form.get("port_range", "") if port_specified else "",
                "enable": port_specified,
            },
            "ip": "specified_ip" if ip_specified else "all_ip",
            "all_ip": not ip_specified,
            "specified_ip": {
                "ip_range": form.get("ip_range", "") if ip_specified else "",
                "enable": ip_specified,
            },
            "site": form.get("domain", ""),
        },
        "enable": bool(form.get("status", True)),
    }
