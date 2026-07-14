#! /usr/bin/env python3
# coding=utf-8
"""自定义应用 / 自定义 URL 库的跨实例「合并（并集）」。

场景：管理员 A 在站点 A 给某个对象加了条 IP、没同步到 B；管理员 B 在站点 B 给同名对象加了
另一条 IP、没同步到 A。此时单向同步（A→B 或 B→A）都会用一端覆盖另一端、丢掉对方的新增。
「合并」改为对**列表型内容**求**并集**（去重），再写回**所有参与实例**，使各端**列表内容**从此
一致、谁的新增都不丢。这些列表（IP/URL/域名/关键词）语义是**集合、顺序无意义**——对比也按集合
比（见 :func:`sync_service._field_equal`），故仅顺序不同不算差异、也无需重排。

**只并列表内容、不动每端专属字段**：``status``（启用状态）/ ``depict``（描述）是每端各自的
运营选择（如同一应用深圳启用、杭州禁用），合并时**保留各端原值、既不并也不覆盖**——只把列表
字段替换成并集。故合并后两端的**列表内容**一致，但启用状态/描述可能仍各不相同（对比里也会
如实显示这类非列表差异）。

适用对象与可合并性：

- **自定义 URL 库**：``url``（URL/IP 条目）、``keyword`` 均为换行分隔列表，**总是可合并**。
- **自定义应用**：``ip_range`` / ``domain`` 是列表可并集；但 ``apptype`` / ``appname`` /
  ``direction`` / ``protocol`` / ``protocol_num`` / ``port_mode`` / ``ip_mode`` / ``port_range``
  是**模式/标量**字段，无法并集——两端不一致即为**冲突**，不写、只回报冲突字段，需人工处理。
  （``status`` / ``depict`` 不计冲突，见上。用户「各加了个 IP」的典型场景可安全合并。）

**访问权限策略不支持合并**：其内容是对应用/URL 的引用（含各设备独立的 crc），并集语义与写法
均不同，超出本模块范围。

写回内容按实例逐个构造（该实例自身快照 + 并集列表）。列表字段语义是**集合、顺序无意义**（对比
也按集合比，见 :func:`sync_service._field_equal`），故仅条目顺序不同的一端**不会**被判为差异、也
不做无谓重写——只有真的缺条目的一端才补齐。落盘走已确认的写接口（``update_custom_rule`` /
``update_url_group`` / ``create_*``），dry-run 安全闸与写白名单一并生效；每个被写实例各落一条
审计（变更前=该实例原内容，变更后=该实例合并后内容）。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import CurrentUser
from app.sangfor import session_pool
from app.schemas.sync import MergePreviewField, MergeResult, MergeTargetResult
from app.services import customrule_form, instance_service, sync_service

# 自定义应用里必须两端一致（否则算冲突、不合并）的模式/标量字段
_CUSTOMRULE_MUST_MATCH = (
    "apptype", "appname", "direction", "protocol", "protocol_num", "port_mode", "ip_mode", "port_range",
)

# 各类对象里参与并集、需在预览里按来源高亮的列表字段（字段名 -> 展示标签）
_MERGE_LIST_FIELDS = {
    "url": [("url", "URL / IP 列表"), ("keyword", "关键词")],
    "customrule": [("ip_range", "IP 范围"), ("domain", "域名")],
}


def _lines(text) -> list[str]:
    """把换行分隔的文本拆成去空、去首尾空白的条目列表。"""
    return [s.strip() for s in str(text or "").replace("\r\n", "\n").split("\n") if s.strip()]


def union_lines(*texts) -> str:
    """多个换行分隔文本的**有序去重并集**：保持先出现者在前，重新以换行拼接。"""
    seen: set[str] = set()
    out: list[str] = []
    for t in texts:
        for e in _lines(t):
            if e not in seen:
                seen.add(e)
                out.append(e)
    return "\n".join(out)


def union_list_fields(object_type: str, snaps: list[dict]) -> dict[str, str]:
    """各**列表字段**的 canonical 并集文本（URL 库：url/keyword；自定义应用：ip_range/domain）。

    合并**只并列表内容**——每端的**启用状态 / 描述**等专属字段不并、不覆盖（见 :func:`merge_object`
    的逐实例写回）。列表按首次出现去重（``snaps[0]`` 在前）拼接；列表语义是集合、顺序无意义，故写回
    顺序不影响后续对比（对比也按集合比）。
    """
    return {
        field: union_lines(*[s.get(field) for s in snaps])
        for field, _ in _MERGE_LIST_FIELDS.get(object_type, [])
    }


def customrule_conflicts(snaps: list[dict]) -> list[str]:
    """自定义应用中两端不一致、无法并集的**模式/标量**字段。

    不含 ``status``（启用状态）/ ``depict``（描述）——这些是**每端专属**、合并时保留各端原值、
    既不并也不覆盖，故不作为冲突。有任一模式/标量字段不一致即为冲突（调用方拒绝写入、提示人工处理）。
    """
    return [f for f in _CUSTOMRULE_MUST_MATCH if len({str(s.get(f, "")) for s in snaps}) > 1]


def _preview_fields(object_type: str, snaps: list[dict]) -> list[MergePreviewField]:
    """按来源给并集里的每个列表条目分类，供预览高亮：两端共有 / 源独有 / 目标独有。

    ``snaps[0]`` 视为「源」侧，其余视为「目标」侧（UI 恒为源 ↔ 单个目标的两两合并；多实例时
    「目标」= 其余实例的并集）。只保留有内容的字段。
    """
    src = snaps[0]
    others = snaps[1:]
    out: list[MergePreviewField] = []
    for field, label in _MERGE_LIST_FIELDS.get(object_type, []):
        s = _lines(src.get(field))
        sset = set(s)
        oset: set[str] = set()
        o: list[str] = []
        for sn in others:
            for e in _lines(sn.get(field)):
                if e not in oset:
                    oset.add(e)
                    o.append(e)
        both = [e for e in s if e in oset]
        only_source = [e for e in s if e not in oset]
        only_target = [e for e in o if e not in sset]
        if both or only_source or only_target:
            out.append(MergePreviewField(
                field=field, label=label, both=both, only_source=only_source, only_target=only_target,
            ))
    return out


def _instance_write_content(base_snap: dict, union_fields: dict) -> dict:
    """某实例的写回内容：以该实例**自身快照**为底，仅把列表字段替换成并集。

    启用状态 / 描述 / 各模式标量字段一律沿用该实例自身值——**不被源端静默覆盖**（新建实例时
    ``base_snap`` 取源快照作模板）。
    """
    return {**base_snap, **union_fields}


def _already_merged(snap: dict, union_fields: dict) -> bool:
    """该实例各列表字段是否已**（按集合）**等于并集（则无需写入）。

    列表字段语义是集合、顺序无意义（对比也按集合比，见 :func:`sync_service._field_equal`），故
    这里按集合比较：某端已包含并集的全部条目（即等于并集集合）就跳过，不因仅顺序不同做无谓重写。
    """
    return all(set(_lines(snap.get(f))) == set(_lines(v)) for f, v in union_fields.items())


def _write_merged(web, object_type: str, merged: dict, *, exists: bool, dry_run: bool) -> dict:
    """把某实例的写回内容落盘（存在→更新，不存在→新建），走已确认的写接口。"""
    if object_type == "url":
        data = {
            "id": "",
            "name": merged["name"],
            "depict": merged.get("depict", ""),
            "url": merged.get("url", ""),
            "keyword": merged.get("keyword", ""),
        }
        return web.update_url_group(data, dry_run=dry_run) if exists else web.create_url_group(data, dry_run=dry_run)
    data = customrule_form.build_payload(merged)
    return web.update_custom_rule(data, dry_run=dry_run) if exists else web.create_custom_rule(data, dry_run=dry_run)


def merge_object(
    db: Session,
    user: CurrentUser,
    *,
    object_type: str,
    object_name: str,
    instance_ids: list[int],
    dry_run: bool = True,
) -> MergeResult:
    """把某个自定义应用 / URL 库在多个实例上的内容合并为并集，并写回**所有参与实例**。

    流程：逐实例读该对象快照 → 对列表字段求并集（自定义应用遇模式/标量冲突则中止、回报冲突）
    → 把并集写回每个实例（以其自身快照为底、仅替换列表字段，保留启用状态/描述；有则更新、无则
    新建），dry-run 时只预览不写 → 各落一条审计。

    - ``object_type`` 仅支持 ``customrule`` / ``url``；策略不支持合并（见模块 docstring）。
    - 读取失败的实例记为 ``fail`` 且不纳入并集（不拿残缺内容污染并集）。
    - 冲突（自定义应用模式/标量不一致）：不写任何实例，``conflict=True`` + ``conflict_fields``。
    """
    if object_type not in ("customrule", "url"):
        raise ValueError("合并仅支持自定义应用 / 自定义 URL 库")
    ids = list(dict.fromkeys(instance_ids))  # 去重保序
    if len(ids) < 2:
        raise ValueError("合并至少需要两个实例")

    # 逐实例读快照，区分 found / not_found / error
    read: list[dict] = []
    for iid in ids:
        inst = instance_service.get_instance(db, iid)
        if not inst:
            read.append({"id": iid, "name": f"#{iid}", "status": "error", "snap": None, "err": "实例不存在"})
            continue
        try:
            web = session_pool.get_web_client(inst)
            status, snap, err = sync_service._build_snapshot(web, object_type, object_name)
        except Exception as exc:  # noqa: BLE001  连接/登录失败
            read.append({"id": iid, "name": inst.name, "status": "error", "snap": None, "err": str(exc)})
            continue
        read.append({"id": iid, "name": inst.name, "status": status, "snap": snap, "err": err})

    found = [r for r in read if r["status"] == "found"]
    if len(found) < 2:
        # 少于两端有内容，无从"合并"（应走普通新增/同步，而非并集）
        raise ValueError("至少需要两个实例都存在该对象才能合并")

    found_snaps = [r["snap"] for r in found]
    # 自定义应用：模式/标量字段两端不一致 = 冲突（不含启用状态/描述，那些每端保留）
    conflict_fields = customrule_conflicts(found_snaps) if object_type == "customrule" else []
    if conflict_fields:
        return MergeResult(
            object_type=object_type, object_name=object_name, dry_run=dry_run,
            conflict=True, conflict_fields=conflict_fields, merged_snapshot=None,
            targets=[
                MergeTargetResult(instance_id=r["id"], instance_name=r["name"], action="skip", ok=False,
                                  message="存在冲突字段，未写入")
                for r in read
            ],
        )

    union_fields = union_list_fields(object_type, found_snaps)  # 仅列表字段的并集
    # 预览用的代表快照：以源为底 + 并集列表（启用状态/描述展示源端值，实际写回各端保留自身）
    merged_repr = _instance_write_content(found_snaps[0], union_fields)

    targets: list[MergeTargetResult] = []
    for r in read:
        if r["status"] == "error":
            targets.append(MergeTargetResult(instance_id=r["id"], instance_name=r["name"], action="fail",
                                             ok=False, message=f"读取失败，未写入：{r['err']}"))
            continue
        exists = r["status"] == "found"
        # 该实例列表字段已逐字等于并集（顺序也一致）→ 跳过，不做无谓写入/审计
        if exists and _already_merged(r["snap"], union_fields):
            targets.append(MergeTargetResult(instance_id=r["id"], instance_name=r["name"], action="skip",
                                             ok=True, message="列表内容已是并集，无需写入"))
            continue
        # 写回内容：以该实例自身快照为底（新建则取源为模板），仅替换列表字段——启用状态/描述不动
        content = _instance_write_content(r["snap"] if exists else found_snaps[0], union_fields)
        inst = instance_service.get_instance(db, r["id"])
        try:
            web = session_pool.get_web_client(inst)
            _write_merged(web, object_type, content, exists=exists, dry_run=dry_run)
        except Exception as exc:  # noqa: BLE001  单实例写失败不拖垮其余
            targets.append(MergeTargetResult(instance_id=r["id"], instance_name=r["name"], action="fail",
                                             ok=False, message=f"写入失败：{exc}"))
            continue
        action = "update" if exists else "create"
        if not dry_run:
            sync_service.invalidate_instance(r["id"])
            audit.record(
                db, actor=user.username, object_type=object_type, action="merge",
                object_name=object_name, instance_id=r["id"], instance_name=r["name"],
                message=f"合并（列表内容并集）写入「{object_name}」（{'更新' if exists else '新建'}）",
                before=sync_service._content_snapshot(object_type, r["snap"]) if exists else None,
                after=sync_service._content_snapshot(object_type, content),
            )
        targets.append(MergeTargetResult(
            instance_id=r["id"], instance_name=r["name"], action=action, ok=True,
            message=("dry-run 预览（将{}）".format("更新" if exists else "新建") if dry_run
                     else ("列表内容已合并为并集" if exists else "已新建为并集")),
        ))

    return MergeResult(
        object_type=object_type, object_name=object_name, dry_run=dry_run,
        conflict=False, conflict_fields=[], merged_snapshot=merged_repr,
        preview_fields=_preview_fields(object_type, found_snaps), targets=targets,
    )
