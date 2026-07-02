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
    # 策略同步：目标缺失引用会被丢弃、写出「降级（不等价）」策略。默认拒绝真实写入降级版本，
    # 需显式置 True 才写入（dry-run 不受限，始终预览降级）。
    allow_degrade: bool = False


class TargetApplyResult(BaseModel):
    instance_id: int
    instance_name: str
    success: bool
    dry_run: bool
    # 策略同步：因丢弃了目标缺失的引用，写出/将写出的策略与源不等价（降级）。
    degraded: bool = False
    # 策略同步：因存在无法解析的引用且未允许降级而**被拒绝、未写策略**（安全拦截，非写入失败）；
    # 注意策略虽未写，但此前已成功创建的自定义引用对象会保留在目标设备（见 warnings/details）。
    refused: bool = False
    message: str = ""
    payload: dict | None = None
    # 跨实例策略同步：目标上**无法解析的被引用路径**——内置对象在目标缺失，或自定义引用对象创建失败。
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
    # 策略：允许写入「降级（丢弃了目标缺失引用、与源不等价）」的策略；默认拒绝（见 SyncApplyRequest）。
    allow_degrade: bool = False


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


# --------------------------------------------------------------------------- #
# 全量对比：只读地比对两个实例某类对象的全集与逐对象内容（不写设备）
# --------------------------------------------------------------------------- #
class BatchCompareRequest(BaseModel):
    object_type: ObjectType
    source_instance_id: int
    target_instance_ids: list[int] = []
    # names_only=True：只比对象名单（仅源有 / 仅目标有 / 两边都有），不拉详情，秒级；
    # False：比名单 + 内容（仅源有 / 仅目标有 / 一致 / 不一致）。
    names_only: bool = False
    force: bool = False  # True 时绕过快照缓存强制重新拉取


class CompareItem(BaseModel):
    """单个对象名在源/目标间的对比结果。

    - ``source_only``：仅源实例有（同步会新增到目标）；内容对比时带 ``source_snapshot``。
    - ``target_only``：仅目标实例有（源没有）；内容对比时带 ``target_snapshot``。
    - ``both``：两边都有（仅名单对比时使用，未比内容）。
    - ``identical``：两边都有且内容一致；只带对象名（快照省略以减小报文）。
    - ``different``：两边都有但内容不一致；带 ``source_snapshot`` + ``diffs``（字段级差异，
      策略为 ``rules`` 字段携带两边规则列表供前端按规则位置展开）。
    - ``error``：两边至少一侧读取/解析失败，无法判定。
    """

    name: str
    status: Literal["source_only", "target_only", "both", "identical", "different", "error"]
    diffs: list[FieldDiff] = []
    source_snapshot: dict | None = None
    target_snapshot: dict | None = None
    error: str = ""


class CompareTargetResult(BaseModel):
    instance_id: int
    instance_name: str
    error: str = ""  # 整体性错误（连接/登录失败）
    source_only: int = 0
    target_only: int = 0
    both: int = 0  # 仅名单对比：两边都有的数量（内容对比时恒为 0，拆入 identical/different）
    identical: int = 0
    different: int = 0
    error_count: int = 0
    items: list[CompareItem] = []


class BatchCompareResult(BaseModel):
    object_type: ObjectType
    source_instance_id: int
    source_count: int  # 源上该类对象数量
    names_only: bool = False  # 本次是否为「仅名单」对比
    source_cached: bool = False  # 源快照是否命中缓存（仅内容对比有意义）
    source_cache_age_seconds: int = 0
    targets: list[CompareTargetResult] = []
