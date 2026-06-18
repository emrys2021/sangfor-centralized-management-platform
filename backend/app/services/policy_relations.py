#! /usr/bin/env python3
# coding=utf-8
"""访问权限策略 ↔ 自定义应用 / URL 库 的关系构建。

包含：引用名称的归一化与多候选匹配（去「自定义应用_」前缀、按段匹配）、URL 库节点
判定（内置/自定义/叶子）、以及「策略 → 应用 / URL 库」连线构建（连线动作按
策略内**首条命中规则**着色）与 URL 库内容摘要。被 :mod:`app.services.customrule_service`
的 ``analyze_overlaps`` 复用，函数均以 ``web`` 客户端为入参、不直接依赖会话池。
"""
from __future__ import annotations

import re
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

# 线程池中每个 worker 独占的 Web 客户端克隆（独立 requests.Session）。
_worker_tls = threading.local()


def _init_worker(base) -> None:
    """ThreadPool 初始化器：为本 worker 线程绑定一个独立 session 的客户端克隆。

    不支持克隆协议的对象（如测试替身）回退为直接共享 base。
    """
    clone = getattr(base, "clone_session", None)
    _worker_tls.client = clone() if callable(clone) else base


def _normalize_ref(value: str | None) -> str:
    """归一化 AC 报文里的应用引用路径，便于跨固件字段格式匹配。"""
    text = "" if value is None else str(value).strip()
    text = text.replace("\\", "/").replace("＞", "/").replace(">", "/")
    text = re.sub(r"\s*/\s*", "/", text)
    return re.sub(r"\s+", " ", text).strip()


def _strip_custom_prefix(value: str | None) -> str:
    value = _normalize_ref(value)
    for pre in ("自定义应用", "自定义URL", "自定义 URL", "URL库", "URL 库", "访问网站", "自定义"):
        if value.startswith(pre):
            return value[len(pre):].lstrip("_-/ ").strip()
    return value


def _name_candidates(value: str | None) -> set[str]:
    """从完整路径、路径段和去前缀名称中生成候选应用名。"""
    value = _normalize_ref(value)
    if not value:
        return set()
    candidates = {value, _strip_custom_prefix(value)}
    for seg in re.split(r"[/]+", value):
        seg = seg.strip()
        if seg:
            candidates.add(seg)
            candidates.add(_strip_custom_prefix(seg))
    return {c for c in candidates if c}


def _match_key(value: str | None) -> str:
    return _strip_custom_prefix(value).casefold()


def _unique_name_map(items: list[dict], *, primary_field: str, match_fields: tuple[str, ...]) -> dict[str, str]:
    """把设备返回的名称、路径、描述等候选值映射到唯一对象名。"""
    key_matches: dict[str, set[str]] = defaultdict(set)
    for item in items:
        primary = item.get(primary_field)
        if not primary:
            continue
        primary = str(primary)
        for field in match_fields:
            for cand in _name_candidates(item.get(field)):
                key_matches[_match_key(cand)].add(primary)
    return {key: next(iter(names)) for key, names in key_matches.items() if len(names) == 1}


def _is_leaf_url_node(node: dict) -> bool:
    leaf = str(node.get("leaf", "")).strip().casefold()
    if leaf in {"1", "true", "yes"}:
        return True
    if leaf in {"0", "false", "no"}:
        return False
    return True


def _url_is_builtin(node: dict) -> bool:
    """URL 库节点是否为深信服内置（``inside`` 为真）。"""
    v = node.get("inside")
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    return str(v).strip().casefold() in {"1", "true", "yes"}


def _is_custom_url_node(node: dict) -> bool:
    """自定义 URL 库 = 非内置（``inside`` 为假）。

    设备用 ``inside`` 字段区分内置/自定义（与导出脚本、前端「自定义 URL」页一致）。
    自定义库由管理员自行命名、并不带「自定义」前缀，故必须按 ``inside`` 判定，
    而不能靠名称里有没有「自定义」字样。
    """
    return not _url_is_builtin(node)


def _list_url_nodes(web, errors: list[str]) -> list[dict]:
    try:
        nodes = web.list_url_groups().get("flat", []) or []
        return [node for node in nodes if _is_custom_url_node(node)]
    except Exception as exc:  # noqa: BLE001
        errors.append(f"URL库列表: {exc}")
        return []


def _match_named_ref(value: str | None, keys: dict[str, str]) -> str | None:
    return next((keys[key] for key in (_match_key(c) for c in _name_candidates(value)) if key in keys), None)


def _build_policy_relations(
    web,
    rules: list[dict],
    errors: list[str],
) -> tuple[list[dict], list[dict], list[str], list[dict]]:
    """构建访问权限策略到自定义应用、URL 库的引用关系。

    策略规则里以 path 形式引用自定义应用（如「自定义应用_xxx」或带层级），这里把每个
    自定义引用的各级名称去前缀后，与自定义应用的 规则名/应用名/应用类型 做匹配；
    URL 库同理，使用 URL 库名、完整路径和描述做匹配。

    返回 (应用引用关系, URL引用关系, 全部访问权限策略名列表, URL库节点列表)。策略清单
    用于前端展示完整筛选项：只引用内置对象、或匹配不上的策略仍应出现在清单中。
    """
    app_keys = _unique_name_map(rules, primary_field="rulename", match_fields=("rulename", "appname", "apptype"))
    url_nodes = _list_url_nodes(web, errors)
    url_match_nodes = [node for node in url_nodes if _is_leaf_url_node(node)] or url_nodes
    url_keys = _unique_name_map(
        url_match_nodes, primary_field="name", match_fields=("id", "name", "full_path", "depict")
    )

    try:
        access_policies = web.list_policies().get("access_policies", []) or []
    except Exception as exc:  # noqa: BLE001
        errors.append(f"策略列表: {exc}")
        return [], [], [], url_nodes

    policy_names = sorted({p.get("name") for p in access_policies if p.get("name")})

    def fetch_policy(pinfo: dict):
        pname = pinfo.get("name")
        try:
            # 用本线程独占的 session 克隆，避免并发共享同一 requests.Session
            return pname, _worker_tls.client.get_policy_detail(pname), None
        except Exception as exc:  # noqa: BLE001
            return pname, None, str(exc)

    app_link_map: dict[tuple[str, str], dict] = {}
    url_link_map: dict[tuple[str, str], dict] = {}
    if access_policies:
        workers = min(8, max(1, len(access_policies)))
        with ThreadPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(web,)) as pool:
            results = list(pool.map(fetch_policy, access_policies))
        for pname, detail, err in results:
            if err or detail is None:
                errors.append(f"策略 {pname}: {err}")
                continue
            # 规则在策略内自上而下「首条命中为准」：同一对象被多条规则引用时，
            # 连线动作以**第一条**引用它的规则为准。detail["rules"] 已是设备顺序，
            # 故用 setdefault 只在首次出现时记录 action，后续规则不覆盖。
            for rule in detail.get("rules", []):
                raction = str(rule.get("action") or "unknown")
                for app in rule.get("apps", []):
                    if not app.get("custom"):
                        continue
                    matched = _match_named_ref(app.get("path", ""), app_keys)
                    if not matched:
                        continue
                    app_link_map.setdefault(
                        (pname, matched), {"policy": pname, "app": matched, "action": raction}
                    )
                for url in rule.get("urls", []):
                    matched = _match_named_ref(url.get("name", ""), url_keys)
                    if not matched:
                        continue
                    link = url_link_map.setdefault(
                        (pname, matched),
                        {"policy": pname, "url": matched, "rules": [], "action": raction},
                    )
                    # rules 仍累积全部引用规则（供 tooltip 展示），但 action 以首条为准
                    rule_ref = {
                        "index": rule.get("index"),
                        "name": rule.get("name") or "",
                    }
                    if rule_ref not in link["rules"]:
                        link["rules"].append(rule_ref)

    app_links = sorted(app_link_map.values(), key=lambda item: (item["policy"], item["app"]))
    url_links = sorted(url_link_map.values(), key=lambda item: (item["policy"], item["url"]))
    return app_links, url_links, policy_names, url_nodes


def _build_policy_links(web, rules: list[dict], errors: list[str]) -> tuple[list[dict], list[str]]:
    """兼容旧测试和调用方：仅返回「策略 → 自定义应用」关系。"""
    app_links, _, policy_names, _ = _build_policy_relations(web, rules, errors)
    return app_links, policy_names


def _build_url_summaries(web, url_nodes: list[dict], errors: list[str]) -> list[dict]:
    nodes = [node for node in url_nodes if _is_leaf_url_node(node)] or url_nodes
    names = sorted({str(node.get("name")) for node in nodes if node.get("name")})

    def fetch_url_group(name: str):
        try:
            urls = list(dict.fromkeys(web.get_url_group_content(name)))
            return {"name": name, "url_count": len(urls), "urls": urls}, None
        except Exception as exc:  # noqa: BLE001
            return {"name": name, "url_count": 0, "urls": []}, str(exc)

    if not names:
        return []

    workers = min(8, max(1, len(names)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(fetch_url_group, names))

    summaries = []
    for summary, err in results:
        if err:
            errors.append(f"URL库 {summary['name']}: {err}")
        summaries.append(summary)
    return summaries


def _ensure_linked_url_summaries(urls: list[dict], policy_url_links: list[dict]) -> list[dict]:
    """确保每条「策略 -> URL 库」关系的目标 URL 库都能进入前端可选列表。

    URL 库内容拉取失败时，策略引用关系本身仍然是有效数据；如果这里不补空 summary，
    前端会因为目标 URL 库不在 ``urls`` 中而把策略连线过滤掉。
    """
    by_name = {str(item.get("name")): item for item in urls if item.get("name")}
    for link in policy_url_links:
        name = str(link.get("url") or "").strip()
        if name and name not in by_name:
            by_name[name] = {"name": name, "url_count": 0, "urls": []}
    return sorted(by_name.values(), key=lambda item: str(item.get("name", "")))
