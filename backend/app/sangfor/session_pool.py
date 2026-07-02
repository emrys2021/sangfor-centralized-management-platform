#! /usr/bin/env python3
# coding=utf-8
"""按实例缓存已登录的 Web 客户端会话。

Web/CGI 登录涉及 RSA + 多步 CSRF 握手，开销较大，因此按 ``instance_id`` 缓存
:class:`SangforWebClient`。若调用过程中会话失效（登录态过期），调用方可通过
:func:`drop` 丢弃缓存后重建。线程安全由简单互斥锁保证。
"""

from __future__ import annotations

import threading

from app.config import settings
from app.core.security import CredentialDecryptError, decrypt
from app.db.models import Instance
from app.sangfor.api_client import SangforApiClient
from app.sangfor.web_client import SangforWebClient, SangforWebError

_lock = threading.Lock()
_web_clients: dict[int, SangforWebClient] = {}


def _decrypt_or_raise(token: str | None, *, field: str) -> str:
    """解密凭据；主密钥不匹配/密文损坏时转为 :class:`SangforWebError`（路由层统一处理）。"""
    try:
        return decrypt(token)
    except CredentialDecryptError as exc:
        raise SangforWebError(f"{field}{exc}") from exc


def get_web_client(instance: Instance) -> SangforWebClient:
    """获取（或惰性创建并登录）指定实例的 Web 客户端。"""
    with _lock:
        client = _web_clients.get(instance.id)
        if client is None:
            client = SangforWebClient(
                protocol=instance.protocol,
                host=instance.host,
                port=instance.web_port,
                user_name=instance.web_user,
                password=_decrypt_or_raise(instance.web_password_enc, field="Web 密码："),
                timeout=settings.request_timeout,
                verify=settings.tls_verify,
            )
            _web_clients[instance.id] = client
    client.login()
    return client


def get_api_client(instance: Instance) -> SangforApiClient:
    """获取指定实例的官方 API 客户端（无状态，不缓存）。"""
    return SangforApiClient(
        host=instance.host,
        port=instance.api_port,
        key=_decrypt_or_raise(instance.api_key_enc, field="API 密钥："),
        timeout=settings.request_timeout,
    )


def drop(instance_id: int) -> None:
    """丢弃指定实例的缓存会话（凭据变更或会话失效时调用）。"""
    with _lock:
        _web_clients.pop(instance_id, None)
