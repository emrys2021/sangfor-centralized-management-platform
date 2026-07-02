#! /usr/bin/env python3
# coding=utf-8
"""功能 2：自定义 URL 库（objurlgrp）服务。

读：分类树（list）、库内明细（listItem，含 url/keyword/depict，供查看与编辑回填）。
写：新增/编辑接收表单字段，组装为设备 ``{id,name,depict,url,keyword}`` 报文。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import CurrentUser
from app.db.models import Instance
from app.sangfor import session_pool
from app.services.analysis_cache import invalidate_instance


def list_groups(instance: Instance) -> dict:
    return session_pool.get_web_client(instance).list_url_groups()


def get_group_content(instance: Instance, group_name: str) -> dict:
    """返回某 URL 库的可查看 / 可编辑详情（库内明细 + 描述 + 关键字）。"""
    web = session_pool.get_web_client(instance)
    detail = web.get_url_group_detail(group_name)
    return {
        "name": detail.get("name", group_name),
        "urls": detail.get("url", []),
        "url_text": detail.get("url_text", ""),
        "depict": detail.get("depict", ""),
        "keyword": detail.get("keyword", ""),
    }


def _device_data(name: str, form: dict) -> dict:
    """表单字段 → 设备 ``data``。``id`` 留空：设备按库名匹配（与真实抓包一致）。"""
    return {
        "id": "",
        "name": name,
        "depict": form.get("depict", "") or "",
        "url": form.get("url", "") or "",
        "keyword": form.get("keyword", "") or "",
    }


def _url_lines(text: str) -> list[str]:
    return [s.strip() for s in str(text or "").replace("\r\n", "\n").split("\n") if s.strip()]


def _url_message(verb: str, name: str, form: dict) -> str:
    """构造带内容的审计摘要，便于直观查看与按 URL/IP/关键字检索。

    含全部条目（前若干条直接列出、其余以「等 N 条」收尾，完整内容仍可经 after 快照检索）。
    """
    entries = _url_lines(form.get("url", ""))
    keyword = str(form.get("keyword") or "").strip()
    parts = [f"{verb} URL 库「{name}」"]
    if entries:
        shown = "、".join(entries[:8])
        more = f" 等{len(entries)}条" if len(entries) > 8 else ""
        parts.append(f"（{len(entries)} 条 URL/IP）：{shown}{more}")
    if keyword:
        parts.append(f"；关键字：{keyword}")
    return "".join(parts)


def _audit(db, user, instance, action, name, result, before=None, message: str = ""):
    if result.get("dry_run"):
        message = f"[预览] {message}" if message else "dry_run"
    audit.record(
        db,
        actor=user.username,
        object_type="url",
        action=action,
        object_name=name,
        instance_id=instance.id,
        instance_name=instance.name,
        message=message,
        before=before,
        after=result.get("payload") or result.get("result"),
    )


def create_group(db: Session, user: CurrentUser, instance: Instance, form: dict, dry_run: bool):
    web = session_pool.get_web_client(instance)
    name = form.get("name", "")
    result = web.create_url_group(_device_data(name, form), dry_run=dry_run)
    _audit(
        db, user, instance, "dry_run" if dry_run else "create", name, result,
        message=_url_message("新增", name, form),
    )
    if not dry_run:
        invalidate_instance(instance.id)
    return result


def update_group(db: Session, user: CurrentUser, instance: Instance, group_name: str, form: dict, dry_run: bool):
    web = session_pool.get_web_client(instance)
    before = None
    try:
        before = web.get_url_group_detail(group_name)
    except Exception:  # noqa: BLE001
        pass
    # 编辑按库名匹配，name 固定为原库名（不支持改名）
    result = web.update_url_group(_device_data(group_name, form), dry_run=dry_run)
    _audit(
        db, user, instance, "dry_run" if dry_run else "update", group_name, result, before,
        message=_url_message("编辑", group_name, form),
    )
    if not dry_run:
        invalidate_instance(instance.id)
    return result


def delete_group(db: Session, user: CurrentUser, instance: Instance, group_name: str, dry_run: bool):
    web = session_pool.get_web_client(instance)
    # 真实删除前留完整内容快照进审计 before（尽力而为），误删后可按快照内容重建；预览不读
    before = None
    if not dry_run:
        try:
            before = web.get_url_group_detail(group_name)
        except Exception:  # noqa: BLE001  快照读不到不阻断删除本身
            pass
    result = web.delete_url_group(group_name, dry_run=dry_run)
    _audit(
        db, user, instance, "dry_run" if dry_run else "delete", group_name, result, before,
        message=f"删除 URL 库「{group_name}」",
    )
    if not dry_run:
        invalidate_instance(instance.id)
    return result
