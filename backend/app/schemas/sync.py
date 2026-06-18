#! /usr/bin/env python3
# coding=utf-8
"""跨实例同步相关的 Pydantic 模型。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

ObjectType = Literal["customrule", "url", "policy"]


class SyncDiffRequest(BaseModel):
    object_type: ObjectType
    object_name: str
    source_instance_id: int
    target_instance_ids: list[int]


class FieldDiff(BaseModel):
    field: str
    source: Any = None
    target: Any = None


class TargetDiff(BaseModel):
    instance_id: int
    instance_name: str
    exists: bool
    changed: bool
    diffs: list[FieldDiff] = []
    error: str = ""


class SyncDiffResult(BaseModel):
    object_type: ObjectType
    object_name: str
    source_instance_id: int
    source_snapshot: dict | None = None
    targets: list[TargetDiff] = []


class SyncApplyRequest(BaseModel):
    object_type: ObjectType
    object_name: str
    source_instance_id: int
    target_instance_ids: list[int] = []
    # push_all=True 时忽略 target_instance_ids，推送到所有其他启用实例
    push_all: bool = False
    dry_run: bool = True


class TargetApplyResult(BaseModel):
    instance_id: int
    instance_name: str
    success: bool
    dry_run: bool
    message: str = ""
    payload: dict | None = None
    # 跨实例策略同步：目标缺失的被引用路径（自定义应用 / URL 库未先同步）。
    warnings: list[str] = []


class SyncApplyResult(BaseModel):
    object_type: ObjectType
    object_name: str
    source_instance_id: int
    results: list[TargetApplyResult] = []
