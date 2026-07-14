# 后端 — 深信服 AC 统一管理系统

FastAPI + SQLAlchemy 后端。接口层复用并改造自已验证的深信服 Web/CGI 与官方 API 客户端实现。

## 运行

```bash
uv sync
cp .env.example .env
uv run uvicorn app.main:app --reload --port 8000
uv run pytest          # 离线单元测试
uv run ruff check app  # 代码检查
```

## 结构

```
app/
  main.py            FastAPI 入口、路由注册
  config.py          配置（环境变量 / .env）、加密主密钥解析
  db/                ORM（Instance / AuditLog / RBAC 占位）、引擎与会话
  core/
    security.py      凭据 Fernet 加密/解密
    auth.py          get_current_user 依赖（预留 RBAC）
    audit.py         审计写入
  sangfor/
    web_client.py    Web/CGI 客户端（功能 1-3 读 + 写占位，含 dry-run 安全闸）
    api_client.py    官方 API 客户端
    session_pool.py  按实例缓存已登录会话
  services/          customrule / url / policy / sync / compare / merge / instance 业务逻辑
  routers/           各功能 REST 路由
```

## 关键设计

- **凭据加密**：实例的 Web 密码 / API 密钥经 `core/security.py` 的 Fernet 加密后存库，响应中只暴露 `has_web_password` / `has_api_key` 布尔位，不回显明文。
- **会话池**：`sangfor/session_pool.py` 按 `instance_id` 缓存已登录的 `SangforWebClient`，避免每次请求都重复 RSA + CSRF 握手；凭据变更时丢弃缓存。
- **写操作安全闸**：`web_client._write_cgi` 在 `dry_run=True`（默认）时只返回报文预览；`dry_run=False` 时仅放行已登记到 `CONFIRMED_WRITES` 的 `(cgi_path, opr)`，其余拦截，防止未抓包确认前误写设备。
- **审计**：所有写 / 同步动作经 `core/audit.py` 落 `AuditLog` 表，含变更前后 JSON 快照。
- **RBAC 预留**：`db/models.py` 含 `User/Role/Permission` 表，`core/auth.py` 暴露 `get_current_user` 依赖，未来替换实现即可接入鉴权。

## 主要接口

- `GET/POST/PUT/DELETE /api/instances` — 实例 CRUD；`POST /api/instances/{id}/test` 连通性测试。
- `/api/instances/{id}/customrules` — 功能 1（list/detail/写）。
- `/api/instances/{id}/urls` — 功能 2。
- `/api/instances/{id}/policies` — 功能 3。
- `POST /api/sync/diff`、`POST /api/sync/apply`、`POST /api/sync/batch`、`POST /api/sync/compare` — 功能 5（对比 / 同步）。
- `POST /api/sync/merge` — 自定义应用 / URL 库跨实例「合并（并集）」，写回所有参与实例（见 `services/merge_service.py`）。
- `GET /api/audit-logs` — 审计查询。
