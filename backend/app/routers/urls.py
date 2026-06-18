#! /usr/bin/env python3
# coding=utf-8
"""功能 2：自定义 URL 库路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, get_current_user
from app.db.base import get_db
from app.db.models import Instance
from app.routers.deps import get_instance_dep
from app.sangfor.web_client import SangforWebError
from app.schemas.common import WriteResult
from app.schemas.url import UrlGroupForm
from app.services import url_service

router = APIRouter(prefix="/api/instances/{instance_id}/urls", tags=["urls"])


@router.get("")
def list_groups(instance: Instance = Depends(get_instance_dep)):
    try:
        return url_service.list_groups(instance)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{group_name}")
def get_group_content(group_name: str, instance: Instance = Depends(get_instance_dep)):
    try:
        return url_service.get_group_content(instance, group_name)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("", response_model=WriteResult)
def create_group(
    form: UrlGroupForm,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = url_service.create_group(db, user, instance, form.model_dump(), dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{group_name}", response_model=WriteResult)
def update_group(
    group_name: str,
    form: UrlGroupForm,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = url_service.update_group(db, user, instance, group_name, form.model_dump(), dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{group_name}", response_model=WriteResult)
def delete_group(
    group_name: str,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = url_service.delete_group(db, user, instance, group_name, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
