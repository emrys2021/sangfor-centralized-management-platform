#! /usr/bin/env python3
# coding=utf-8
"""功能 3：访问权限策略路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, get_current_user
from app.db.base import get_db
from app.db.models import Instance
from app.routers.deps import get_instance_dep
from app.sangfor.web_client import SangforWebError
from app.schemas.common import WriteResult
from app.schemas.policy import PolicyApplicationUpdate, PolicyCreate, PolicyStatusUpdate
from app.services import policy_service

router = APIRouter(prefix="/api/instances/{instance_id}/policies", tags=["policies"])


@router.get("")
def list_policies(instance: Instance = Depends(get_instance_dep)):
    try:
        return policy_service.list_policies(instance)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/app-tree")
def list_app_tree(instance: Instance = Depends(get_instance_dep)):
    """「选择适用应用」应用目录树（规则编辑时挑选应用/URL，含各节点 crc）。

    声明在 ``/{policy_name}`` 之前，避免 ``app-tree`` 被当作策略名匹配。
    """
    try:
        return policy_service.list_app_tree(instance)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/{policy_name}")
def get_policy(policy_name: str, instance: Instance = Depends(get_instance_dep)):
    try:
        return policy_service.get_policy(instance, policy_name)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("", response_model=WriteResult)
def create_policy(
    body: PolicyCreate,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """新建访问权限策略（``opr=add``）。适用用户需另行设置（暂未支持）。"""
    try:
        result = policy_service.create_policy(db, user, instance, body.model_dump(), dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{policy_name}/application", response_model=WriteResult)
def update_policy_application(
    policy_name: str,
    body: PolicyApplicationUpdate,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """编辑策略中各规则引用的应用 / URL（动作、引用增删）。

    采用「读—改—写」往返：后端取回完整策略对象，仅替换各规则的动作与引用列表后
    以 ``opr=modify`` 提交，其余配置原样保留。``dry_run`` 默认 True 仅返回报文预览。
    """
    try:
        result = policy_service.update_policy_application(
            db,
            user,
            instance,
            policy_name,
            [r.model_dump() for r in body.rules],
            body.include,
            dry_run,
            enable=body.enable,
            depict=body.depict,
        )
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/status", response_model=WriteResult)
def set_status(
    body: PolicyStatusUpdate,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """批量启用 / 禁用策略（``enabled=true`` 启用、``false`` 禁用）。"""
    try:
        result = policy_service.set_policies_status(db, user, instance, body.names, body.enabled, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{policy_name}/move", response_model=WriteResult)
def move_policy(
    policy_name: str,
    direction: str,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    """上移 / 下移一条策略（``direction=up|down``），调整其执行顺序。"""
    if direction not in ("up", "down"):
        raise HTTPException(status_code=400, detail="direction 必须为 up 或 down")
    try:
        result = policy_service.move_policy(db, user, instance, policy_name, direction, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{policy_name}", response_model=WriteResult)
def delete_policy(
    policy_name: str,
    dry_run: bool = True,
    instance: Instance = Depends(get_instance_dep),
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    try:
        result = policy_service.delete_policy(db, user, instance, policy_name, dry_run)
        return WriteResult(
            dry_run=result.get("dry_run", dry_run), payload=result.get("payload"), result=result.get("result")
        )
    except SangforWebError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
