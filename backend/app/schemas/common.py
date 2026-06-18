#! /usr/bin/env python3
# coding=utf-8
"""通用 Pydantic 模型。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


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
    created_at: datetime
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
