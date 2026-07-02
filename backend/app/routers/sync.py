#! /usr/bin/env python3
# coding=utf-8
"""功能 5：跨实例同步路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, get_current_user
from app.db.base import get_db
from app.sangfor.web_client import SangforWebError
from app.schemas.sync import (
    BatchCompareRequest,
    BatchCompareResult,
    BatchSyncRequest,
    BatchSyncResult,
    SyncApplyRequest,
    SyncApplyResult,
    SyncDiffRequest,
    SyncDiffResult,
)
from app.services import compare_service, sync_service

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/diff", response_model=SyncDiffResult)
def compute_diff(req: SyncDiffRequest, db: Session = Depends(get_db)):
    """引导式同步第一步：拉取源与目标快照并返回字段级差异。"""
    try:
        return sync_service.compute_diff(
            db,
            req.object_type,
            req.object_name,
            req.source_instance_id,
            req.target_instance_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/batch", response_model=BatchSyncResult)
def batch_sync(
    req: BatchSyncRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """批量同步：把源实例某类对象的全部同步到目标；``mirror=True`` 时删除目标多余对象。默认 dry-run。"""
    try:
        return sync_service.batch_sync(
            db,
            user,
            object_type=req.object_type,
            source_instance_id=req.source_instance_id,
            target_instance_ids=req.target_instance_ids,
            push_all=req.push_all,
            mirror=req.mirror,
            dry_run=req.dry_run,
            allow_degrade=req.allow_degrade,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/compare", response_model=BatchCompareResult)
def compare(req: BatchCompareRequest, db: Session = Depends(get_db)):
    """只读全量对比：把源实例某类对象的全集与内容，逐个目标比对，返回四分类结果。不写设备。"""
    try:
        return compare_service.compare(
            db,
            object_type=req.object_type,
            source_instance_id=req.source_instance_id,
            target_instance_ids=req.target_instance_ids,
            names_only=req.names_only,
            force=req.force,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/apply", response_model=SyncApplyResult)
def apply_sync(
    req: SyncApplyRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """执行同步。``push_all=True`` 时推送到所有其他启用实例；默认 dry-run。"""
    try:
        return sync_service.apply_sync(
            db,
            user,
            object_type=req.object_type,
            object_name=req.object_name,
            source_instance_id=req.source_instance_id,
            target_instance_ids=req.target_instance_ids,
            push_all=req.push_all,
            dry_run=req.dry_run,
            allow_degrade=req.allow_degrade,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
