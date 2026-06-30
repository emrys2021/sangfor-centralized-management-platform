#! /usr/bin/env python3
# coding=utf-8
"""全局搜索路由：按域名 / IP 反查引用它的自定义应用与 URL 库。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.db.models import Instance
from app.routers.deps import get_instance_dep
from app.sangfor.web_client import SangforWebError
from app.schemas.search import SearchResult
from app.services import search_service

router = APIRouter(prefix="/api/instances/{instance_id}/search", tags=["search"])


@router.get("", response_model=SearchResult)
def global_search(q: str = "", refresh: bool = False, instance: Instance = Depends(get_instance_dep)):
    """在该实例内按域名 / IP 智能匹配自定义应用、自定义 / 内置 URL 库的配置条目。

    首次（或 ``refresh=true`` 重建）会逐条访问设备构建索引，耗时较长；之后命中 TTL 缓存秒回。
    """
    try:
        return search_service.search(instance, q, force=refresh)
    except SangforWebError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
