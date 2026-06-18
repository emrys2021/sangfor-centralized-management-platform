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
from app.core.security import decrypt
from app.db.models import Instance
from app.sangfor.api_client import SangforApiClient
from app.sangfor.web_client import SangforWebClient

_lock = threading.Lock()
_web_clients: dict[int, SangforWebClient] = {}


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
                password=decrypt(instance.web_password_enc),
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
        key=decrypt(instance.api_key_enc),
        timeout=settings.request_timeout,
    )


def drop(instance_id: int) -> None:
    """丢弃指定实例的缓存会话（凭据变更或会话失效时调用）。"""
    with _lock:
        _web_clients.pop(instance_id, None)
