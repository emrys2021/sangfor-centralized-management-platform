#! /usr/bin/env python3
# coding=utf-8
"""凭据加密工具。

实例的 Web 密码、API 共享密钥等敏感字段以 Fernet 对称加密后存库，
读取时解密。主密钥来自 :func:`app.config.Settings.resolve_secret_key`。
"""

from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


@lru_cache
def _fernet() -> Fernet:
    return Fernet(settings.resolve_secret_key().encode("utf-8"))


def encrypt(plain: str | None) -> str:
    """加密明文，返回可存库的字符串。空值返回空串。"""
    if not plain:
        return ""
    return _fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt(token: str | None) -> str:
    """解密存库密文，返回明文。空值或非法密文返回空串。"""
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""
