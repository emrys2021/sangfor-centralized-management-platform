#! /usr/bin/env python3
# coding=utf-8
"""FastAPI 应用入口。

注册 CORS、可选的 API Token 鉴权、初始化数据库、挂载各业务路由。启动：

    uvicorn app.main:app --reload

鉴权：当配置了 ``SANGFOR_API_TOKEN`` 时，所有 ``/api`` 接口（``/api/health`` 除外）
要求请求头 ``X-API-Token`` 或 ``Authorization: Bearer <token>`` 与之匹配；未配置时
不鉴权（仅限受信任内网开发环境，启动时打印告警）。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.db.init_db import init_db
from app.routers import audit, customrules, instances, policies, search, sync, urls

logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    if not settings.api_token:
        logger.warning(
            "未设置 SANGFOR_API_TOKEN：API 不鉴权，任何能访问到本服务的人都可读写 AC 配置。"
            "生产环境请设置该令牌，并在前端配置同值的 VITE_API_TOKEN。"
        )
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)


async def _api_token_guard(request: Request, call_next):
    """校验 API Token。配置了令牌时，对 /api（健康检查与 CORS 预检除外）强制校验。"""
    token = settings.api_token
    path = request.url.path
    if token and path.startswith("/api") and path != "/api/health" and request.method != "OPTIONS":
        provided = request.headers.get("x-api-token", "")
        if not provided:
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
        if provided != token:
            return JSONResponse(status_code=401, content={"detail": "未授权：缺少或无效的 API Token"})
    return await call_next(request)


# 注意中间件执行顺序：后注册者在外层。先注册鉴权（内层）、再注册 CORS（外层），
# 使 CORS 预检与 401 等错误响应都能正确附带 CORS 头。
app.add_middleware(BaseHTTPMiddleware, dispatch=_api_token_guard)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "app": settings.app_name}


app.include_router(instances.router)
app.include_router(customrules.router)
app.include_router(urls.router)
app.include_router(policies.router)
app.include_router(sync.router)
app.include_router(search.router)
app.include_router(audit.router)
