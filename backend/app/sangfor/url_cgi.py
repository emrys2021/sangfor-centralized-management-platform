#! /usr/bin/env python3
# coding=utf-8
"""自定义 URL 库 CGI 能力（``/cgi-bin/objurlgrp.cgi``）。"""
from __future__ import annotations


class UrlCgiMixin:
    """URL 库 list/listItem/query 与 新增/编辑/删除（mixin，需与 SangforWebBase 组合）。"""

    OBJURLGRP_CGI = "/cgi-bin/objurlgrp.cgi"

    def list_url_groups(self) -> dict:
        """返回 URL 库的原始树与拍平后的节点列表。"""
        result = self._post(self.OBJURLGRP_CGI, {"anode": None, "opr": "list"})
        tree = result.get("data", []) or []
        flat: list[dict] = []

        def walk(nodes, parent_id=None, parent_name="", level=1, prefix=""):
            if not isinstance(nodes, list):
                return
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                name = "" if node.get("name") is None else str(node.get("name"))
                full_path = name if not prefix else f"{prefix}/{name}"
                flat.append(
                    {
                        "id": node.get("id", ""),
                        "name": name,
                        "depict": "" if node.get("depict") is None else str(node.get("depict")),
                        "inside": node.get("inside", ""),
                        "leaf": node.get("leaf", ""),
                        "parent_id": parent_id,
                        "parent_name": parent_name,
                        "level": level,
                        "full_path": full_path,
                    }
                )
                children = node.get("children", [])
                if children:
                    walk(children, node.get("id", ""), name, level + 1, full_path)

        walk(tree)
        return {"tree": tree, "flat": flat}

    def get_url_group_content(self, group_name: str) -> list[str]:
        """返回指定 URL 库中的所有 URL 条目。"""
        result = self._post(self.OBJURLGRP_CGI, {"opr": "listItem", "name": group_name})
        raw = result.get("data", {}).get("url", "") or ""
        return [u for u in raw.split("\r\n") if u]

    def get_url_group_detail(self, group_name: str) -> dict:
        """返回指定 URL 库的可编辑详情：``id`` / ``name`` / ``depict`` / ``url`` / ``keyword``。

        用于编辑表单回填。``url`` 同时给出去空行的列表与原始换行文本（便于直接写回）。
        """
        result = self._post(self.OBJURLGRP_CGI, {"opr": "listItem", "name": group_name})
        data = result.get("data", {}) or {}
        url_text = str(data.get("url", "") or "").replace("\r\n", "\n")
        return {
            "id": str(data.get("id", "") or ""),
            "name": str(data.get("name", group_name) or group_name),
            "depict": str(data.get("depict", "") or ""),
            "url": [u for u in url_text.split("\n") if u],
            "url_text": url_text,
            "keyword": str(data.get("keyword", "") or ""),
        }

    def query_domain_class(self, domain: str) -> str:
        """查询某域名所属的内置分类。"""
        d = self.get_domain(domain) or domain
        result = self._post(self.OBJURLGRP_CGI, {"opr": "query", "url": d})
        return result.get("url", "").split("[")[-1][:-1] if result.get("url") else ""

    def create_url_group(self, data: dict, *, dry_run: bool = True) -> dict:
        """新增自定义 URL 库（已据真实抓包确认 ``opr=add``）。

        ``data`` 为 ``{id, name, depict, url, keyword}``；``url`` 为换行分隔的 URL/IP 文本。
        """
        return self._write_cgi(self.OBJURLGRP_CGI, {"opr": "add", "data": data}, dry_run=dry_run)

    def update_url_group(self, data: dict, *, dry_run: bool = True) -> dict:
        """编辑自定义 URL 库（已据真实抓包确认 ``opr=modify``，按库名匹配）。"""
        return self._write_cgi(self.OBJURLGRP_CGI, {"opr": "modify", "data": data}, dry_run=dry_run)

    def delete_url_group(self, group_name: str, *, dry_run: bool = True) -> dict:
        """删除自定义 URL 库（已据真实抓包确认 ``opr=delete``，name 为名称数组，支持批量）。"""
        body = {"opr": "delete", "name": [group_name]}
        return self._write_cgi(self.OBJURLGRP_CGI, body, dry_run=dry_run)
