#! /usr/bin/env python3
# coding=utf-8
"""组织 / 用户 CGI 能力（``listorg.cgi`` 组织树、``org.cgi`` 组内成员）。

用于「策略引用校验」：遍历组织树各组，取每个组的**用户**（``org:false`` 行）及其
设备算好的**生效策略**（``strategy``，已含组默认 + 用户添加 − 排除），据此统计每条访问
权限策略被多少用户引用、找出无人引用的策略。同时返回**子组行**（``org:true``）的
生效策略，用于把用户的「继承所属组」占位符展开为组的实际策略（见 ``list_org_members``）。
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

    def list_org_members(self, org_id: str, *, page_size: int = 2000) -> dict:
        """返回某组的直接子项：**用户**（``org:false``）与**子组**（``org:true``），自动翻页。

        返回 ``{"users": [{name, strategy, status}], "subgroups": [{id, name, strategy}]}``：

        - ``users`` 的 ``strategy`` 是设备算好的生效策略串（默认 + 添加 − 排除）；但部分固件
          （如深圳 AC）对「完全继承所属组、无个人改动」的用户，用户行 ``strategy`` 只写占位符
          ``"与所属组相同"``，真正的策略清单落在该组作为**子组行**出现在其**父组**列表里。
        - 故这里同时返回子组行（``org:true``）的 ``id`` 与 ``strategy``，供上层建立
          ``组id → 生效策略`` 映射、把用户的「继承占位」展开为所属组的实际策略。
        """
        users: list[dict] = []
        subgroups: list[dict] = []
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
                if not isinstance(row, dict):
                    continue
                if row.get("org"):  # 子组行：带该组的生效策略
                    subgroups.append(
                        {
                            "id": str(row.get("id", "") or ""),
                            "name": row.get("name", ""),
                            "strategy": row.get("strategy", "") or "",
                        }
                    )
                else:  # 用户行
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
        return {"users": users, "subgroups": subgroups}
