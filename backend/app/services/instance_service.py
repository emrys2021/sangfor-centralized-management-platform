#! /usr/bin/env python3
# coding=utf-8
"""实例管理服务：实例 CRUD + 连通性测试。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import decrypt, encrypt
from app.db.models import Instance
from app.sangfor import session_pool
from app.sangfor.api_client import SangforApiClient
from app.schemas.instance import InstanceCreate, InstanceOut, InstanceUpdate


def _to_out(inst: Instance) -> InstanceOut:
    out = InstanceOut.model_validate(inst)
    out.has_web_password = bool(inst.web_password_enc)
    out.has_api_key = bool(inst.api_key_enc)
    return out


def list_instances(db: Session, *, only_enabled: bool = False) -> list[InstanceOut]:
    stmt = select(Instance).order_by(Instance.id)
    if only_enabled:
        stmt = stmt.where(Instance.enabled.is_(True))
    return [_to_out(i) for i in db.scalars(stmt).all()]


def get_instance(db: Session, instance_id: int) -> Instance | None:
    return db.get(Instance, instance_id)


def get_instance_out(db: Session, instance_id: int) -> InstanceOut | None:
    inst = get_instance(db, instance_id)
    return _to_out(inst) if inst else None


def create_instance(db: Session, data: InstanceCreate) -> InstanceOut:
    inst = Instance(
        name=data.name,
        description=data.description,
        protocol=data.protocol,
        host=data.host,
        web_port=data.web_port,
        api_port=data.api_port,
        web_user=data.web_user,
        web_password_enc=encrypt(data.web_password),
        api_key_enc=encrypt(data.api_key),
        enabled=data.enabled,
    )
    db.add(inst)
    db.commit()
    db.refresh(inst)
    return _to_out(inst)


def update_instance(db: Session, instance_id: int, data: InstanceUpdate) -> InstanceOut | None:
    inst = get_instance(db, instance_id)
    if not inst:
        return None

    fields = data.model_dump(exclude_unset=True)
    # 凭据仅在显式传入「非空值」时才更新；空字符串 / None 一律视为「保持不变」，
    # 避免编辑实例（只改描述/端口、密码框留空）时把已存凭据清空。
    new_web_password = fields.pop("web_password", None)
    if new_web_password:
        inst.web_password_enc = encrypt(new_web_password)
    new_api_key = fields.pop("api_key", None)
    if new_api_key:
        inst.api_key_enc = encrypt(new_api_key)
    for key, value in fields.items():
        setattr(inst, key, value)

    db.commit()
    db.refresh(inst)
    # 凭据可能变化，丢弃缓存会话
    session_pool.drop(instance_id)
    return _to_out(inst)


def delete_instance(db: Session, instance_id: int) -> bool:
    inst = get_instance(db, instance_id)
    if not inst:
        return False
    db.delete(inst)
    db.commit()
    session_pool.drop(instance_id)
    return True


def check_instance_health(db: Session, instance_id: int) -> dict:
    """轻量健康检查：复用会话池（惰性登录、不 drop），用于切换器状态指示。

    与 :func:`test_connection` 不同——后者会丢弃并重建会话（适合「手动测试」按钮），
    本函数复用已登录会话，便于前端按实例频繁查询而不反复登出重连。
    """
    inst = get_instance(db, instance_id)
    if not inst:
        return {"instance_id": instance_id, "status": "error", "message": "实例不存在"}
    if not inst.enabled:
        return {"instance_id": instance_id, "status": "disabled", "message": "已禁用"}
    if not inst.web_password_enc:
        return {"instance_id": instance_id, "status": "unconfigured", "message": "未配置 Web 密码"}
    try:
        web = session_pool.get_web_client(inst)  # 惰性登录或复用缓存会话；不 drop
        web.ping()  # 真实轻量探测：确实发一次请求，能发现缓存会话失效 / 设备不可达
        return {"instance_id": instance_id, "status": "ok", "message": ""}
    except Exception as exc:  # noqa: BLE001
        session_pool.drop(instance_id)  # 探测失败：丢弃可能已失效的会话，下次重建
        return {"instance_id": instance_id, "status": "error", "message": str(exc)}


def test_connection(db: Session, instance_id: int) -> dict:
    inst = get_instance(db, instance_id)
    if not inst:
        return {"web_ok": False, "api_ok": False, "message": "实例不存在"}

    result = {"web_ok": False, "api_ok": False, "detail": {}, "message": ""}
    messages = []

    # Web 通道
    try:
        session_pool.drop(instance_id)
        web = session_pool.get_web_client(inst)
        result["detail"]["web"] = web.test_connection()
        result["web_ok"] = True
    except Exception as exc:  # noqa: BLE001
        messages.append(f"Web: {exc}")

    # API 通道（仅当配置了 api_key 时测试）
    if inst.api_key_enc:
        try:
            api = SangforApiClient(host=inst.host, port=inst.api_port, key=decrypt(inst.api_key_enc))
            result["detail"]["api"] = api.test_connection()
            result["api_ok"] = True
        except Exception as exc:  # noqa: BLE001
            messages.append(f"API: {exc}")

    result["message"] = "; ".join(messages)
    return result
