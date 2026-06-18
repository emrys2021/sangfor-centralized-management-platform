#! /usr/bin/env python3
# coding=utf-8
"""审计日志写入工具。

业务服务在执行写/同步操作后调用 :func:`record` 落库。``before`` / ``after``
接受任意可 JSON 序列化对象，内部统一转为 JSON 文本快照。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import AuditLog


def _to_json(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def record(
    db: Session,
    *,
    actor: str,
    object_type: str,
    action: str,
    object_name: str = "",
    instance_id: int | None = None,
    instance_name: str = "",
    success: bool = True,
    message: str = "",
    before: Any = None,
    after: Any = None,
) -> AuditLog:
    """写入一条审计记录并提交。"""
    log = AuditLog(
        actor=actor,
        instance_id=instance_id,
        instance_name=instance_name,
        object_type=object_type,
        object_name=object_name,
        action=action,
        success=success,
        message=message,
        before=_to_json(before),
        after=_to_json(after),
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log
