#! /usr/bin/env python3
# coding=utf-8
"""ORM 模型定义。

包含三类：

1. :class:`Instance`  —— 受管的深信服 AC 实例及其（加密）凭据。
2. :class:`AuditLog`  —— 所有写/同步操作的审计日志。
3. RBAC 预留：:class:`User` / :class:`Role` / :class:`Permission` 及关联表。
   本期不实现登录与鉴权，仅建表占位，使未来接入时无需改动业务路由。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Instance(Base):
    """一个受管的深信服 AC 实例。

    Web 密码与 API 共享密钥以密文存储（见 :mod:`app.core.security`）。
    """

    __tablename__ = "instances"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(255), default="")

    protocol: Mapped[str] = mapped_column(String(8), default="https")
    host: Mapped[str] = mapped_column(String(128))
    web_port: Mapped[int] = mapped_column(Integer, default=443)
    api_port: Mapped[int] = mapped_column(Integer, default=9999)

    web_user: Mapped[str] = mapped_column(String(128), default="")
    web_password_enc: Mapped[str] = mapped_column(Text, default="")
    api_key_enc: Mapped[str] = mapped_column(Text, default="")

    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class AuditLog(Base):
    """写/同步操作审计记录。

    ``before`` / ``after`` 保存变更前后的 JSON 文本快照，便于追溯与回滚参考。
    """

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)

    actor: Mapped[str] = mapped_column(String(128), default="admin", index=True)
    instance_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    instance_name: Mapped[str] = mapped_column(String(128), default="")

    # 对象类型：customrule / url / policy / instance / sync
    object_type: Mapped[str] = mapped_column(String(32), index=True)
    object_name: Mapped[str] = mapped_column(String(255), default="")
    # 动作：create / update / delete / sync / dry_run
    action: Mapped[str] = mapped_column(String(32), index=True)

    success: Mapped[bool] = mapped_column(Boolean, default=True)
    message: Mapped[str] = mapped_column(Text, default="")

    before: Mapped[str] = mapped_column(Text, default="")
    after: Mapped[str] = mapped_column(Text, default="")


# --------------------------------------------------------------------------- #
# RBAC 预留（本期仅建表占位，不接入鉴权）
# --------------------------------------------------------------------------- #

user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", ForeignKey("users.id"), primary_key=True),
    Column("role_id", ForeignKey("roles.id"), primary_key=True),
)

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", ForeignKey("roles.id"), primary_key=True),
    Column("permission_id", ForeignKey("permissions.id"), primary_key=True),
)


class User(Base):
    """系统用户（预留）。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    roles: Mapped[list["Role"]] = relationship(secondary=user_roles, back_populates="users")


class Role(Base):
    """角色（预留）。"""

    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(255), default="")

    users: Mapped[list["User"]] = relationship(secondary=user_roles, back_populates="roles")
    permissions: Mapped[list["Permission"]] = relationship(secondary=role_permissions, back_populates="roles")


class Permission(Base):
    """权限点（预留），如 ``customrule:write``、``sync:execute``。"""

    __tablename__ = "permissions"
    __table_args__ = (UniqueConstraint("code", name="uq_permission_code"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), index=True)
    description: Mapped[str] = mapped_column(String(255), default="")

    roles: Mapped[list["Role"]] = relationship(secondary=role_permissions, back_populates="permissions")
