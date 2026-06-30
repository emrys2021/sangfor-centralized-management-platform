#! /usr/bin/env python3
# coding=utf-8
"""组织 / 用户 CGI 能力（``listorg.cgi`` 组织树、``org.cgi`` 组内成员）。

用于「策略引用校验」：遍历组织树各组，取每个组的**用户**（``org:false`` 行）及其
设备算好的**生效策略**（``strategy``，已含组默认 + 用户添加 − 排除），据此统计每条访问
权限策略被多少用户引用、找出无人引用的策略。
"""
from __future__ import annotations


class OrgCgiMixin:
    """组织树与组内成员查询（mixin，需与 :class:`SangforWebBase` 组合）。"""

    LISTORG_CGI = "/cgi-bin/listorg.cgi"
    ORG_CGI = "/cgi-bin/org.cgi"

    def list_org_tree(self) -> list[dict]:
        """返回组织树**展平**后的所有组节点：``[{id, name, leaf}]``（含根）。

        ``listorg.cgi`` 的 ``listorgtree`` 返回嵌套 ``data.children``；这里递归展平，
        供逐组查询成员。``listItem`` 非递归（只返回某组的直接子项），故需遍历每个节点。
        """
        result = self._post(self.LISTORG_CGI, {"opr": "listorgtree"})
        nodes: list[dict] = []

        def walk(node) -> None:
            if not isinstance(node, dict):
                return
            nid = node.get("id")
            if nid:
                nodes.append({"id": str(nid), "name": node.get("text", ""), "leaf": bool(node.get("leaf"))})
            for child in node.get("children") or []:
                walk(child)

        walk(result.get("data") or {})
        return nodes

    def list_org_members(self, org_id: str, *, page_size: int = 2000) -> list[dict]:
        """返回某组的直接成员**用户**（``org:false`` 行）及其生效策略，自动翻页。

        返回 ``[{name, strategy, status}]``，``strategy`` 为逗号分隔的生效策略名串
        （设备已算好默认 + 添加 − 排除）；子组（``org:true``）被跳过。
        """
        users: list[dict] = []
        start = 0
        while True:
            body = {
                "start": start,
                "limit": page_size,
                "sort": "name",
                "dir": "ASC",
                "filter": {"id": str(org_id)},
                "opr": "listItem",
                "voerlap": 0,
                "type": 1,
            }
            result = self._post(self.ORG_CGI, body)
            rows = result.get("data") or []
            if not isinstance(rows, list):
                break
            for row in rows:
                if isinstance(row, dict) and not row.get("org"):  # 跳过子组，只收用户
                    users.append(
                        {
                            "name": row.get("name", ""),
                            "strategy": row.get("strategy", "") or "",
                            "status": bool(row.get("status", True)),
                        }
                    )
            total = int(result.get("count", 0) or 0)
            start += len(rows)
            if not rows or start >= total or len(rows) < page_size:
                break
        return users
