#! /usr/bin/env python3
# coding=utf-8
"""数据校验分析结果的服务端 TTL 缓存。

``analyze_overlaps`` 需逐条访问设备（每个自定义应用 / 策略 / URL 库各一次 listItem），
开销大且结果短时间内稳定。这里按实例缓存一段时间（TTL）：

- 窗口内重复请求（同一实例、不同用户 / 刷新）直接返回上次结果，不再访问设备；
- 过期后下一次请求重新计算并刷新缓存；
- 写操作（新增/编辑/删除自定义应用、编辑策略）后主动失效对应实例的缓存；
- 「重新分析」可 ``force=True`` 绕过缓存强制重算。

并发安全：读走无锁快路径（CPython 下 dict 读写原子）；同一 key 的重算用 per-key 锁做
single-flight——多个请求同时未命中时只算一次，其余等待后复用结果，避免同时猛拉设备。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from app.config import settings


class TTLCache:
    """带存活时间与 single-flight 的简单内存缓存。"""

    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = float(ttl_seconds)
        self._store: dict[Any, tuple[float, Any]] = {}
        self._meta_lock = threading.Lock()
        self._key_locks: dict[Any, threading.Lock] = {}

    def _key_lock(self, key: Any) -> threading.Lock:
        with self._meta_lock:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._key_locks[key] = lock
            return lock

    def _fresh(self, key: Any) -> tuple[Any, float] | None:
        """命中且未过期则返回 (值, 已缓存秒数)，否则 None。"""
        item = self._store.get(key)
        if not item:
            return None
        ts, value = item
        age = time.monotonic() - ts
        if self._ttl <= 0 or age > self._ttl:
            return None
        return value, age

    def get_or_compute(
        self, key: Any, compute: Callable[[], Any], *, force: bool = False
    ) -> tuple[Any, bool, int]:
        """返回 (值, 是否来自缓存, 已缓存秒数)。

        :param force: True 时忽略现有缓存、强制重算并刷新。
        """
        if not force:
            hit = self._fresh(key)
            if hit is not None:
                value, age = hit
                return value, True, int(age)
        with self._key_lock(key):
            # 取到锁后再查一次：可能已有并发请求刚算好（single-flight）
            if not force:
                hit = self._fresh(key)
                if hit is not None:
                    value, age = hit
                    return value, True, int(age)
            value = compute()
            self._store[key] = (time.monotonic(), value)
            return value, False, 0

    def invalidate(self, key: Any) -> None:
        """使某 key 的缓存立即失效（下次请求将重算）。"""
        with self._meta_lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        with self._meta_lock:
            self._store.clear()


# 分析缓存单例：按实例 id 缓存 analyze_overlaps 结果。
analysis_cache = TTLCache(settings.analysis_cache_ttl)
# 全局搜索索引缓存：按实例 id 缓存「应用 IP/域名 + URL 库条目」索引（构建同样需逐条访问设备）。
search_cache = TTLCache(settings.analysis_cache_ttl)


def invalidate_instance(instance_id: int | None) -> None:
    """写操作后使该实例的分析缓存与搜索索引缓存失效。``instance_id`` 为空时忽略。"""
    if instance_id is not None:
        analysis_cache.invalidate(instance_id)
        search_cache.invalidate(instance_id)
