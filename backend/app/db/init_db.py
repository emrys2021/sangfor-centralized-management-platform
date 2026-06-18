#! /usr/bin/env python3
# coding=utf-8
"""数据库初始化。

本期使用 ``Base.metadata.create_all`` 直接建表，方便快速启动；
表结构稳定后再切换到 Alembic 迁移管理（alembic/ 目录已预留）。
"""

from __future__ import annotations

from sqlalchemy import text

from app.db import models  # noqa: F401  确保模型被注册到 metadata
from app.db.base import Base, engine

# 审计检索相关索引：create_all 只为「新表」建索引，已存在的库需用 IF NOT EXISTS 幂等补建。
# 过滤/排序列用 B 树索引；message/before/after 等子串检索（LIKE '%x%'）用不上 B 树索引，
# 数据量很大时应改用全文索引（FTS5），当前审计量级直接扫描即可。
_AUDIT_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_actor ON audit_logs(actor)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_object_type ON audit_logs(object_type)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON audit_logs(action)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_instance_id ON audit_logs(instance_id)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs(created_at)",
)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    # 为已存在的库补建索引（新库已由 create_all 建好，IF NOT EXISTS 保证幂等）
    with engine.begin() as conn:
        for ddl in _AUDIT_INDEXES:
            conn.execute(text(ddl))


if __name__ == "__main__":
    init_db()
    print("数据库已初始化")
