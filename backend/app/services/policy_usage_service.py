#! /usr/bin/env python3
# coding=utf-8
"""策略引用校验：统计每条访问权限策略被多少用户引用，找出无人引用（创建后没人用）的策略。

设备没有「策略→用户」反查接口，但**用户列表里每个用户带 ``strategy``**（设备算好的生效
策略：组默认 + 用户添加 − 排除）。因此遍历组织树各组、收集所有用户的 ``strategy`` 取并集，
即「被引用的策略」；访问权限策略全集中不在并集里的，就是无人引用的。

部分固件（深圳 AC）对「完全继承所属组、无个人改动」的用户，用户行 ``strategy`` 只写占位符
``"与所属组相同"``，真正的策略清单在该组作为子组行返回的 ``strategy`` 上。故统计时会用
``组id → 策略`` 映射把占位符展开为所属组策略，否则会漏统计整组继承的策略、误报为无人引用。

性能：遍历组织树每个组各拉一次成员（并行、复用 :meth:`clone_session` 的独立 session），
结果按实例 TTL 缓存（:data:`app.services.analysis_cache.policy_usage_cache`），写操作后失效，
``force=True``（前端「重新分析」）强制重算。
"""

from __future__ import annotations

import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.db.models import Instance
from app.sangfor import session_pool
from app.services.analysis_cache import policy_usage_cache

# 线程池中每个 worker 独占的 Web 客户端克隆（独立 requests.Session）。
_worker_tls = threading.local()


def _init_worker(base) -> None:
    clone = getattr(base, "clone_session", None)
    _worker_tls.client = clone() if callable(clone) else base


# 用户「完全继承所属组、无个人改动」时，部分固件（深圳 AC）在用户行只写这个占位符，
# 真正的生效策略在该组作为子组行出现在其父组列表里（见 org_cgi.list_org_members）。
_INHERIT_PLACEHOLDER = "与所属组相同"


def _split_strategy(s: str) -> list[str]:
    """生效策略串（逗号分隔的策略名）→ 去空白的策略名列表。"""
    return [x.strip() for x in str(s or "").split(",") if x.strip()]


def _compute(instance: Instance) -> dict:
    """遍历组织树统计每条访问权限策略的引用用户数。

    处理「继承所属组」：用户 strategy 里出现占位符 ``"与所属组相同"`` 时，用**所属组**的
    生效策略（来自各组作为子组行返回的 strategy）展开替换，避免把整组继承的策略漏统计、
    误报为「无人引用」。占位符无法解析（如根组）时直接丢弃该 token，绝不当作真实策略计数。
    """
    web = session_pool.get_web_client(instance)
    web.login()  # 并发前先登录，避免多线程同时登录
    policies = web.list_policies().get("access_policies", []) or []
    org_nodes = web.list_org_tree()
    errors: list[str] = []

    def fetch(node: dict):
        try:
            return str(node["id"]), _worker_tls.client.list_org_members(node["id"]), None
        except Exception as exc:  # noqa: BLE001  单组失败不拖垮整体
            return str(node.get("id", "")), None, f"组「{node.get('name')}」: {exc}"

    usage: Counter[str] = Counter()  # 策略名 → 引用它的用户数
    total_users = 0
    if org_nodes:
        workers = min(settings.fetch_concurrency, max(1, len(org_nodes)))
        with ThreadPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(web,)) as pool:
            results = list(pool.map(fetch, org_nodes))

        # 第一遍：从各组返回的子组行建立「组id → 生效策略」映射（供展开继承占位）。
        group_strategy: dict[str, str] = {}
        member_lists: list[tuple[str, list[dict]]] = []
        for node_id, data, err in results:
            if err:
                errors.append(err)
                continue
            for sub in data.get("subgroups", []):
                sid = str(sub.get("id", "") or "")
                if sid:
                    group_strategy[sid] = sub.get("strategy", "") or ""
            member_lists.append((node_id, data.get("users", [])))

        # 第二遍：逐用户取生效策略，遇占位符则展开为其所属组（即查询用的 node_id）的策略。
        for node_id, users in member_lists:
            grp_policies = _split_strategy(group_strategy.get(node_id, ""))
            for user in users:
                total_users += 1
                effective: set[str] = set()
                for token in _split_strategy(user.get("strategy", "")):
                    if token == _INHERIT_PLACEHOLDER:
                        effective.update(grp_policies)  # 展开继承；解析不到则贡献空、不误计
                    else:
                        effective.add(token)
                for pname in effective:
                    usage[pname] += 1

    items: list[dict] = []
    for p in policies:
        name = p.get("name")
        cnt = usage.get(name, 0)
        items.append(
            {
                "name": name,
                "depict": p.get("depict", "") or "",
                "founder": p.get("founder", "") or "",
                "status": bool(p.get("status", True)),
                "order": int(p.get("order", 0) or 0),
                "user_count": cnt,
                "used": cnt > 0,
            }
        )
    # 排序：无人引用优先（醒目），其次按设备顺序号
    items.sort(key=lambda x: (x["used"], x["order"]))

    return {
        "policies": items,
        "total_policies": len(items),
        "unused_count": sum(1 for it in items if not it["used"]),
        "total_users": total_users,
        "errors": errors,
    }


def analyze_policy_usage(instance: Instance, *, force: bool = False) -> dict:
    """返回策略引用校验结果（带 TTL 缓存）。

    额外带 ``cached`` / ``cache_age_seconds`` 供前端展示「缓存 · N 分钟前」。
    """
    value, cached, age = policy_usage_cache.get_or_compute(
        instance.id, lambda: _compute(instance), force=force
    )
    return {**value, "cached": cached, "cache_age_seconds": age}
