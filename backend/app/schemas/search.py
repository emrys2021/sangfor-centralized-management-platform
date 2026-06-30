#! /usr/bin/env python3
# coding=utf-8
"""全局搜索相关的 Pydantic 模型。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class SearchHit(BaseModel):
    name: str
    matches: list[str] = []  # 命中的具体条目（域名 / IP / 通配 / 网段）


class SearchResult(BaseModel):
    query: str
    query_type: Literal["ip", "domain"]
    apps: list[SearchHit] = []  # 命中的自定义应用
    custom_urls: list[SearchHit] = []  # 命中的自定义 URL 库
    builtin_urls: list[SearchHit] = []  # 命中的内置 URL 库（含用户添加的额外条目）
    total_hits: int = 0
    indexed_apps: int = 0
    indexed_url_groups: int = 0
    errors: list[str] = []
    cached: bool = False  # 本次结果是否来自缓存索引
    cache_age_seconds: int = 0  # 索引已存在秒数
