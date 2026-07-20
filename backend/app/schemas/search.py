#! /usr/bin/env python3
# coding=utf-8
"""全局搜索相关的 Pydantic 模型。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class SearchHit(BaseModel):
    name: str
    matches: list[str] = []  # 命中的具体条目（域名 / IP / 通配 / 网段）


class SearchNameHit(BaseModel):
    """按**对象名称**命中（子串匹配，与上面按配置内容命中互补）。"""

    kind: Literal["customrule", "url", "policy"]
    name: str
    depict: str = ""  # 描述/备注，便于确认是不是要找的那个对象
    builtin: bool = False  # 仅 kind=url 有意义：是否内置 URL 库


class SearchResult(BaseModel):
    query: str
    query_type: Literal["ip", "domain"]
    apps: list[SearchHit] = []  # 按内容命中的自定义应用
    custom_urls: list[SearchHit] = []  # 按内容命中的自定义 URL 库
    builtin_urls: list[SearchHit] = []  # 按内容命中的内置 URL 库（含用户添加的额外条目）
    # 按名称命中的对象（自定义应用 / URL 库 / 访问权限策略）。策略只参与名称匹配——
    # 其内容是对应用/URL 的引用而非 IP/域名条目，不纳入内容索引。
    name_hits: list[SearchNameHit] = []
    total_hits: int = 0  # 内容命中 + 名称命中
    indexed_apps: int = 0
    indexed_url_groups: int = 0
    indexed_policies: int = 0
    errors: list[str] = []
    cached: bool = False  # 本次结果是否来自缓存索引
    cache_age_seconds: int = 0  # 索引已存在秒数
