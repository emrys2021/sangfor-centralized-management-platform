#! /usr/bin/env python3
# coding=utf-8
"""访问权限策略跨实例同步：crc 重映射 + 引用对象自动创建 + 读-改-写编排。

跨实例同步策略的核心障碍：规则引用的应用 / URL 库携带 ``crc``，而 **crc 由各设备独立
分配**（尤其自定义应用），源设备的 crc 拿到目标设备无效。本模块据目标设备的应用目录树
（``listAppTree``）按**引用路径**反查目标自己的 crc，重建可写报文；并在目标缺少被引用的
**自定义**应用 / URL 库时，复用已确认的写接口先把它们建到目标。若仍有**无法解析的引用**（内置
对象在目标缺失、或自定义引用创建失败），写策略会丢弃它、得到与源不等价（降级）的版本——故默认
**拒绝**写入，需显式允许降级（``allow_degrade``）才写（详见 :func:`sync_policy_to_target`）。

落盘走**已验证的写路径**，不臆造新报文：

- 目标已存在同名策略 → :meth:`modify_policy_application`（读目标自身策略为底座、仅替换
  ``appctrl.application.data`` 各规则的动作与引用，其余字段原样保留），与单实例编辑同一契约。
- 目标无此策略 → :meth:`create_policy`（``opr=add``，data 取自源完整对象、crc 重映射）。

适用用户 / 对象（``use_info``）不随 netpolicy 报文跨实例（设备另由 acnetpolicy 保存、且各
设备用户结构不同），新建后需在目标手工配置适用人员（与单实例「新建策略」一致）。
"""

from __future__ import annotations

import re

from app.services import customrule_form, policy_template


def _split_path(path: str) -> list[str]:
    """按 AC 引用路径分隔符拆分（``/`` ``\\`` ``>`` ``＞``）。"""
    return [s.strip() for s in re.split(r"[/\\>＞]+", path or "") if s.strip()]


def build_app_index(tree: dict) -> dict[str, dict]:
    """把目标 ``listAppTree`` 结果展平为 ``path -> {crc, type}`` 索引。

    遍历整棵树（含 ``children``），对每个带 ``value`` 的节点以 ``value`` 为 key 登记其
    ``crc`` / ``type``。同一 key 多次出现时以**首次**为准（树中路径应唯一）。供按引用
    路径 O(1) 查目标 crc。

    **URL 库能力子类**（``type=power``，即库节点下的 网站浏览/文件上传/其他上传/HTTPS）
    的 ``value`` 为 null、自身不带完整路径——策略详情里的能力级引用却是三段式
    ``访问网站/<库名>/<能力名>``。故对这类节点用「父节点 value + ``/`` + 子节点 name」
    合成 key 登记（crc 用子节点自己的，如 ``<父crc>_5``）；否则能力级引用在**任何**目标
    上都查不到、被误判为「目标缺失」而拒绝同步。
    """
    index: dict[str, dict] = {}

    def register(key: str, node: dict) -> None:
        if key not in index:
            index[key] = {
                "crc": "" if node.get("crc") is None else str(node.get("crc")),
                "type": "" if node.get("type") is None else str(node.get("type")),
            }

    def walk(nodes, parent_value: str = "") -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            value = node.get("value")
            if value:
                register(str(value), node)
            elif node.get("type") == "power" and node.get("name") and parent_value:
                register(f"{parent_value}/{node['name']}", node)
            walk(node.get("children"), str(value) if value else "")

    walk(tree.get("data"))
    return index


def build_remapped_rules(source_detail: dict, app_index: dict[str, dict]) -> tuple[list[dict], list[str]]:
    """从源策略解析规则，构造 :meth:`modify_policy_application` 所需的 ``rules``，crc 重映射为目标。

    **最大努力**：目标 app 树中查不到的引用直接从 ``rules`` 中**丢弃**（不臆造 crc、不阻断
    其余引用同步），并把其路径计入返回的缺失列表，供调用方告警。

    :returns: ``(rules, 缺失路径列表)``。``rules`` 每项形如
        ``{"name": <规则ID>, "action": <bool>, "refs": [{"path","type","crc","extra"}...]}``。
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
                missing.append(path)  # 目标无法解析 → 丢弃该引用，其余照常
                continue
            refs_out.append(
                {
                    "path": path,
                    "type": "" if ref.get("type") is None else str(ref.get("type")),
                    "crc": target["crc"],
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


def _match_custom_app(segs: list[str], source_custom_apps: set[str]) -> str | None:
    """从引用路径段中识别源自定义应用名。

    自定义应用在策略引用里可能以两种形态出现：
    - 独立段就是应用名（如 ``自定义/AIGC应用/全部`` → 段 ``AIGC应用``）；
    - 「自定义」前缀与应用名粘连成一段（如 ``自定义应用_AIGC应用/全部`` → 段
      ``自定义应用_AIGC应用``，应用名为其后缀 ``AIGC应用``）。

    为避免误匹配，后缀匹配仅在以「自定义」开头的段上进行，并取最长命中的源应用名。
    """
    # 1) 段精确等于源应用名
    for s in segs:
        if s in source_custom_apps:
            return s
    # 2)「自定义」前缀段：取以源应用名结尾的最长匹配
    for s in segs:
        if s.startswith("自定义"):
            candidates = [n for n in source_custom_apps if s.endswith(n)]
            if candidates:
                return max(candidates, key=len)
    return None


def classify_missing(
    missing_paths: list[str],
    source_custom_apps: set[str],
    source_custom_urls: set[str],
) -> tuple[list[dict], list[str]]:
    """把缺失引用分为「可自动创建（源上是自定义对象）」与「内置缺失（无法创建）」。

    - URL 引用路径形如 ``访问网站/<URL库名>/<子类>``，库名取第二段；该库在源为自定义则可创建。
    - 应用引用：见 :func:`_match_custom_app`（含「自定义」前缀粘连段的后缀匹配）。
    - 其余（内置应用 / 内置 URL 分类 / 源上不存在）归为内置缺失，**无法**自动创建。

    :returns: ``(creatable, builtin)``，``creatable`` 每项 ``{"path","kind","name"}``。
    """
    creatable: list[dict] = []
    builtin: list[str] = []
    for path in missing_paths:
        segs = _split_path(path)
        url_name = segs[1] if len(segs) > 1 and segs[0] == "访问网站" else None
        app_name = _match_custom_app(segs, source_custom_apps)
        if url_name and url_name in source_custom_urls:
            creatable.append({"path": path, "kind": "url", "name": url_name})
        elif app_name:
            creatable.append({"path": path, "kind": "app", "name": app_name})
        else:
            builtin.append(path)
    return creatable, builtin


def _target_custom_names(target_web) -> tuple[set[str], set[str]]:
    """目标实例已有的自定义应用名 / 自定义 URL 库名（用于判断 add 还是 modify）。"""
    apps = {s.get("rulename") for s in target_web.list_custom_rules() if s.get("rulename")}
    urls = {
        n.get("name")
        for n in target_web.list_url_groups().get("flat", [])
        if n.get("name") and not n.get("inside")
    }
    return apps, urls


def ensure_referenced_objects(
    source_web, target_web, creatable: list[dict], *, dry_run: bool
) -> tuple[list[dict], list[dict], list[dict]]:
    """把被引用的自定义应用 / URL 库从源同步到目标：目标已有同名 → **修改成一致**，否则**新增**。

    - 按 ``(kind, name)`` **去重**：同一对象被多个引用路径命中只处理一次（避免重复 add 报「名字已被使用」）。
    - **逐个独立**：单个失败不影响其余（best-effort），失败项单独收集。

    :returns: ``(created, updated, failed)``，每项含 ``{"name","kind"}``，``failed`` 另含 ``error``。
    """
    target_apps, target_urls = _target_custom_names(target_web)
    created: list[dict] = []
    updated: list[dict] = []
    failed: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in creatable:
        key = (item["kind"], item["name"])
        if key in seen:
            continue
        seen.add(key)
        name, kind = item["name"], item["kind"]
        try:
            if kind == "url":
                detail = source_web.get_url_group_detail(name)
                data = {
                    "id": "",
                    "name": name,
                    "depict": detail.get("depict", ""),
                    "url": detail.get("url_text", ""),
                    "keyword": detail.get("keyword", ""),
                }
                if name in target_urls:
                    target_web.update_url_group(data, dry_run=dry_run)
                    updated.append({"name": name, "kind": kind})
                else:
                    target_web.create_url_group(data, dry_run=dry_run)
                    created.append({"name": name, "kind": kind})
            else:
                detail = source_web.get_custom_rule_detail(name)
                form = customrule_form.parse_form(detail.get("summary", {}), detail.get("detail", {}))
                data = customrule_form.build_payload({**form, "rulename": name})
                if name in target_apps:
                    target_web.update_custom_rule(data, dry_run=dry_run)
                    updated.append({"name": name, "kind": kind})
                else:
                    target_web.create_custom_rule(data, dry_run=dry_run)
                    created.append({"name": name, "kind": kind})
        except Exception as exc:  # noqa: BLE001  单对象失败不拖垮整体
            failed.append({"name": name, "kind": kind, "error": str(exc)})
    return created, updated, failed


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
    app_index: dict[str, dict] | None = None,
    allow_degrade: bool = False,
) -> dict:
    """把源策略同步到目标实例：crc 重映射 + 自动建自定义引用 + 读-改-写 / 新建。

    **不抛异常**——逐步收集结果，任一子请求（建引用 / 写策略）失败都记入 ``details`` 并以
    ``ok=False`` 返回，便于上层把每个请求的成功 / 失败与详情展示给用户。

    **降级同步的处理（甲+乙）**：**无法解析的引用**——① **内置**对象在目标缺失（目标应用库版本较旧、
    无法创建），或 ② 自定义引用对象**创建失败**——若丢弃它写策略，会得到与源**不等价（降级）**的
    版本。为避免「悄悄改语义、还报成功」：

    - dry-run 始终预览（展示会跳过哪些引用、标 ``degraded``）；
    - **真实写入**：``allow_degrade=False``（默认）时**拒绝写入策略**、返回 ``refused=True`` / ``ok=False``。
      其中「内置缺失」在**创建任何对象之前**即拒绝（完全不改设备）；「自定义创建失败」时可能已建部分
      对象、保留在目标（消息会说明），但策略本身不写。``allow_degrade=True`` 时才写入降级版本、标
      ``degraded=True``。

    返回 outcome：``{"ok","degraded","refused","dry_run","payload","created","missing","details", ...}``。

    - ``degraded``：本次写入（或将写入）的策略因丢弃了无法解析的引用而与源不等价。
    - ``refused``：因存在无法解析的引用且未允许降级而**未写策略**（严格模式拦截）。
    - ``created``：本次（或 dry-run 预演）创建**或更新**的被引用自定义对象名（目标已有同名 →
      改成与源一致；同一对象被多个引用命中只处理一次）。
    - ``missing``：无法解析的引用（内置缺失 **或** 自定义创建失败）；降级写入时被跳过，拒绝时策略未写。
    - ``details``：每个子请求的成功 / 失败逐条记录。

    性能：每个目标只 ``list_app_tree`` 一次建索引（自动创建后会重取一次以解析新对象 crc）；
    批量同步可经 ``app_index`` 传入预建索引、复用同一目标的应用树（免每条策略重复拉取）；
    源自定义应用 / URL 名单由调用方预读一次传入，不在此重复拉取。
    """
    def _label(kind: str) -> str:
        return "URL库" if kind == "url" else "自定义应用"

    policy_name = source_detail.get("policy_name", "")
    details: list[str] = []
    index = app_index if app_index is not None else build_app_index(target_web.list_app_tree())
    rules, missing = build_remapped_rules(source_detail, index)

    ensured: list[str] = []  # 创建或更新成功的对象名（供上层计数）
    if missing and auto_create:
        creatable, builtin = classify_missing(missing, source_custom_apps, source_custom_urls)
        # 乙（修正 codex #1）：真实写入 + 存在会导致降级的内置缺失 + 未允许降级 → 在**创建任何引用
        # 对象、改动设备之前**就拒绝。否则会先把自定义引用对象建到目标、再拒绝写策略，导致「已拒绝、
        # 未写入」与真实行为不符（设备其实已被改）。builtin 由创建自定义对象无法补齐，故此刻即可判定。
        if builtin and not allow_degrade and not dry_run:
            for path in builtin:
                details.append(f"内置引用「{path}」目标缺失、无法创建")
            details.append(
                f"已拒绝写入：目标缺 {len(builtin)} 个内置引用，直接写会得到与源不等价（降级）的策略"
                "（如拒绝规则少挡了对象=安全缺口）。已阻止——**未创建任何对象、未改设备**。"
                "如确需写入降级版本，请勾选「允许降级同步」后重试。"
            )
            return {"ok": False, "degraded": True, "refused": True, "dry_run": dry_run, "payload": None,
                    "created": [], "missing": builtin, "details": details}
        if creatable:
            created, updated, failed = ensure_referenced_objects(
                source_web, target_web, creatable, dry_run=dry_run
            )
            ensured = [o["name"] for o in created] + [o["name"] for o in updated]
            for o in created:
                details.append(f"{'将创建' if dry_run else '已创建'}{_label(o['kind'])}「{o['name']}」")
            for o in updated:
                act = "将更新" if dry_run else "已更新"
                details.append(f"{act}{_label(o['kind'])}「{o['name']}」（目标已存在同名，改成与源一致）")
            for f in failed:
                details.append(f"处理{_label(f['kind'])}「{f['name']}」：失败 — {f['error']}")
        if dry_run:
            missing = builtin  # 预览：内置缺失将跳过（dry-run 不真的创建，无创建失败）
        else:
            index = build_app_index(target_web.list_app_tree())  # 重取，解析新建/更新对象的 crc
            rules, missing = build_remapped_rules(source_detail, index)
            # missing = 重映射后仍无法解析的引用 = 内置缺失（已在上方早退）+ **创建失败的自定义引用**。
            # 不再过滤掉创建失败的自定义——它们同样会从策略里被丢弃、导致降级（修正 codex 姊妹 bug）。
    # 丢弃无法解析的引用后 missing 即被跳过项；有跳过 = 写出的策略与源不等价（降级）。
    for path in missing:
        details.append(f"引用「{path}」目标缺失或创建失败：写策略会丢弃该引用")
    degraded = bool(missing)

    # 后置拒绝（修正 codex 姊妹 bug）：真实写入时，若因**自定义引用创建失败**仍有引用缺失 → 默认拒绝
    # 写策略（不写出缺引用的降级版本）。注意此刻可能已成功创建部分引用对象，保留在目标（会在消息里说明）。
    if degraded and not allow_degrade and not dry_run:
        note = f"（已成功创建/更新 {len(ensured)} 个引用对象、保留在目标）" if ensured else ""
        details.append(
            f"已拒绝写入策略：仍有 {len(missing)} 个引用无法解析（内置缺失或自定义对象创建失败），"
            f"直接写会得到与源不等价（降级）的策略{note}。如确需写入降级版本，请勾选「允许降级同步」后重试。"
        )
        return {"ok": False, "degraded": True, "refused": True, "dry_run": dry_run, "payload": None,
                "created": ensured, "missing": missing, "details": details}

    verb = "更新策略" if exists else "新建策略"
    try:
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
            # 走与单实例「新建策略」相同的已验证骨架（policy_template），而非源 listItem 原始对象，
            # 避免源对象多余/异构字段触发目标固件异常（曾导致 RemoteDisconnected 断连）。
            data = policy_template.build_policy_create_data(
                {
                    "name": policy_name,
                    "depict": str(source_detail.get("depict", "")),
                    "enable": bool(source_detail.get("enable", True)),
                    "include": bool(source_detail.get("application_include", True)),
                    "rules": [{"action": r["action"], "refs": r["refs"]} for r in rules],
                }
            )
            outcome = target_web.create_policy(data, dry_run=dry_run)
    except Exception as exc:  # noqa: BLE001  写策略失败：记录详情、以 ok=False 返回（不抛）
        details.append(f"{verb}：失败 — {exc}")
        return {"ok": False, "degraded": degraded, "refused": False, "dry_run": dry_run,
                "payload": None, "created": ensured, "missing": missing, "details": details}

    if degraded:
        details.append(
            f"⚠ 降级同步：已跳过 {len(missing)} 个无法解析的引用"
            "（内置缺失或自定义创建失败），写入的策略与源**不等价**。"
        )
    verb_state = "dry-run 预览" if outcome.get("dry_run") else "降级写入" if degraded else "成功"
    details.append(f"{verb}：{verb_state}")
    outcome = dict(outcome)
    outcome["ok"] = True
    outcome["degraded"] = degraded
    outcome["refused"] = False
    outcome["created"] = ensured
    outcome["missing"] = missing
    outcome["details"] = details
    return outcome
