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
    # 跨实例策略同步：目标缺失的被引用路径（内置对象，无法自动创建、已跳过）。
    warnings: list[str] = []
    # 逐步结果日志（建自定义引用、写策略各请求的成功/失败与详情），便于排查。
    details: list[str] = []


class SyncApplyResult(BaseModel):
    object_type: ObjectType
    object_name: str
    source_instance_id: int
    results: list[TargetApplyResult] = []


# --------------------------------------------------------------------------- #
# 批量同步：把某类对象的全部从源同步到目标（可选镜像删除）
# --------------------------------------------------------------------------- #
class BatchSyncRequest(BaseModel):
    object_type: ObjectType
    source_instance_id: int
    target_instance_ids: list[int] = []
    push_all: bool = False  # True 时忽略 target_instance_ids，推送到所有其他启用实例
    # 镜像模式：删除目标上「源没有」的同类对象（仅自定义对象；内置 URL 库不受影响）
    mirror: bool = False
    dry_run: bool = True


class BatchObjectResult(BaseModel):
    name: str
    action: Literal["create", "update", "delete", "skip", "fail"]
    ok: bool = True
    message: str = ""


class BatchTargetResult(BaseModel):
    instance_id: int
    instance_name: str
    dry_run: bool
    created: list[str] = []
    updated: list[str] = []
    deleted: list[str] = []  # 镜像删除（目标多余对象）
    failed: list[BatchObjectResult] = []
    details: list[BatchObjectResult] = []  # 逐对象明细
    error: str = ""  # 整体性错误（如连接失败）


class BatchSyncResult(BaseModel):
    object_type: ObjectType
    source_instance_id: int
    source_count: int  # 源上该类对象数量
    mirror: bool
    targets: list[BatchTargetResult] = []
