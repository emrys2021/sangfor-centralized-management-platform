#! /usr/bin/env python3
# coding=utf-8
"""功能 5：跨实例策略同步服务。

提供两类能力：

- :func:`compute_diff` —— 拉取源实例对象快照与各目标实例快照，做字段级比较，
  返回差异，供前端「引导式同步」预览。
- :func:`apply_sync` —— 把源对象写到目标实例（复用写客户端，默认 dry-run）。
  支持「选定目标」与「一键推送到全部其他启用实例」两种入口。

写报文未抓包确认前，``apply_sync`` 实际以 dry-run 返回将提交的 payload；
确认后把 (cgi_path, opr) 登记到 :data:`app.sangfor.web_client.CONFIRMED_WRITES`
即可真正提交。

约束：
- **访问权限策略的跨实例同步**（见 :mod:`app.services.policy_sync`）：apply 时预读源完整
  策略，再据目标设备的应用树（``listAppTree``）按引用路径重映射各引用的 crc；目标缺失的
  **自定义**被引用对象（应用 / URL 库）会复用已确认写接口先建到目标，**内置**缺失则只在
  ``warnings`` 列出、无法自动创建（real-write 遇内置缺失会整体阻止、不写）。落盘走已验证路径：
  目标有同名策略 → ``modify_policy_application``（读目标底座、仅替换规则引用）；无 → ``create_policy``
  （``opr=add``）。适用用户不随报文跨实例，新建后需在目标手工配置。
- 读取目标快照区分 ``found`` / ``not_found`` / ``error``：读取/解析失败（``error``）不会被
  当作「对象不存在」，apply 阶段直接跳过该目标，避免把读失败误判为「需新增」而误写。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import CurrentUser
from app.sangfor import session_pool
from app.sangfor.web_base import SangforWebError
from app.sangfor.web_client import SangforWebClient
from app.schemas.sync import (
    FieldDiff,
    SyncApplyResult,
    SyncDiffResult,
    TargetApplyResult,
    TargetDiff,
)
from app.services import customrule_form, instance_service, policy_sync
from app.services.analysis_cache import invalidate_instance

# 设备「对象不存在」类报错的判别关键词：命中则视为 not_found（可新增），否则一律按
# read_error（读取失败，禁止据此误判为"将新增"并写入）。
_NOT_FOUND_HINTS = ("不存在", "未找到", "找不到", "无此", "no such", "not exist", "not found", "does not exist")


def _is_not_found(message: str) -> bool:
    msg = (message or "").lower()
    return any(h in msg for h in _NOT_FOUND_HINTS)


def _build_snapshot(web: SangforWebClient, object_type: str, name: str) -> tuple[str, dict, str]:
    """返回 ``(status, 快照, 错误信息)``，``status`` ∈ ``found`` / ``not_found`` / ``error``。

    - ``found``：成功读到对象，快照为规范化字段。
    - ``not_found``：设备明确返回「对象不存在」——允许在目标实例新增。
    - ``error``：读取/解析失败（连接、会话失效、字段异常等）——**不可**当作「不存在」，
      上层据此禁止 apply 并把错误透传给前端，避免把读失败误判为「将新增」。

    customrule 快照即完整表单字段（:func:`customrule_form.parse_form`），既用于差异
    对比，也可直接经 :func:`customrule_form.build_payload` 还原为写入报文。
    """
    try:
        if object_type == "customrule":
            detail = web.get_custom_rule_detail(name)
            return "found", customrule_form.parse_form(detail.get("summary", {}), detail.get("detail", {})), ""
        if object_type == "url":
            detail = web.get_url_group_detail(name)
            # 规范化为可对比、且可直接还原为写入报文的字段
            return "found", {
                "name": name,
                "depict": detail.get("depict", ""),
                "url": detail.get("url_text", ""),
                "keyword": detail.get("keyword", ""),
            }, ""
        if object_type == "policy":
            detail = web.get_policy_detail(name)
            rules = [
                {
                    "name": r["name"],
                    "apps": sorted(a["path"] for a in r["apps"]),
                    "urls": sorted(u["name"] for u in r["urls"]),
                }
                for r in detail.get("rules", [])
            ]
            return "found", {"policy_name": name, "rules": rules}, ""
        return "error", {}, f"未知对象类型: {object_type}"
    except SangforWebError as exc:
        msg = str(exc)
        return ("not_found" if _is_not_found(msg) else "error"), {}, ("" if _is_not_found(msg) else msg)
    except Exception as exc:  # noqa: BLE001
        return "error", {}, str(exc)


def _diff_snapshots(source: dict, target: dict) -> list[FieldDiff]:
    diffs: list[FieldDiff] = []
    for key in sorted(set(source) | set(target)):
        s_val = source.get(key)
        t_val = target.get(key)
        if s_val != t_val:
            diffs.append(FieldDiff(field=key, source=s_val, target=t_val))
    return diffs


def compute_diff(
    db: Session,
    object_type: str,
    object_name: str,
    source_instance_id: int,
    target_instance_ids: list[int],
) -> SyncDiffResult:
    source_inst = instance_service.get_instance(db, source_instance_id)
    if not source_inst:
        raise ValueError("源实例不存在")

    source_web = session_pool.get_web_client(source_inst)
    src_status, source_snapshot, src_err = _build_snapshot(source_web, object_type, object_name)
    if src_status == "error":
        raise ValueError(f"读取源对象失败：{src_err}")
    if src_status == "not_found":
        raise ValueError(f"源实例中不存在对象: {object_name}")

    targets: list[TargetDiff] = []
    for tid in target_instance_ids:
        target_inst = instance_service.get_instance(db, tid)
        if not target_inst:
            targets.append(
                TargetDiff(
                    instance_id=tid, instance_name=f"#{tid}", exists=False, changed=False, error="目标实例不存在"
                )
            )
            continue
        try:
            web = session_pool.get_web_client(target_inst)
            status, snapshot, err = _build_snapshot(web, object_type, object_name)
        except Exception as exc:  # noqa: BLE001  连接/登录失败
            targets.append(
                TargetDiff(instance_id=tid, instance_name=target_inst.name, exists=False, changed=False, error=str(exc))
            )
            continue
        if status == "error":
            # 读取失败：明确报错、不标记为「将新增」，避免误导用户后续 apply
            targets.append(
                TargetDiff(
                    instance_id=tid, instance_name=target_inst.name, exists=False, changed=False,
                    error=f"读取目标对象失败：{err}",
                )
            )
            continue
        exists = status == "found"
        diffs = _diff_snapshots(source_snapshot, snapshot) if exists else []
        targets.append(
            TargetDiff(
                instance_id=tid,
                instance_name=target_inst.name,
                exists=exists,
                changed=(not exists) or bool(diffs),
                diffs=diffs,
            )
        )

    return SyncDiffResult(
        object_type=object_type,
        object_name=object_name,
        source_instance_id=source_instance_id,
        source_snapshot=source_snapshot,
        targets=targets,
    )


def _write_to_target(
    web: SangforWebClient,
    object_type: str,
    payload: dict,
    exists: bool,
    dry_run: bool,
    *,
    source_web: SangforWebClient | None = None,
    source_policy_detail: dict | None = None,
    source_custom_apps: set[str] | None = None,
    source_custom_urls: set[str] | None = None,
) -> dict:
    """根据对象是否已存在选择 create / update。三类对象均支持真实写入。

    policy 据目标设备 crc 重映射引用、必要时自动把缺失的自定义引用对象先建到目标，再走
    已验证的 ``modify_policy_application``（改）/ ``create_policy``（增）。源相关入参
    （``source_web`` / 完整详情 / 自定义名单）由 :func:`apply_sync` 预读一次后传入。
    """
    if object_type == "customrule":
        data = customrule_form.build_payload(payload)
        return (
            web.update_custom_rule(data, dry_run=dry_run)
            if exists
            else web.create_custom_rule(data, dry_run=dry_run)
        )
    if object_type == "url":
        # 快照字段 → 设备 data（id 留空，目标按库名匹配/新建）
        data = {
            "id": "",
            "name": payload.get("name", ""),
            "depict": payload.get("depict", ""),
            "url": payload.get("url", ""),
            "keyword": payload.get("keyword", ""),
        }
        return (
            web.update_url_group(data, dry_run=dry_run) if exists else web.create_url_group(data, dry_run=dry_run)
        )
    if object_type == "policy":
        if not isinstance(source_policy_detail, dict) or source_web is None:
            raise SangforWebError("缺少源策略完整详情，无法同步策略")
        return policy_sync.sync_policy_to_target(
            source_web,
            web,
            source_policy_detail,
            exists=exists,
            dry_run=dry_run,
            source_custom_apps=source_custom_apps or set(),
            source_custom_urls=source_custom_urls or set(),
        )
    raise ValueError(f"未知对象类型: {object_type}")


def apply_sync(
    db: Session,
    user: CurrentUser,
    *,
    object_type: str,
    object_name: str,
    source_instance_id: int,
    target_instance_ids: list[int],
    push_all: bool,
    dry_run: bool,
) -> SyncApplyResult:
    source_inst = instance_service.get_instance(db, source_instance_id)
    if not source_inst:
        raise ValueError("源实例不存在")

    source_web = session_pool.get_web_client(source_inst)
    src_status, source_snapshot, src_err = _build_snapshot(source_web, object_type, object_name)
    if src_status == "error":
        raise ValueError(f"读取源对象失败：{src_err}")
    if src_status != "found":
        raise ValueError(f"源实例中不存在对象: {object_name}")

    # 策略：预读一次源完整详情（含 appctrl/raw）+ 源自定义应用 / URL 名单，供各目标重映射 crc
    # 与「缺失自定义引用自动创建」使用（避免每目标重复拉取，N 个目标也只读一次源）。
    source_policy_detail: dict | None = None
    source_custom_apps: set[str] = set()
    source_custom_urls: set[str] = set()
    if object_type == "policy":
        source_policy_detail = source_web.get_policy_detail(object_name)
        source_custom_apps = {s.get("rulename") for s in source_web.list_custom_rules() if s.get("rulename")}
        source_custom_urls = {
            n.get("name")
            for n in source_web.list_url_groups().get("flat", [])
            if n.get("name") and not n.get("inside")
        }

    # 解析目标实例集合
    if push_all:
        all_enabled = instance_service.list_instances(db, only_enabled=True)
        target_ids = [i.id for i in all_enabled if i.id != source_instance_id]
    else:
        target_ids = [tid for tid in target_instance_ids if tid != source_instance_id]

    results: list[TargetApplyResult] = []
    for tid in target_ids:
        target_inst = instance_service.get_instance(db, tid)
        if not target_inst:
            results.append(
                TargetApplyResult(
                    instance_id=tid, instance_name=f"#{tid}", success=False, dry_run=dry_run, message="目标实例不存在"
                )
            )
            continue
        try:
            web = session_pool.get_web_client(target_inst)
            status, _, err = _build_snapshot(web, object_type, object_name)
            if status == "error":
                # 读取目标失败时禁止写入：否则可能把「读失败」误当作「不存在」而错误新增
                results.append(
                    TargetApplyResult(
                        instance_id=tid, instance_name=target_inst.name, success=False, dry_run=dry_run,
                        message=f"读取目标失败，已跳过：{err}",
                    )
                )
                continue
            exists = status == "found"
            outcome = _write_to_target(
                web, object_type, dict(source_snapshot), exists, dry_run,
                source_web=source_web,
                source_policy_detail=source_policy_detail,
                source_custom_apps=source_custom_apps,
                source_custom_urls=source_custom_urls,
            )
            # 到这里未抛异常即视为成功（dry-run 预览或真实提交均已通过 _post 的 success 校验）
            committed = not outcome.get("dry_run", dry_run)
            if committed:
                invalidate_instance(tid)  # 真实写入后让目标实例的分析缓存失效
            verb = "更新" if exists else "新增"
            missing = outcome.get("missing") or []
            created = outcome.get("created") or []
            # 策略同步附注：自动创建的引用对象 + 仍缺失（内置/源也无、无法自动创建）的引用
            note = ""
            if created:
                note += f"；{'将' if not committed else ''}自动创建 {len(created)} 个被引用对象"
            if missing:
                note += f"；{len(missing)} 个内置引用在目标缺失、无法自动创建"
            results.append(
                TargetApplyResult(
                    instance_id=tid,
                    instance_name=target_inst.name,
                    success=True,
                    dry_run=outcome.get("dry_run", dry_run),
                    message=(f"已{verb}" if committed else f"dry_run 预览（将{verb}）") + note,
                    payload=outcome.get("payload"),
                    warnings=list(missing),
                )
            )
            audit.record(
                db,
                actor=user.username,
                object_type="sync",
                action="dry_run" if (dry_run or outcome.get("dry_run")) else "sync",
                object_name=f"{object_type}:{object_name}",
                instance_id=tid,
                instance_name=target_inst.name,
                success=True,
                message=f"同步「{object_name}」：{source_inst.name} → {target_inst.name}（{verb}）"
                + ("（dry-run）" if (dry_run or outcome.get("dry_run")) else "")
                + note,
                before=None,
                after=outcome.get("payload") or outcome.get("result"),
            )
        except Exception as exc:  # noqa: BLE001
            results.append(
                TargetApplyResult(
                    instance_id=tid, instance_name=target_inst.name, success=False, dry_run=dry_run, message=str(exc)
                )
            )

    return SyncApplyResult(
        object_type=object_type,
        object_name=object_name,
        source_instance_id=source_instance_id,
        results=results,
    )
