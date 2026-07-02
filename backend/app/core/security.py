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


class CredentialDecryptError(RuntimeError):
    """加密凭据解密失败：主密钥与加密时不一致，或密文已损坏。

    区别于「未配置凭据」（空值，:func:`decrypt` 直接返回空串）——本异常意味着库里
    确实存了密文，但当前 ``SANGFOR_SECRET_KEY``／``data/secret.key`` 解不开它（常见于
    密钥文件丢失、迁移数据库时漏带密钥、或误换了主密钥）。调用方不应把这种情况当作
    「凭据为空」静默处理，否则会误导为「用户名/密码错误」。
    """


@lru_cache
def _fernet() -> Fernet:
    return Fernet(settings.resolve_secret_key().encode("utf-8"))


def encrypt(plain: str | None) -> str:
    """加密明文，返回可存库的字符串。空值返回空串。"""
    if not plain:
        return ""
    return _fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt(token: str | None) -> str:
    """解密存库密文，返回明文。

    空值返回空串（未配置凭据）。非空密文解密失败时抛出 :class:`CredentialDecryptError`，
    调用方应捕获后转换为对用户明确的错误提示，而不是当作空凭据继续走「未配置/密码错误」流程。
    """
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise CredentialDecryptError(
            "凭据解密失败：加密主密钥（SANGFOR_SECRET_KEY / data/secret.key）与加密时不一致，或密文已损坏"
        ) from exc
