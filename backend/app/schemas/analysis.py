#! /usr/bin/env python3
# coding=utf-8
"""自定义应用重叠分析的 Pydantic 模型。"""

from __future__ import annotations

from pydantic import BaseModel


class AppRef(BaseModel):
    """某资源（IP/域名）被某个自定义应用引用时的上下文。"""

    name: str
    direction: str
    protocol: str
    protocol_num: str = ""
    port: str  # 端口展示文本：「所有端口」或具体范围


class ResourceOverlap(BaseModel):
    """一个被多个自定义应用引用的资源（IP 或域名）。"""

    value: str
    type: str  # ip | domain
    count: int
    apps: list[AppRef]
    # 是否存在「方向+协议+端口」也重叠的强冲突（同一报文可能被多应用同时命中）
    conflict: bool = False


class AppSummary(BaseModel):
    name: str
    direction: str
    protocol: str
    port: str
    ip_count: int
    domain_count: int
    ips: list[str] = []
    domains: list[str] = []


class PolicyLink(BaseModel):
    """访问权限策略引用某自定义应用的关系。"""

    policy: str
    app: str  # 自定义应用的规则名
    # 该策略引用此应用的动作（首条命中规则为准）：allow（放行）/ deny（拒绝）/ unknown
    action: str = "unknown"


class UrlSummary(BaseModel):
    name: str
    url_count: int
    urls: list[str] = []


class PolicyUrlLink(BaseModel):
    """访问权限策略引用某自定义 URL 库的关系。"""

    policy: str
    url: str  # 自定义 URL 库名
    rules: list[dict] = []
    # 该策略引用此 URL 库的动作（首条命中规则为准）：allow / deny / unknown
    action: str = "unknown"


class PolicyUsageItem(BaseModel):
    """一条访问权限策略的引用情况。"""

    name: str
    depict: str = ""
    founder: str = ""
    status: bool = True
    order: int = 0
    user_count: int = 0  # 引用此策略的用户数（0 = 无人使用）
    used: bool = True


class PolicyUsageResult(BaseModel):
    policies: list[PolicyUsageItem] = []
    total_policies: int = 0
    unused_count: int = 0
    total_users: int = 0
    errors: list[str] = []
    cached: bool = False
    cache_age_seconds: int | None = None


class CustomRuleAnalysis(BaseModel):
    total_apps: int
    analyzed_apps: int
    ip_overlaps: list[ResourceOverlap]
    domain_overlaps: list[ResourceOverlap]
    apps: list[AppSummary]
    urls: list[UrlSummary] = []
    policies: list[str] = []
    policy_links: list[PolicyLink] = []
    policy_url_links: list[PolicyUrlLink] = []
    policy_count: int = 0
    url_count: int = 0
    errors: list[str] = []
    # 本次结果是否来自服务端缓存，以及缓存已存在的秒数（前端展示「缓存 · N 分钟前」）
    cached: bool = False
    cache_age_seconds: int | None = None
