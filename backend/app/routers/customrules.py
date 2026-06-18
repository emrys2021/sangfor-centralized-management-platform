#! /usr/bin/env python3
# coding=utf-8
"""功能 1：自定义应用 / 规则路由。"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, get_current_user
from app.db.base import get_db
from app.db.models import Instance
from app.routers.deps import get_instance_dep
from app.sangfor.web_client import SangforWebError
from app.schemas.analysis import CustomRuleAnalysis
from app.schemas.common import WriteResult
from app.services import customrule_service

router = APIRouter(prefix="/api/instances/{instance_id}/customrules", tags=["customrules"])


@router.get("")
def list_rules(instance: Instance = Depends(get_instance_dep)):
    try:
        return customrule_service.list_rules(instance)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/analysis", response_model=CustomRuleAnalysis)
def analyze(refresh: bool = False, instance: Instance = Depends(get_instance_dep)):
    """统计 IP / 域名跨自定义应用的重叠（含方向/协议/端口），供数据校验可视化。

    结果带服务端 TTL 缓存：窗口内重复请求直接返回上次结果、不访问设备。
    ``refresh=true``（前端「重新分析」）强制重算并刷新缓存。
    """
    try:
        return customrule_service.analyze_overlaps(instance, force=refresh)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{rule_name}")
def get_rule(rule_name: str, instance: Instance = Depends(get_instance_dep)):
    try:
        return customrule_service.get_rule(instance, rule_name)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("", response_model=WriteResult)
def create_rule(
    payload: dict = Body(...),
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = customrule_service.create_rule(db, user, instance, payload, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{rule_name}", response_model=WriteResult)
def update_rule(
    rule_name: str,
    payload: dict = Body(...),
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = customrule_service.update_rule(db, user, instance, rule_name, payload, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{rule_name}", response_model=WriteResult)
def delete_rule(
    rule_name: str,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = customrule_service.delete_rule(db, user, instance, rule_name, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
