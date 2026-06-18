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
    SyncApplyRequest,
    SyncApplyResult,
    SyncDiffRequest,
    SyncDiffResult,
)
from app.services import sync_service

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
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
