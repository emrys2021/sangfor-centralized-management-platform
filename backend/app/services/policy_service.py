#! /usr/bin/env python3
# coding=utf-8
"""功能 3：访问权限策略（netpolicy）服务。"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import CurrentUser
from app.db.models import Instance
from app.sangfor import session_pool
from app.services import analysis_cache, policy_template


def list_policies(instance: Instance) -> dict:
    return session_pool.get_web_client(instance).list_policies()


def get_policy(instance: Instance, policy_name: str) -> dict:
    return session_pool.get_web_client(instance).get_policy_detail(policy_name)


def list_app_tree(instance: Instance) -> dict:
    """返回「选择适用应用」应用目录树（规则编辑时挑选应用/URL 的权威来源）。"""
    return session_pool.get_web_client(instance).list_app_tree()


def _audit(db, user, instance, action, name, result, before=None, message: str = ""):
    if result.get("dry_run"):
        message = f"[预览] {message}" if message else "dry_run"
    audit.record(
        db,
        actor=user.username,
        object_type="policy",
        action=action,
        object_name=name,
        instance_id=instance.id,
        instance_name=instance.name,
        message=message,
        before=before,
        after=result.get("payload") or result.get("result"),
    )


def _ref_paths(refs) -> list[str]:
    """从规则的引用列表里取出可读的应用/网址 path。"""
    out: list[str] = []
    for r in refs or []:
        if isinstance(r, dict):
            path = str(r.get("path") or "").strip()
            if path:
                out.append(path)
    return out


def _fmt_rule(action_bool: bool, paths: list[str]) -> str:
    return f"{'允许' if action_bool else '拒绝'} → {'、'.join(paths) if paths else '（空）'}"


def _rule_snapshot(name, action_bool: bool, paths: list[str]) -> dict:
    return {"规则ID": str(name), "动作": "允许" if action_bool else "拒绝", "应用/网址": paths}


def _summarize_policy_edit(
    before: dict | None, rules: list[dict], *, enable, depict, include
) -> tuple[str, dict, dict]:
    """对比编辑前后，产出可读的变更摘要 ``message`` 与精简的 before/after 快照。

    规则按设备规则 ID（``rule_id`` / ``name``）匹配：提交里有、原策略没有的算「新增」，
    动作或引用变了算「修改」，原策略有、提交里没有的算「删除」；并附启用/描述/应用控制的变更。
    """
    before = before or {}
    before_rules = before.get("rules", []) or []
    before_by_id = {str(r.get("rule_id") or r.get("name")): r for r in before_rules}
    after_names = {str(r.get("name")) for r in rules}

    segs: list[str] = []
    for sr in rules:
        nm = str(sr.get("name"))
        action_bool = bool(sr.get("action"))
        paths = _ref_paths(sr.get("refs"))
        br = before_by_id.get(nm)
        if br is None:
            segs.append("新增规则：" + _fmt_rule(action_bool, paths))
        elif bool(br.get("action_bool")) != action_bool or sorted(_ref_paths(br.get("refs"))) != sorted(paths):
            segs.append("修改规则：" + _fmt_rule(action_bool, paths))
    for nm, br in before_by_id.items():
        if nm not in after_names:
            segs.append("删除规则：" + _fmt_rule(bool(br.get("action_bool")), _ref_paths(br.get("refs"))))

    b_enable = before.get("enable")
    if enable is not None and b_enable is not None and bool(enable) != bool(b_enable):
        segs.append(f"{'启用' if enable else '停用'}该策略")
    b_depict = before.get("depict")
    if depict is not None and b_depict is not None and str(depict) != str(b_depict):
        segs.append("修改描述")
    b_include = before.get("application_include")
    if include is not None and b_include is not None and bool(include) != bool(b_include):
        segs.append(f"{'启用' if include else '关闭'}应用控制")

    message = "；".join(segs) if segs else "无明显变化"

    before_snap = {
        "启用": before.get("enable"),
        "描述": before.get("depict"),
        "应用控制": before.get("application_include"),
        "规则": [
            _rule_snapshot(r.get("rule_id") or r.get("name"), bool(r.get("action_bool")), _ref_paths(r.get("refs")))
            for r in before_rules
        ],
    }
    after_snap = {
        "启用": enable if enable is not None else before.get("enable"),
        "描述": depict if depict is not None else before.get("depict"),
        "应用控制": include if include is not None else before.get("application_include"),
        "规则": [_rule_snapshot(sr.get("name"), bool(sr.get("action")), _ref_paths(sr.get("refs"))) for sr in rules],
    }
    return message, before_snap, after_snap


def create_policy(db: Session, user: CurrentUser, instance: Instance, form: dict, dry_run: bool):
    """新建访问权限策略：据默认骨架 + 表单字段构造完整 data 后以 opr=add 提交。"""
    web = session_pool.get_web_client(instance)
    data = policy_template.build_policy_create_data(form)
    result = web.create_policy(data, dry_run=dry_run)
    _audit(
        db, user, instance, "dry_run" if dry_run else "create", form.get("name", ""), result,
        message=f"新建策略，{len(form.get('rules') or [])} 条规则",
    )
    if not dry_run:
        analysis_cache.invalidate_instance(instance.id)
    return result


def delete_policy(db: Session, user: CurrentUser, instance: Instance, policy_name: str, dry_run: bool):
    web = session_pool.get_web_client(instance)
    # 真实删除前留完整详情快照进审计 before（尽力而为），误删后可按快照内容重建；预览不读
    before = None
    if not dry_run:
        try:
            before = web.get_policy_detail(policy_name)
        except Exception:  # noqa: BLE001  快照读不到不阻断删除本身
            pass
    result = web.delete_policy(policy_name, dry_run=dry_run)
    _audit(db, user, instance, "dry_run" if dry_run else "delete", policy_name, result, before, message="删除策略")
    if not dry_run:
        # 与 create/update 及自定义应用/URL 删除一致：真实删除后失效该实例的分析/对比/搜索/引用缓存，
        # 否则桑基图、全量对比、全局搜索会残留已删策略（最多留一个 TTL）。
        analysis_cache.invalidate_instance(instance.id)
    return result


def move_policy(db: Session, user: CurrentUser, instance: Instance, policy_name: str, direction: str, dry_run: bool):
    """上移 / 下移一条策略（调整顺序）。顺序变化不影响数据校验内容，无需失效分析缓存。"""
    web = session_pool.get_web_client(instance)
    result = web.move_policy(policy_name, direction, dry_run=dry_run)
    action = "dry_run" if dry_run else f"move_{direction}"
    _audit(db, user, instance, action, policy_name, result, message="上移策略" if direction == "up" else "下移策略")
    return result


def set_policies_status(
    db: Session, user: CurrentUser, instance: Instance, names: list[str], enabled: bool, dry_run: bool
):
    """批量启用 / 禁用策略。"""
    web = session_pool.get_web_client(instance)
    result = web.set_policies_status(names, enabled=enabled, dry_run=dry_run)
    action = "dry_run" if dry_run else ("enable" if enabled else "disable")
    _audit(
        db, user, instance, action, ",".join(names), result,
        message=f"{'启用' if enabled else '禁用'} {len(names)} 条策略",
    )
    if not dry_run:
        # 启停状态已纳入策略对比核心字段（enable）与引用校验结果（status），真实写入后需失效缓存
        analysis_cache.invalidate_instance(instance.id)
    return result


def update_policy_application(
    db: Session,
    user: CurrentUser,
    instance: Instance,
    policy_name: str,
    rules: list[dict],
    include: bool | None,
    dry_run: bool,
    enable: bool | None = None,
    depict: str | None = None,
):
    """编辑策略：动作/引用增删，以及启用/描述，以 opr=modify 往返提交。"""
    web = session_pool.get_web_client(instance)
    before = None
    try:
        before = web.get_policy_detail(policy_name)
    except Exception:  # noqa: BLE001
        pass
    result = web.modify_policy_application(
        policy_name, rules, application_include=include, enable=enable, depict=depict, dry_run=dry_run
    )
    # 用可读摘要 + 精简前后快照落审计（而非整条 modify 报文），便于一眼看清改了什么
    message, before_snap, after_snap = _summarize_policy_edit(
        before, rules, enable=enable, depict=depict, include=include
    )
    audit.record(
        db,
        actor=user.username,
        object_type="policy",
        action="dry_run" if dry_run else "update",
        object_name=policy_name,
        instance_id=instance.id,
        instance_name=instance.name,
        message=f"[预览] {message}" if dry_run else message,
        before=before_snap,
        after=after_snap,
    )
    if not dry_run:
        # 策略引用变化会影响数据校验的「策略→应用/URL」关系，失效该实例分析缓存
        analysis_cache.invalidate_instance(instance.id)
    return result
