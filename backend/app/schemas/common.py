#! /usr/bin/env python3
# coding=utf-8
"""通用 Pydantic 模型。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict


def _ensure_utc(v: datetime) -> datetime:
    """给无时区的时间补上 UTC 标记。

    数据库列是无时区 DateTime、存的是 UTC；直接序列化会输出不带时区的
    ISO 串，前端 ``new Date()`` 会把它当**本地时间**解析，显示差一个时区
    （国内环境早 8 小时）。补上 tzinfo 后序列化为 ``...+00:00``，前端可正确换算。
    """
    return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v


# 响应模型中所有「库里存的 UTC 时间」字段统一用本类型，保证带时区序列化。
UtcDatetime = Annotated[datetime, AfterValidator(_ensure_utc)]


class WriteResult(BaseModel):
    """写操作返回。``dry_run`` 时 ``payload`` 为将提交的报文预览。"""

    dry_run: bool
    success: bool = True
    message: str = ""
    payload: dict | None = None
    result: Any = None


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: UtcDatetime
    actor: str
    instance_id: int | None
    instance_name: str
    object_type: str
    object_name: str
    action: str
    success: bool
    message: str
    before: str
    after: str


class PageResult(BaseModel):
    total: int
    items: list[Any]
