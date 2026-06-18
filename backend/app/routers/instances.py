#! /usr/bin/env python3
# coding=utf-8
"""实例管理路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import CurrentUser, get_current_user
from app.db.base import get_db
from app.schemas.instance import (
    ConnectionTestResult,
    InstanceCreate,
    InstanceHealth,
    InstanceOut,
    InstanceUpdate,
)
from app.services import instance_service

router = APIRouter(prefix="/api/instances", tags=["instances"])


@router.get("", response_model=list[InstanceOut])
def list_instances(only_enabled: bool = False, db: Session = Depends(get_db)):
    return instance_service.list_instances(db, only_enabled=only_enabled)


@router.post("", response_model=InstanceOut, status_code=201)
def create_instance(
    data: InstanceCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    out = instance_service.create_instance(db, data)
    audit.record(
        db,
        actor=user.username,
        object_type="instance",
        action="create",
        object_name=out.name,
        instance_id=out.id,
        instance_name=out.name,
        message=f"新建实例「{out.name}」（{out.host}）",
    )
    return out


@router.get("/{instance_id}", response_model=InstanceOut)
def get_instance(instance_id: int, db: Session = Depends(get_db)):
    out = instance_service.get_instance_out(db, instance_id)
    if not out:
        raise HTTPException(status_code=404, detail="实例不存在")
    return out


@router.put("/{instance_id}", response_model=InstanceOut)
def update_instance(
    instance_id: int,
    data: InstanceUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    out = instance_service.update_instance(db, instance_id, data)
    if not out:
        raise HTTPException(status_code=404, detail="实例不存在")
    audit.record(
        db,
        actor=user.username,
        object_type="instance",
        action="update",
        object_name=out.name,
        instance_id=out.id,
        instance_name=out.name,
        message=f"编辑实例「{out.name}」",
    )
    return out


@router.delete("/{instance_id}", status_code=204)
def delete_instance(
    instance_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    ok = instance_service.delete_instance(db, instance_id)
    if not ok:
        raise HTTPException(status_code=404, detail="实例不存在")
    audit.record(
        db,
        actor=user.username,
        object_type="instance",
        action="delete",
        object_name=str(instance_id),
        instance_id=instance_id,
        message=f"删除实例 #{instance_id}",
    )


@router.get("/{instance_id}/health", response_model=InstanceHealth)
def instance_health(instance_id: int, db: Session = Depends(get_db)):
    """轻量健康检查（复用会话池）：供实例切换器显示连接状态指示。"""
    return InstanceHealth(**instance_service.check_instance_health(db, instance_id))


@router.post("/{instance_id}/test", response_model=ConnectionTestResult)
def test_connection(instance_id: int, db: Session = Depends(get_db)):
    result = instance_service.test_connection(db, instance_id)
    return ConnectionTestResult(**result)
