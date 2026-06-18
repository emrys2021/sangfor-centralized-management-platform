#! /usr/bin/env python3
# coding=utf-8
"""访问权限策略跨实例同步：crc 重映射 + 引用对象自动创建 + 读-改-写编排。

跨实例同步策略的核心障碍：规则引用的应用 / URL 库携带 ``crc``，而 **crc 由各设备独立
分配**（尤其自定义应用），源设备的 crc 拿到目标设备无效。本模块据目标设备的应用目录树
（``listAppTree``）按**引用路径**反查目标自己的 crc，重建可写报文；并在目标缺少被引用的
**自定义**应用 / URL 库时，复用已确认的写接口先把它们建到目标（内置对象无法创建，仅告警）。

落盘走**已验证的写路径**，不臆造新报文：

- 目标已存在同名策略 → :meth:`modify_policy_application`（读目标自身策略为底座、仅替换
  ``appctrl.application.data`` 各规则的动作与引用，其余字段原样保留），与单实例编辑同一契约。
- 目标无此策略 → :meth:`create_policy`（``opr=add``，data 取自源完整对象、crc 重映射）。

适用用户 / 对象（``use_info``）不随 netpolicy 报文跨实例（设备另由 acnetpolicy 保存、且各
设备用户结构不同），新建后需在目标手工配置适用人员（与单实例「新建策略」一致）。
"""

from __future__ import annotations

import copy
import re

from app.sangfor.web_base import SangforWebError
from app.services import customrule_form

# listItem 响应里属于「响应信封」而非策略本体的键，往返提交前需剔除
# （与 :data:`app.sangfor.policy_cgi.PolicyCgiMixin._POLICY_ENVELOPE_KEYS` 保持一致）。
_ENVELOPE_KEYS = {"success", "msg", "errcode", "errCode", "code", "total", "status", "result"}


def _split_path(path: str) -> list[str]:
    """按 AC 引用路径分隔符拆分（``/`` ``\\`` ``>`` ``＞``）。"""
    return [s.strip() for s in re.split(r"[/\\>＞]+", path or "") if s.strip()]


def build_app_index(tree: dict) -> dict[str, dict]:
    """把目标 ``listAppTree`` 结果展平为 ``path(value) -> {crc, type}`` 索引。

    遍历整棵树（含 ``children``），对每个带 ``value`` 的节点登记其 ``crc`` / ``type``。
    同一 ``value`` 多次出现时以**首次**为准（树中路径应唯一）。供按引用路径 O(1) 查目标 crc。
    """
    index: dict[str, dict] = {}

    def walk(nodes) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            value = node.get("value")
            if value and str(value) not in index:
                index[str(value)] = {
                    "crc": "" if node.get("crc") is None else str(node.get("crc")),
                    "type": "" if node.get("type") is None else str(node.get("type")),
                }
            walk(node.get("children"))

    walk(tree.get("data"))
    return index


def build_remapped_rules(source_detail: dict, app_index: dict[str, dict]) -> tuple[list[dict], list[str]]:
    """从源策略解析规则，构造 :meth:`modify_policy_application` 所需的 ``rules``，crc 重映射为目标。

    :returns: ``(rules, 缺失路径列表)``。``rules`` 每项形如
        ``{"name": <规则ID>, "action": <bool>, "refs": [{"path","type","crc","extra"}...]}``；
        缺失 = 源引用路径在目标 app 树中不存在（缺失项暂保留源 crc 占位，由调用方决定是否落盘）。
    """
    rules_out: list[dict] = []
    missing: list[str] = []
    for rule in source_detail.get("rules", []) or []:
        refs_out: list[dict] = []
        for ref in rule.get("refs", []) or []:
            path = str(ref.get("path") or "")
            if not path:
                continue
            target = app_index.get(path)
            if target is None:
                missing.append(path)
                crc = "" if ref.get("crc") is None else str(ref.get("crc"))  # 占位，不臆造
            else:
                crc = target["crc"]
            refs_out.append(
                {
                    "path": path,
                    "type": "" if ref.get("type") is None else str(ref.get("type")),
                    "crc": crc,
                    "extra": ref.get("extra", "") or "",
                }
            )
        rules_out.append(
            {
                "name": str(rule.get("rule_id") or rule.get("name") or ""),
                "action": bool(rule.get("action_bool")),
                "refs": refs_out,
            }
        )
    return rules_out, sorted(set(missing))


def remap_policy_data(source_detail: dict, app_index: dict[str, dict]) -> tuple[dict, list[str]]:
    """用目标 app 索引重映射源策略**完整对象**的引用 crc，供 ``opr=add`` 新建使用。

    返回 ``(可写 data, 缺失路径)``。仅替换 ``appctrl.application.data[*].apps.apps[*].crc``，
    其余字段原样保留；剔除信封字段与 ``use_info``（适用对象不跨实例）。data 为深拷贝。
    """
    raw = source_detail.get("raw")
    if not isinstance(raw, dict):
        raw = {}
    data = {k: copy.deepcopy(v) for k, v in raw.items() if k not in _ENVELOPE_KEYS}
    data.setdefault("name", source_detail.get("policy_name", ""))

    missing: list[str] = []
    appctrl = data.get("appctrl")
    application = appctrl.get("application") if isinstance(appctrl, dict) else None
    rules = application.get("data") if isinstance(application, dict) else None
    for rule in rules or []:
        if not isinstance(rule, dict):
            continue
        apps_field = rule.get("apps")
        inner = apps_field.get("apps") if isinstance(apps_field, dict) else None
        for ref in inner or []:
            if not isinstance(ref, dict):
                continue
            path = str(ref.get("path") or "")
            if not path:
                continue
            target = app_index.get(path)
            if target is None:
                missing.append(path)
                continue
            ref["crc"] = target["crc"]

    data.pop("use_info", None)
    return data, sorted(set(missing))


def classify_missing(
    missing_paths: list[str],
    source_custom_apps: set[str],
    source_custom_urls: set[str],
) -> tuple[list[dict], list[str]]:
    """把缺失引用分为「可自动创建（源上是自定义对象）」与「硬缺失（内置 / 源也无）」。

    - URL 引用路径形如 ``访问网站/<URL库名>/<子类>``，库名取第二段；该库在源为自定义则可创建。
    - 应用引用：路径任一段命中源自定义应用名则可创建。
    - 其余（内置应用 / 内置 URL 分类 / 源上不存在）归为硬缺失，无法自动创建。

    :returns: ``(creatable, hard)``，``creatable`` 每项 ``{"path","kind","name"}``。
    """
    creatable: list[dict] = []
    hard: list[str] = []
    for path in missing_paths:
        segs = _split_path(path)
        url_name = segs[1] if len(segs) > 1 and segs[0] == "访问网站" else None
        app_name = next((s for s in segs if s in source_custom_apps), None)
        if url_name and url_name in source_custom_urls:
            creatable.append({"path": path, "kind": "url", "name": url_name})
        elif app_name:
            creatable.append({"path": path, "kind": "app", "name": app_name})
        else:
            hard.append(path)
    return creatable, hard


def create_referenced_objects(source_web, target_web, creatable: list[dict], *, dry_run: bool) -> list[str]:
    """复用已确认的写接口，把可创建的自定义应用 / URL 库从源建到目标。

    :returns: 实际（或 dry-run 预演）创建的引用路径列表。
    """
    created: list[str] = []
    for item in creatable:
        if item["kind"] == "url":
            detail = source_web.get_url_group_detail(item["name"])
            data = {
                "id": "",
                "name": item["name"],
                "depict": detail.get("depict", ""),
                "url": detail.get("url_text", ""),
                "keyword": detail.get("keyword", ""),
            }
            target_web.create_url_group(data, dry_run=dry_run)
        else:
            detail = source_web.get_custom_rule_detail(item["name"])
            form = customrule_form.parse_form(detail.get("summary", {}), detail.get("detail", {}))
            data = customrule_form.build_payload({**form, "rulename": item["name"]})
            target_web.create_custom_rule(data, dry_run=dry_run)
        created.append(item["path"])
    return created


def sync_policy_to_target(
    source_web,
    target_web,
    source_detail: dict,
    *,
    exists: bool,
    dry_run: bool,
    source_custom_apps: set[str],
    source_custom_urls: set[str],
    auto_create: bool = True,
) -> dict:
    """把源策略同步到目标实例：crc 重映射 + 自动建引用 + 读-改-写 / 新建。

    返回 outcome：``{"dry_run","payload","created","missing", ...}``。

    - ``created``：本次（或 dry-run 预演）自动创建的被引用对象路径。
    - ``missing``：仍无法解析的硬缺失引用（内置 / 源也无）；real-write 时遇硬缺失会抛错阻止，
      不会创建任何对象、不写策略（全有或全无）。

    性能：每个目标只 ``list_app_tree`` 一次建索引（自动创建后会重取一次以解析新对象 crc）；
    源自定义应用 / URL 名单由调用方预读一次传入，不在此重复拉取。
    """
    policy_name = source_detail.get("policy_name", "")
    index = build_app_index(target_web.list_app_tree())
    rules, missing = build_remapped_rules(source_detail, index)

    created: list[str] = []
    if missing and auto_create:
        creatable, hard = classify_missing(missing, source_custom_apps, source_custom_urls)
        if dry_run:
            created = [c["path"] for c in creatable]  # 预告将创建
            missing = hard
        else:
            if hard:
                raise SangforWebError(
                    "目标缺少无法自动创建的引用（内置或源上不存在）："
                    + "、".join(hard)
                    + "；请先在目标手工补齐再同步"
                )
            created = create_referenced_objects(source_web, target_web, creatable, dry_run=False)
            index = build_app_index(target_web.list_app_tree())  # 重取，解析新对象 crc
            rules, missing = build_remapped_rules(source_detail, index)
            if missing:
                raise SangforWebError("自动创建引用后仍有路径无法解析：" + "、".join(missing))
    elif missing and not dry_run:
        raise SangforWebError("目标缺少被引用对象：" + "、".join(missing) + "；请先同步对应自定义应用 / URL 库")

    if exists:
        outcome = target_web.modify_policy_application(
            policy_name,
            rules,
            application_include=bool(source_detail.get("application_include", True)),
            enable=bool(source_detail.get("enable", True)),
            depict=str(source_detail.get("depict", "")),
            dry_run=dry_run,
        )
    else:
        data, _ = remap_policy_data(source_detail, index)
        outcome = target_web.create_policy(data, dry_run=dry_run)

    outcome = dict(outcome)
    outcome["created"] = created
    outcome["missing"] = missing
    return outcome
