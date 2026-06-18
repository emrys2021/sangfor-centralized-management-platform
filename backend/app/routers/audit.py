#! /usr/bin/env python3
# coding=utf-8
"""审计日志查询路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.db.models import AuditLog
from app.schemas.common import AuditLogOut, PageResult

router = APIRouter(prefix="/api/audit-logs", tags=["audit"])


@router.get("", response_model=PageResult)
def list_audit_logs(
    instance_id: int | None = None,
    object_type: str | None = None,
    action: str | None = None,
    actor: str | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
):
    stmt = select(AuditLog)
    if instance_id is not None:
        stmt = stmt.where(AuditLog.instance_id == instance_id)
    if object_type:
        stmt = stmt.where(AuditLog.object_type == object_type)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if actor:
        stmt = stmt.where(AuditLog.actor == actor)
    # 自由文本检索：跨摘要 / 对象 / 操作人 / 实例 / 变更前后快照做子串匹配（覆盖 URL/IP/域名等内容）
    if search and search.strip():
        like = f"%{search.strip()}%"
        stmt = stmt.where(
            AuditLog.message.ilike(like)
            | AuditLog.object_name.ilike(like)
            | AuditLog.actor.ilike(like)
            | AuditLog.instance_name.ilike(like)
            | AuditLog.before.ilike(like)
            | AuditLog.after.ilike(like)
        )

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(AuditLog.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return PageResult(total=total, items=[AuditLogOut.model_validate(r) for r in rows])
