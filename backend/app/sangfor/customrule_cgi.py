#! /usr/bin/env python3
# coding=utf-8
"""自定义应用 / 规则 CGI 能力（``/cgi-bin/customrule.cgi``）。"""
from __future__ import annotations

from app.sangfor.web_base import SangforWebError


class CustomRuleCgiMixin:
    """自定义应用 list/listItem 与 新增/编辑/删除（mixin，需与 SangforWebBase 组合）。"""

    CUSTOMRULE_CGI = "/cgi-bin/customrule.cgi"

    def list_custom_rules(self) -> list[dict]:
        """返回所有自定义规则的概要列表。"""
        result = self._post(self.CUSTOMRULE_CGI, {"opr": "list"})
        return result.get("data", []) or []

    def get_custom_rule_detail(self, rule_name: str, summary: dict | None = None) -> dict:
        """返回指定自定义规则的详情，含解析后的 IP / 端口范围。

        :param summary: 可选，已从 list 拿到的该规则概要；提供则跳过一次 list 调用
            （批量分析时避免 N 次重复 list）。
        """
        matched = summary
        if matched is None:
            rules = self.list_custom_rules()
            matched = next((it for it in rules if it.get("rulename") == rule_name), None)
        if not matched:
            raise SangforWebError(f"未找到自定义规则: {rule_name}")

        payload = {
            "opr": "listItem",
            "name": rule_name,
            "oldData": {
                "rulename": matched.get("rulename", ""),
                "appname": matched.get("appname", ""),
                "depict": matched.get("depict", ""),
                "apptype": matched.get("apptype", ""),
                "status": matched.get("status", False),
            },
        }
        detail = self._post(self.CUSTOMRULE_CGI, payload).get("data", {}) or {}
        packet = detail.get("packet", {}) or {}
        ip_range = (packet.get("specified_ip", {}) or {}).get("ip_range", "") or ""
        port_range = (packet.get("specified_port", {}) or {}).get("port_range", "") or ""
        return {
            "summary": matched,
            "detail": detail,
            "ip_range": ip_range,
            "ip_list": [s.strip() for s in ip_range.splitlines() if s.strip()],
            "port_range": port_range,
            "port_list": [p.strip() for p in port_range.split(",") if p.strip()],
        }

    def create_custom_rule(self, data: dict, *, dry_run: bool = True) -> dict:
        """新增自定义应用（已据真实抓包确认 ``opr=add``）。

        ``data`` 为 :func:`customrule_form.build_payload` 产出的 data 部分。
        """
        body = {"opr": "add", "data": data}
        return self._write_cgi(self.CUSTOMRULE_CGI, body, dry_run=dry_run)

    def update_custom_rule(self, data: dict, *, dry_run: bool = True) -> dict:
        """编辑自定义应用（已据真实抓包确认 ``opr=modify``）。

        ``data`` 结构与「新增」相同（共用 :func:`customrule_form.build_payload`）；设备按
        ``data.basic.name`` 定位原应用，modify 报文**不需要** oldData 等额外标识字段。
        """
        body = {"opr": "modify", "data": data}
        return self._write_cgi(self.CUSTOMRULE_CGI, body, dry_run=dry_run)

    def delete_custom_rule(self, rule_name: str, *, dry_run: bool = True) -> dict:
        """删除自定义应用（已据真实抓包确认 ``opr=delete``，name 为名称数组，支持批量）。"""
        body = {"opr": "delete", "name": [rule_name]}
        return self._write_cgi(self.CUSTOMRULE_CGI, body, dry_run=dry_run)
