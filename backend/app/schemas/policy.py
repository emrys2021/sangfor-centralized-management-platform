#! /usr/bin/env python3
# coding=utf-8
"""访问权限策略编辑请求模型。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class PolicyAppRef(BaseModel):
    """规则引用的一个应用 / URL 对象（与设备 ``apps.apps[]`` 元素对应）。

    ``crc`` 必须来自设备读取（前端从策略详情原样回传）——本系统不臆造
    内置/自定义应用的 crc。
    """

    path: str
    type: str = ""
    crc: str = ""
    extra: str = ""


class PolicyRuleEdit(BaseModel):
    """一条规则的可编辑部分：动作（允许/禁止）与引用列表。"""

    # name 为设备侧规则标识（rule_id），用于往返匹配回原规则以保留其余字段。
    name: str
    action: bool = True
    refs: list[PolicyAppRef] = Field(default_factory=list)


class PolicyApplicationUpdate(BaseModel):
    """访问权限策略「应用控制」编辑请求体。"""

    rules: list[PolicyRuleEdit]
    # 是否启用应用控制（application.include）；None 表示不改动。
    include: bool | None = None
    # 启用该策略 / 描述信息；None 表示不改动。
    enable: bool | None = None
    depict: str | None = None


class PolicyStatusUpdate(BaseModel):
    """批量启用 / 禁用策略请求体。"""

    names: list[str]
    enabled: bool  # True=启用(enable) / False=禁用(disable)


class PolicyRuleCreate(BaseModel):
    """新建策略时的一条规则：动作 + 引用列表（规则 ID 由后端生成）。"""

    action: bool = False
    refs: list[PolicyAppRef] = Field(default_factory=list)


class PolicyCreate(BaseModel):
    """新建访问权限策略请求体。"""

    name: str
    depict: str = ""
    enable: bool = True
    # 是否启用应用控制（application.include，对应「应用控制」勾选）
    include: bool = True
    rules: list[PolicyRuleCreate] = Field(default_factory=list)
