#! /usr/bin/env python3
# coding=utf-8
"""SQLAlchemy 引擎、会话与声明式基类。"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

# SQLite 需要 check_same_thread=False 以配合 FastAPI 的多线程
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    """所有 ORM 模型的声明式基类。"""


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：提供一个请求级数据库会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
