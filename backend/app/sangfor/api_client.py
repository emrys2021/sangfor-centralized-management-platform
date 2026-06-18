#! /usr/bin/env python3
# coding=utf-8
"""深信服 AC 官方 API 客户端（端口 9999，共享密钥票据鉴权）。

由 ``hznmops`` 的 ``sangfor_api.py`` 改造而来，仅保留本系统当前需要的方法。
鉴权方式：每次请求带 ``random`` + ``md5(key + random)`` 票据。
"""

from __future__ import annotations

import hashlib
import random
import time

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class SangforApiError(RuntimeError):
    """官方 API 调用失败。"""


class SangforApiClient:
    """单个 AC 实例的官方 API 客户端。"""

    def __init__(self, host: str, port: int | str, key: str, timeout: int = 30, version: str = "v1"):
        self.host = host
        self.port = port
        self.key = key
        self.timeout = int(timeout)
        self.version = version

    def _ticket(self) -> dict:
        random_str = "".join(random.sample("012345678901234567890123456789", 30))
        md5_str = hashlib.md5(f"{self.key}{random_str}".encode("utf-8")).hexdigest()
        return {"random": random_str, "md5": md5_str}

    def _service(self) -> str:
        return f"http://{self.host}:{self.port}/{self.version}"

    def _send(self, path: str, params: dict | None = None, method: str = "GET", retry: int = 3) -> dict:
        time.sleep((4 / (retry + 1)) ** 2)
        params = dict(params or {})
        params.update(self._ticket())
        url = f"{self._service()}{path}"
        if method == "GET":
            r = requests.get(url, params=params, timeout=self.timeout)
        else:
            r = requests.post(url, json=params, headers={"Content-Type": "application/json"}, timeout=self.timeout)
        result = r.json()
        if result.get("code") == 0:
            return result
        if retry > 0 and result.get("message") == "系统繁忙,请稍后再试!":
            return self._send(path, params, method, retry - 1)
        return result

    def get_api_version(self) -> dict:
        return self._send("/status/version")

    def get_online_user_count(self) -> dict:
        return self._send("/status/online-user")

    def get_all_netpolicy(self) -> dict:
        return self._send("/policy/netpolicy")

    def test_connection(self) -> dict:
        """拉取版本号用于连通性测试。"""
        result = self.get_api_version()
        if result.get("code") != 0:
            raise SangforApiError(result.get("message", "API 连接失败"))
        return {"ok": True, "version": result.get("data")}
