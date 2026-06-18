#! /usr/bin/env python3
# coding=utf-8
"""鉴权依赖（预留 RBAC 接入点）。

本期不实现登录与权限校验：:func:`get_current_user` 始终返回一个固定的
默认管理员。所有业务路由都通过该依赖获取「当前操作人」，未来接入真实
认证时只需替换本函数实现（解析 token、查库、校验权限），业务路由签名不变。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    """当前操作人。预留 ``permissions`` 字段供未来权限校验使用。"""

    username: str
    display_name: str
    permissions: frozenset[str] = frozenset()

    def has(self, permission: str) -> bool:
        # 预留：本期默认放行
        return True


_DEFAULT_USER = CurrentUser(username="admin", display_name="系统管理员")


def get_current_user() -> CurrentUser:
    """FastAPI 依赖：返回当前操作人（本期固定为默认管理员）。"""
    return _DEFAULT_USER
