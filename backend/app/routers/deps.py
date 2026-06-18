#! /usr/bin/env python3
# coding=utf-8
"""路由共享依赖。"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Path
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.db.models import Instance
from app.services import instance_service


def get_instance_dep(
    instance_id: int = Path(..., description="实例 ID"),
    db: Session = Depends(get_db),
) -> Instance:
    inst = instance_service.get_instance(db, instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail="实例不存在")
    if not inst.enabled:
        raise HTTPException(status_code=400, detail="实例已禁用")
    return inst
