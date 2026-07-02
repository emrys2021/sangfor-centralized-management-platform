#! /usr/bin/env python3
# coding=utf-8
"""应用配置。

通过环境变量或 `.env` 文件读取配置：

- ``SANGFOR_SECRET_KEY``：凭据加密主密钥（Fernet key）。生产环境必须显式设置，
  未设置时会在数据目录生成并持久化一个密钥（仅供开发使用）。
- ``DATABASE_URL``：SQLAlchemy 数据库连接串，默认指向数据目录下的 SQLite 文件。
- ``CORS_ORIGINS``：允许的前端来源，逗号分隔。
- ``ANALYSIS_CACHE_TTL``：数据校验分析结果的服务端缓存存活秒数（默认 300，设 0 关闭）。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# 项目根（backend/）与数据目录
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    """全局配置对象。"""

    # 所有字段都用显式的 ``SANGFOR_`` 前缀别名读取环境变量，避免误读系统里的通用名
    # （如裸 ``DEBUG`` / ``DATABASE_URL``）造成污染或解析失败。
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        extra="ignore",
    )

    app_name: str = Field("深信服 AC 统一管理系统", validation_alias="SANGFOR_APP_NAME")
    # 生产默认关闭调试，避免外部环境变量打开
    debug: bool = Field(False, validation_alias="SANGFOR_DEBUG")

    # 数据库
    database_url: str = Field(
        f"sqlite:///{(DATA_DIR / 'sangfor.db').as_posix()}", validation_alias="SANGFOR_DATABASE_URL"
    )

    # 凭据加密主密钥（Fernet）。为空时回退到本地持久化密钥文件（仅开发）。
    sangfor_secret_key: str = Field("", validation_alias="SANGFOR_SECRET_KEY")

    # CORS 允许来源
    cors_origins: str = Field(
        "http://localhost:5173,http://127.0.0.1:5173", validation_alias="SANGFOR_CORS_ORIGINS"
    )

    # Sangfor 接口默认超时（秒）
    request_timeout: int = Field(30, validation_alias="SANGFOR_REQUEST_TIMEOUT")

    # 数据校验分析结果的服务端缓存存活时间（秒）。同一实例在此窗口内重复请求直接返回
    # 上次结果、不再逐条访问设备；设 0 可关闭缓存。可被「重新分析」强制刷新绕过。
    analysis_cache_ttl: int = Field(300, validation_alias="SANGFOR_ANALYSIS_CACHE_TTL")

    # 单次请求内并行拉取设备的线程数上限（各分析/对比/搜索的线程池大小）。
    fetch_concurrency: int = Field(8, validation_alias="SANGFOR_FETCH_CONCURRENCY")

    # 对**同一台 AC** 的**全局**并发上限（跨请求，见 web_base 的 per-origin 信号量）：无论同时
    # 有多少请求，对单台设备的在途 CGI 请求数不超过此值，避免高峰压垮设备。一般设为
    # fetch_concurrency 的 1~2 倍，让少量并发请求不至于共享太少通道、互相拖慢。
    global_fetch_concurrency: int = Field(16, validation_alias="SANGFOR_GLOBAL_FETCH_CONCURRENCY")

    # API 访问令牌：非空时所有 /api 路由要求请求头 ``X-API-Token`` 或 ``Authorization: Bearer``
    # 与之匹配；为空表示不鉴权（仅开发，启动时会告警）。
    api_token: str = Field("", validation_alias="SANGFOR_API_TOKEN")

    # 与 AC 通信的 TLS 校验：空 / "false" / "0" 表示不校验（默认，自签设备）；
    # "true" 表示用系统 CA 校验；其它取值视为自定义 CA 证书文件路径。
    verify_tls: str = Field("", validation_alias="SANGFOR_VERIFY_TLS")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def tls_verify(self) -> bool | str:
        """转换为 requests 的 ``verify`` 取值：False（不校验）/ True（系统 CA）/ CA 路径。"""
        v = self.verify_tls.strip()
        if not v or v.lower() in ("false", "0", "no", "off"):
            return False
        if v.lower() in ("true", "1", "yes", "on"):
            return True
        return v

    def resolve_secret_key(self) -> str:
        """返回有效的 Fernet 主密钥。

        优先使用环境变量；否则在数据目录生成并复用一个本地密钥（开发用途）。
        """
        if self.sangfor_secret_key:
            return self.sangfor_secret_key

        key_file = DATA_DIR / "secret.key"
        if key_file.exists():
            return key_file.read_text(encoding="utf-8").strip()

        # 延迟导入，避免循环依赖
        from cryptography.fernet import Fernet

        key = Fernet.generate_key().decode("utf-8")
        key_file.write_text(key, encoding="utf-8")
        os.chmod(key_file, 0o600) if os.name != "nt" else None
        return key


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
