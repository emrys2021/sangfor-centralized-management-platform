#! /usr/bin/env python3
# coding=utf-8
"""实例相关的 Pydantic 模型。

凭据（Web 密码 / API 密钥）只接受写入，永不在响应中回显明文。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class InstanceBase(BaseModel):
    name: str = Field(..., max_length=128)
    description: str = ""
    protocol: str = "https"
    host: str
    web_port: int = 443
    api_port: int = 9999
    web_user: str = ""
    enabled: bool = True


class InstanceCreate(InstanceBase):
    web_password: str = ""
    api_key: str = ""


class InstanceUpdate(BaseModel):
    """部分更新；凭据字段为 None 时保持不变。"""

    description: str | None = None
    protocol: str | None = None
    host: str | None = None
    web_port: int | None = None
    api_port: int | None = None
    web_user: str | None = None
    web_password: str | None = None
    api_key: str | None = None
    enabled: bool | None = None


class InstanceOut(InstanceBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    has_web_password: bool = False
    has_api_key: bool = False
    created_at: datetime
    updated_at: datetime


class ConnectionTestResult(BaseModel):
    web_ok: bool = False
    api_ok: bool = False
    detail: dict = {}
    message: str = ""


class InstanceHealth(BaseModel):
    """实例连接健康状态（用于实例切换器的状态指示）。

    status：``ok`` 可连接 / ``error`` 连接失败 / ``disabled`` 已禁用 /
    ``unconfigured`` 未配置凭据。
    """

    instance_id: int
    status: str
    message: str = ""
