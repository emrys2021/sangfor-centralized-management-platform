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
  **自定义**被引用对象（应用 / URL 库）会复用已确认写接口先建到目标。若仍有**无法解析的引用**
  （**内置**对象在目标缺失、或自定义引用**创建失败**），丢弃它会写出与源不等价（**降级**）的策略——
  故 real-write **默认拒绝**（``refused``、``warnings`` 列出这些引用；内置缺失在创建任何对象前即拒绝，
  自定义创建失败则可能已建部分对象、保留在目标），需 ``allow_degrade=True`` 才写入降级版本。落盘走
  已验证路径：目标有同名策略 → ``modify_policy_application``（读目标底座、仅替换规则引用）；无 →
  ``create_policy``（``opr=add``）。适用用户不随报文跨实例，新建后需在目标手工配置。
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
    BatchObjectResult,
    BatchSyncResult,
    BatchTargetResult,
    FieldDiff,
    SyncApplyResult,
    SyncDiffResult,
    TargetApplyResult,
    TargetDiff,
)
from app.services import customrule_form, instance_service, policy_sync, policy_usage_service
from app.services.analysis_cache import invalidate_instance

# 设备「对象不存在」类报错的判别关键词：命中则视为 not_found（可新增），否则一律按
# read_error（读取失败，禁止据此误判为"将新增"并写入）。
_NOT_FOUND_HINTS = ("不存在", "未找到", "找不到", "无此", "no such", "not exist", "not found", "does not exist")


def _is_not_found(message: str) -> bool:
    msg = (message or "").lower()
    return any(h in msg for h in _NOT_FOUND_HINTS)


def build_policy_snapshot(name: str, detail: dict) -> dict:
    """策略规范化快照，**只覆盖「应用控制 / 端口控制 / 代理控制」三段**（其余段——Web 关键字/
    文件类型过滤、邮件过滤、QQ、SaaS 等——不纳入对比，故不在快照里）。

    - 顶层 ``enable``：整条策略启用/禁用。
    - 应用控制：``application_include`` 段开关 + ``rules``（每条含**动作** action 放行/拒绝、
      引用应用 path、URL 名；去掉 crc/rule_id 噪音，rule_id 仅留 ``name`` 供前端提示）。
    - 端口控制：``network_include`` + ``network_rules``（目的 IP 对象 dip / 服务 service /
      动作 action / 时间 time；设备侧无 crc/rule_id，可直接对位比）。
    - 代理控制：``proxy_include`` + ``proxy``（http/sock/errorproto 三个代理类型的开关）。

    对比方（:mod:`app.services.compare_service`）约定：段开关为 False 时**不比该段内容**
    （应用控制没启用就不比规则）。
    """
    appctrl = detail.get("appctrl", {}) or {}
    app_rules = [
        {
            "name": r.get("name", ""),
            "action": r.get("action", "unknown"),
            "apps": sorted(
                ({"path": a["path"], "custom": bool(a.get("custom"))} for a in r.get("apps", [])),
                key=lambda x: x["path"],
            ),
            "urls": sorted(
                ({"name": u["name"], "custom": bool(u.get("custom"))} for u in r.get("urls", [])),
                key=lambda x: x["name"],
            ),
        }
        for r in detail.get("rules", [])
    ]
    net = appctrl.get("network", {}) or {}
    network_rules = [
        {
            "dip": str(x.get("dip", "")),
            "service": str(x.get("service", "")),
            "action": x.get("action"),
            "time": str(x.get("time", "")),
        }
        for x in (net.get("data") or [])
    ]
    proxy = appctrl.get("proxy", {}) or {}
    proxy_norm = {
        "http": bool((proxy.get("http") or {}).get("enable")),
        "sock": bool((proxy.get("sock") or {}).get("enable")),
        "errorproto": bool((proxy.get("errorproto") or {}).get("enable")),
    }
    return {
        "policy_name": name,
        "enable": bool(detail.get("enable", True)),
        "application_include": bool(detail.get("application_include")),
        "rules": app_rules,
        "network_include": bool(net.get("include")),
        "network_rules": network_rules,
        "proxy_include": bool(proxy.get("include")),
        "proxy": proxy_norm,
    }


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
            # 覆盖 应用控制/端口控制/代理控制 三段 + 启用状态（其余段不纳入对比）
            return "found", build_policy_snapshot(name, detail), ""
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
    policy_app_index: dict | None = None,
    allow_degrade: bool = False,
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
            app_index=policy_app_index,
            allow_degrade=allow_degrade,
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
    allow_degrade: bool = False,
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
                allow_degrade=allow_degrade,
            )
            # policy 路径不抛异常、以 outcome["ok"] 表示成败；customrule/url 无 ok 键默认成功
            ok = bool(outcome.get("ok", True))
            committed = ok and not outcome.get("dry_run", dry_run)
            degraded = bool(outcome.get("degraded"))
            refused = bool(outcome.get("refused"))
            verb = "更新" if exists else "新增"
            # 是否真实写入过设备（含"已建部分对象但策略被拒绝"的情况）——决定被创建对象用「已」还是「将」
            is_real = not outcome.get("dry_run", dry_run)
            missing = outcome.get("missing") or []
            created = outcome.get("created") or []
            details = outcome.get("details") or []
            # 失效目标缓存：真实写入策略成功(committed)，或虽被拒/失败但已在目标建了部分自定义引用
            # 对象(created 非空)——两种情况目标设备都已变更，否则引用校验/搜索/对比会读旧缓存、看不到新建对象。
            if committed or (is_real and created):
                invalidate_instance(tid)
            # 策略同步附注：自定义引用对象的创建/更新 + 被丢弃的引用
            note = ""
            if created:
                # 真实写入时这些对象**已经**建/改进设备（即便策略最终被拒绝，它们仍保留在目标）
                note += f"；{'已' if is_real else '将'}创建/更新 {len(created)} 个自定义引用对象"
                if refused and is_real:
                    note += "（保留在目标）"
            if missing and not refused:
                # 仅"降级写入/预览"才是真的把引用跳过并写了策略；被拒绝时策略根本没写、不存在"已跳过"
                note += f"；{len(missing)} 个引用目标缺失或创建失败、已跳过（策略与源不等价）"
            if refused:
                # 乙：默认拒绝——**策略未写入**（但上面 note 会说明已建的自定义对象保留在目标）
                base_msg = f"已拒绝写入策略（缺 {len(missing)} 个引用无法解析）：勾选「允许降级同步」后可写入降级版本"
            elif not ok:
                base_msg = f"同步失败（{verb}）"
            elif committed:
                base_msg = f"已{verb}（降级：跳过 {len(missing)} 个引用）" if degraded else f"已{verb}"
            else:
                base_msg = f"dry_run 预览（将{verb}{'·降级' if degraded else ''}）"
            results.append(
                TargetApplyResult(
                    instance_id=tid,
                    instance_name=target_inst.name,
                    success=ok,
                    dry_run=outcome.get("dry_run", dry_run),
                    degraded=degraded,
                    refused=refused,
                    message=base_msg + note,
                    payload=outcome.get("payload"),
                    warnings=list(missing),
                    details=list(details),
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
                success=ok,
                message=f"同步「{object_name}」：{source_inst.name} → {target_inst.name}（{verb}）"
                + ("（dry-run）" if (dry_run or outcome.get("dry_run")) else "")
                + note
                + ("；".join([""] + details) if details else ""),
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


# --------------------------------------------------------------------------- #
# 批量同步：把某类对象的全部从源同步到目标（可选镜像删除）
# --------------------------------------------------------------------------- #
def _list_object_names(web: SangforWebClient, object_type: str) -> list[str]:
    """列出某实例上某类对象的名称（URL 仅取**自定义**库，内置库不参与批量/镜像）。"""
    if object_type == "customrule":
        return [s["rulename"] for s in web.list_custom_rules() if s.get("rulename")]
    if object_type == "url":
        return [
            n["name"]
            for n in web.list_url_groups().get("flat", []) or []
            if n.get("name") and not n.get("inside")
        ]
    return [p["name"] for p in web.list_policies().get("access_policies", []) if p.get("name")]


def _delete_from_target(web: SangforWebClient, object_type: str, name: str, dry_run: bool) -> dict:
    """镜像模式：删除目标上「源没有」的对象（复用各类已确认的删除接口）。"""
    if object_type == "customrule":
        return web.delete_custom_rule(name, dry_run=dry_run)
    if object_type == "url":
        return web.delete_url_group(name, dry_run=dry_run)
    return web.delete_policy(name, dry_run=dry_run)


def _read_before_delete(web: SangforWebClient, object_type: str, name: str) -> dict | None:
    """删前快照（尽力而为）：读取完整对象详情存入审计 ``before``，误删后可按快照重建。

    读取失败返回 ``None``、不阻断删除本身（与单对象删除路径的取舍一致）。
    """
    try:
        if object_type == "customrule":
            return web.get_custom_rule_detail(name)
        if object_type == "url":
            return web.get_url_group_detail(name)
        return web.get_policy_detail(name)
    except Exception:  # noqa: BLE001
        return None


def batch_sync(
    db: Session,
    user: CurrentUser,
    *,
    object_type: str,
    source_instance_id: int,
    target_instance_ids: list[int],
    push_all: bool,
    mirror: bool,
    dry_run: bool,
    allow_degrade: bool = False,
    object_names: list[str] | None = None,
) -> BatchSyncResult:
    """把源实例某类对象同步到目标：逐对象 upsert；``mirror`` 时删除目标多余对象。

    ``object_names`` 不给时同步源上**全部**对象；给定时只同步这个「已选」子集。**不直接信任**
    传入的子集——仍会现取一次源名单核对存在性（只是一次列表调用，不逐个拉详情，代价与「全部」
    路径本来就要付的一样），选中但源上其实已不存在的名字（前端名单缓存滞后，或恰好被别人删除）
    在每个目标下都记为 ``failed``，不会被当成「将新增/更新」误报。

    复用单对象写路径（``_write_to_target``），自定义应用/URL 直写、策略带 crc 重映射与自动
    建引用。性能：源对象列表与（策略用的）源自定义名单各预读一次；每个目标的应用树索引建一次、
    复用给该目标的每条策略。

    **镜像与已选子集互斥**：镜像要求以源的全集为基准判定「目标多余」，若同时传入子集，会把
    「没被选中、但双方都合法存在」的目标对象误判成多余而删除，故两者同时为真时直接拒绝。

    镜像删除的安全措施（仅真实执行时生效；dry-run 预览**不做引用校验**、只按名称列候选名单，
    遍历组织树的校验较慢、放进预览会拖慢秒回体验——真实执行时才校验，故候选名单与实际删除结果
    可能不同：预览里的策略若在此期间被引用，真实执行时会被跳过而非删除，前端文案已标注这一点）：

    - **策略**：删除前对目标做一次强制刷新的引用校验，在用（有用户引用）的策略跳过不删；
      校验失败（部分组读不到等）时无法确认在用与否，该目标的策略镜像删除全部拒绝；校验成功
      但结果里**没有**某个策略名（与镜像名单来自两次独立设备调用、之间可能有时间差或固件解析
      差异）同样视为「无法确认」，不当作 0 引用直接删。
    - 每个被删对象删除前读取完整详情作为快照，随删除动作单独落一条审计（``before`` 字段），
      误删后可按快照内容重建。
    """
    if object_names and mirror:
        raise ValueError("镜像模式仅支持「全部对象」，选中部分对象时请取消镜像或改选全部对象")
    source_inst = instance_service.get_instance(db, source_instance_id)
    if not source_inst:
        raise ValueError("源实例不存在")
    source_web = session_pool.get_web_client(source_inst)
    current_source_names = _list_object_names(source_web, object_type)
    if object_names:
        current_set = set(current_source_names)
        stale_names = [n for n in object_names if n not in current_set]
        source_names = [n for n in object_names if n in current_set]
    else:
        stale_names = []
        source_names = current_source_names
    source_name_set = set(source_names)

    # 策略：源自定义应用 / URL 名单预读一次（供 crc 重映射的自动建引用使用）。
    # 仅真实写入时需要——dry-run 预览只按名称分类、不逐个拉详情，故跳过。
    source_custom_apps: set[str] = set()
    source_custom_urls: set[str] = set()
    if object_type == "policy" and not dry_run:
        source_custom_apps = {s.get("rulename") for s in source_web.list_custom_rules() if s.get("rulename")}
        source_custom_urls = {
            n.get("name")
            for n in source_web.list_url_groups().get("flat", [])
            if n.get("name") and not n.get("inside")
        }

    if push_all:
        all_enabled = instance_service.list_instances(db, only_enabled=True)
        target_ids = [i.id for i in all_enabled if i.id != source_instance_id]
    else:
        target_ids = [tid for tid in target_instance_ids if tid != source_instance_id]

    targets: list[BatchTargetResult] = []
    for tid in target_ids:
        target_inst = instance_service.get_instance(db, tid)
        if not target_inst:
            targets.append(
                BatchTargetResult(instance_id=tid, instance_name=f"#{tid}", dry_run=dry_run, error="目标实例不存在")
            )
            continue
        try:
            web = session_pool.get_web_client(target_inst)
            target_names = _list_object_names(web, object_type)
        except Exception as exc:  # noqa: BLE001  连接/登录失败
            targets.append(
                BatchTargetResult(
                    instance_id=tid, instance_name=target_inst.name, dry_run=dry_run, error=f"读取目标失败：{exc}"
                )
            )
            continue
        target_name_set = set(target_names)

        # 策略：本目标的应用树索引建一次，复用给每条策略（免逐条重复拉取）。仅真实写入时需要。
        policy_index = None
        if object_type == "policy" and not dry_run:
            try:
                policy_index = policy_sync.build_app_index(web.list_app_tree())
            except Exception:  # noqa: BLE001  取不到则各策略自行拉取
                policy_index = None

        created: list[str] = []
        updated: list[str] = []
        deleted: list[str] = []
        failed: list[BatchObjectResult] = [
            BatchObjectResult(
                name=n, action="fail", ok=False,
                message="已选对象在源实例上已不存在（可能刚被删除，请刷新对象列表后重试）",
            )
            for n in stale_names
        ]
        details: list[BatchObjectResult] = []

        # 1) upsert：目标已有同名→更新（覆盖为与源一致），否则新增。
        # **dry-run 预览仅按名称分类**——不逐个拉源详情/建报文（那样每对象一次 listItem、N 个串行很慢）。
        for name in source_names:
            exists = name in target_name_set
            if dry_run:
                (updated if exists else created).append(name)
                details.append(BatchObjectResult(name=name, action="update" if exists else "create", ok=True))
                continue
            try:
                if object_type == "policy":
                    detail = source_web.get_policy_detail(name)
                    outcome = _write_to_target(
                        web, object_type, {}, exists, dry_run,
                        source_web=source_web, source_policy_detail=detail,
                        source_custom_apps=source_custom_apps, source_custom_urls=source_custom_urls,
                        policy_app_index=policy_index, allow_degrade=allow_degrade,
                    )
                    op_ok = outcome.get("ok", True)
                else:
                    st, snap, err = _build_snapshot(source_web, object_type, name)
                    if st != "found":
                        failed.append(
                            BatchObjectResult(name=name, action="fail", ok=False, message=f"读取源失败：{err}")
                        )
                        continue
                    outcome = _write_to_target(web, object_type, dict(snap), exists, dry_run)
                    op_ok = True
                if not op_ok:  # 策略写失败或被拒绝降级（ok=False，不抛）
                    # 被拒/失败但已在目标建了部分自定义引用对象：目标已变更，仍要失效缓存
                    if outcome.get("created"):
                        invalidate_instance(tid)
                    msg = "；".join(outcome.get("details", [])) or "写入失败"
                    failed.append(BatchObjectResult(name=name, action="fail", ok=False, message=msg))
                else:
                    invalidate_instance(tid)  # 真实写入后失效目标分析缓存
                    (updated if exists else created).append(name)
                    miss = len(outcome.get("missing") or [])
                    details.append(BatchObjectResult(
                        name=name, action="update" if exists else "create", ok=True,
                        message=f"降级：跳过 {miss} 个引用（与源不等价）" if outcome.get("degraded") else "",
                    ))
            except Exception as exc:  # noqa: BLE001  单对象失败不拖垮整体
                failed.append(BatchObjectResult(name=name, action="fail", ok=False, message=str(exc)))

        # 2) 镜像删除：目标上源没有的对象
        if mirror:
            extra_names = sorted(target_name_set - source_name_set)
            # 策略镜像删除的安全闸（与「一键清理无人引用」同一取舍）：真实删除前对目标做一次
            # **强制刷新**的引用校验——在用策略跳过不删；校验有组读取失败/异常时数据不完整，
            # 为安全全部拒删（否则可能把仅仅是"没读到引用"的在用策略当成多余对象删掉）。
            usage_by_name: dict[str, int] = {}
            usage_error = ""
            if extra_names and object_type == "policy" and not dry_run:
                try:
                    usage = policy_usage_service.analyze_policy_usage(target_inst, force=True)
                    errs = usage.get("errors") or []
                    if errs:
                        usage_error = "；".join(str(e) for e in errs)
                    else:
                        usage_by_name = {
                            p["name"]: int(p.get("user_count", 0) or 0) for p in usage.get("policies", [])
                        }
                except Exception as exc:  # noqa: BLE001
                    usage_error = str(exc)
            for name in extra_names:
                if dry_run:  # 预览只列候选名单，不做引用校验、不发删除请求（校验遍历组织树较慢）；
                    # 真实执行时会重新校验引用，在用的策略届时会被跳过——预览与实际执行结果可能不同。
                    deleted.append(name)
                    msg = "候选镜像删除（源中不存在；真实执行前会重新校验引用，在用的策略将跳过）"
                    details.append(
                        BatchObjectResult(name=name, action="delete", ok=True, message=msg)
                        if object_type == "policy"
                        else BatchObjectResult(name=name, action="delete", ok=True, message="镜像删除（源中不存在）")
                    )
                    continue
                if object_type == "policy" and usage_error:
                    failed.append(BatchObjectResult(
                        name=name, action="fail", ok=False,
                        message=f"为安全未删除：目标策略引用校验失败，无法确认是否在用（{usage_error}）",
                    ))
                    continue
                if object_type == "policy" and name not in usage_by_name:
                    # 校验本身成功，但结果里没有这个策略名（列表与镜像名单来自两次独立设备调用间的
                    # 时间差、固件解析差异等）——同样无法确认是否在用，为安全不删，而非当作 0 引用。
                    failed.append(BatchObjectResult(
                        name=name, action="fail", ok=False,
                        message="为安全未删除：引用校验结果未包含该策略，无法确认是否在用",
                    ))
                    continue
                if usage_by_name.get(name, 0) > 0:
                    details.append(BatchObjectResult(
                        name=name, action="skip", ok=True,
                        message=f"在用（{usage_by_name[name]} 个用户引用），已跳过镜像删除",
                    ))
                    continue
                try:
                    before = _read_before_delete(web, object_type, name)
                    _delete_from_target(web, object_type, name, dry_run)
                    invalidate_instance(tid)
                    deleted.append(name)
                    details.append(
                        BatchObjectResult(name=name, action="delete", ok=True, message="镜像删除（源中不存在）")
                    )
                    # 每个被删对象单独落一条审计并带删前快照，误删后可按快照内容重建
                    audit.record(
                        db,
                        actor=user.username,
                        object_type=object_type,
                        action="delete",
                        object_name=name,
                        instance_id=tid,
                        instance_name=target_inst.name,
                        message=f"镜像删除（{source_inst.name} 中不存在）",
                        before=before,
                        after=None,
                    )
                except Exception as exc:  # noqa: BLE001
                    failed.append(BatchObjectResult(name=name, action="fail", ok=False, message=f"删除失败：{exc}"))

        targets.append(
            BatchTargetResult(
                instance_id=tid, instance_name=target_inst.name, dry_run=dry_run,
                created=created, updated=updated, deleted=deleted, failed=failed, details=details,
            )
        )
        audit.record(
            db,
            actor=user.username,
            object_type="sync",
            action="dry_run" if dry_run else "sync",
            object_name=f"{object_type}:batch",
            instance_id=tid,
            instance_name=target_inst.name,
            success=len(failed) == 0,
            message=f"批量同步 {object_type}：{source_inst.name} → {target_inst.name}"
            + f"（新增 {len(created)}/覆盖 {len(updated)}/删除 {len(deleted)}/失败 {len(failed)}）"
            + ("（dry-run）" if dry_run else "")
            + ("（镜像）" if mirror else ""),
            before=None,
            after=None,
        )

    return BatchSyncResult(
        object_type=object_type,
        source_instance_id=source_instance_id,
        source_count=len(source_names),
        mirror=mirror,
        targets=targets,
    )
