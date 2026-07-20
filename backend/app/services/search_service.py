#! /usr/bin/env python3
# coding=utf-8
"""全局搜索：按域名 / IP 反查引用它的对象，或按名称查对象。

设备侧没有「按域名/IP 反查」接口，这里把各对象的可匹配条目汇总成一份**索引**，再在内存里做
两类匹配（同一个查询同时跑，结果分区返回）：

**一、按内容**（智能匹配）

- 索引内容：每个自定义应用的 IP 范围 + 域名；每个 URL 库（自定义 / 内置）的 URL/IP/域名条目。
- 智能匹配（与单纯子串不同）：
  - 域名：理解通配符与子域归属——条目 ``*.deepin.org`` 命中查询 ``www.deepin.org``；查询
    ``deepin.org`` 也能命中子域条目 ``a.deepin.org``（按标签边界双向判定，避免 ``notdeepin.org``
    这类误命中）。
  - IP：理解单 IP / CIDR 网段 / ``a-b`` 范围的**区间重叠**——查询某 IP 命中包含它的网段条目，
    反之查询网段也命中其中的 IP 条目。

**二、按名称**（子串匹配，见 :func:`name_match`）

- 覆盖自定义应用 / URL 库 / **访问权限策略**的名称——用户常记得的是「钉钉白名单」这类名字。
- 策略**只**参与名称匹配：其内容是对应用/URL 的引用而非 IP/域名条目，不纳入内容索引；
  故只需一次 list、无须逐条拉详情。

构建索引需逐个 listItem（应用详情、各 URL 库内容），开销大，故按实例做 TTL 缓存
（:data:`app.services.analysis_cache.search_cache`），写操作后随分析缓存一并失效；
``force=True``（前端「重建索引」）绕过缓存强制重建。并发拉取复用 :meth:`clone_session`
的独立 session，规避 ``requests.Session`` 非线程安全。
"""

from __future__ import annotations

import ipaddress
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.db.models import Instance
from app.sangfor import session_pool
from app.services import customrule_form
from app.services.analysis_cache import search_cache

# 线程池中每个 worker 独占的 Web 客户端克隆（独立 requests.Session）。
_worker_tls = threading.local()


def _init_worker(base) -> None:
    clone = getattr(base, "clone_session", None)
    _worker_tls.client = clone() if callable(clone) else base


# --------------------------------------------------------------------------- #
# 智能匹配
# --------------------------------------------------------------------------- #
def _ip_token_to_range(token: str) -> tuple[int, int]:
    """单 IP / CIDR / ``a-b`` 范围 → ``(start_int, end_int)``；非 IP 形态抛 ValueError。"""
    t = token.strip()
    if "-" in t and "/" not in t:
        a, b = t.split("-", 1)
        lo, hi = int(ipaddress.ip_address(a.strip())), int(ipaddress.ip_address(b.strip()))
        return (min(lo, hi), max(lo, hi))
    if "/" in t:
        net = ipaddress.ip_network(t, strict=False)
        return (int(net.network_address), int(net.broadcast_address))
    ip = int(ipaddress.ip_address(t))
    return (ip, ip)


def looks_like_ip(token: str) -> bool:
    """token 是否可解析为单 IP / CIDR / IP 范围。"""
    try:
        _ip_token_to_range(token)
        return True
    except ValueError:
        return False


def _ip_overlaps(entry: str, query: str) -> bool:
    """两个 IP 形态条目的区间是否重叠（IP/CIDR/范围皆可）。"""
    try:
        es, ee = _ip_token_to_range(entry)
        qs, qe = _ip_token_to_range(query)
    except ValueError:
        return False
    return es <= qe and qs <= ee


def _norm_domain(s: str) -> str:
    """域名规范化：去协议头、路径、端口，小写，去首尾点。"""
    s = s.strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.\-]*://", "", s)  # 去 scheme
    s = s.split("/", 1)[0].split(":", 1)[0]  # 去路径 / 端口
    return s.strip(".")


def _domain_covers(base: str, name: str) -> bool:
    """``base`` 域是否覆盖 ``name``（相等或 ``name`` 是其子域，按标签边界判定）。"""
    return bool(base) and (name == base or name.endswith("." + base))


def _domain_match(entry: str, query: str) -> bool:
    """域名智能匹配：处理通配符 ``*.`` 与双向子域归属。"""
    e, q = _norm_domain(entry), _norm_domain(query)
    if not e or not q:
        return False
    eb = e[2:] if e.startswith("*.") else e  # 通配符基域
    qb = q[2:] if q.startswith("*.") else q
    return _domain_covers(eb, qb) or _domain_covers(qb, eb)


def _match_tokens(query: str, tokens: list[str], query_is_ip: bool) -> list[str]:
    """返回 ``tokens`` 中命中查询的条目（按查询类型只比对同类条目）。"""
    out: list[str] = []
    for raw in tokens:
        t = (raw or "").strip()
        if not t:
            continue
        if query_is_ip:
            if looks_like_ip(t) and _ip_overlaps(t, query):
                out.append(t)
        elif not looks_like_ip(t) and _domain_match(t, query):
            out.append(t)
    return out


def name_match(name: str, query: str) -> bool:
    """对象**名称**匹配：忽略大小写与首尾空白的子串包含。

    与按内容（IP/域名）的智能匹配互补——用户常记得的是「钉钉白名单」这类名字而非具体条目。
    名称是自由文本（中英文混排），不做域名/IP 的语义解析，子串包含最贴合直觉。
    """
    n, q = (name or "").strip().lower(), (query or "").strip().lower()
    return bool(n and q and q in n)


# --------------------------------------------------------------------------- #
# 索引构建（带 TTL 缓存）
# --------------------------------------------------------------------------- #
def _build_index(instance: Instance) -> dict:
    """汇总该实例所有自定义应用与 URL 库的可匹配条目（并发拉取），外加各对象名称。

    名称索引额外含**访问权限策略**：策略只按名称参与搜索（其内容是对应用/URL 的引用，
    不是 IP/域名条目），故只需一次 list、无须逐条拉详情，开销可忽略。
    """
    web = session_pool.get_web_client(instance)
    web.login()  # 并发前先登录，避免多线程同时登录

    rules = [s for s in web.list_custom_rules() if s.get("rulename")]
    flat = web.list_url_groups().get("flat", []) or []
    # 优先取叶子节点（实际 URL 库）；leaf 标记不可靠时回退取全部有名节点
    leaves = [n for n in flat if n.get("name") and n.get("leaf")]
    if not leaves:
        leaves = [n for n in flat if n.get("name")]
    # 同名去重，避免重复 listItem
    seen: set[str] = set()
    url_nodes = []
    for n in leaves:
        if n["name"] not in seen:
            seen.add(n["name"])
            url_nodes.append(n)

    errors: list[str] = []

    # 策略：只取名单（名称 + 描述）供名称搜索；读失败不影响其余索引
    policies_idx: list[dict] = []
    try:
        for p in web.list_policies().get("access_policies", []) or []:
            if p.get("name"):
                policies_idx.append({"name": str(p["name"]), "depict": str(p.get("depict") or "")})
    except Exception as exc:  # noqa: BLE001
        errors.append(f"访问权限策略名单: {exc}")

    def fetch(item: tuple[str, dict]):
        kind, payload = item
        client = _worker_tls.client
        try:
            if kind == "app":
                name = payload.get("rulename")
                detail = client.get_custom_rule_detail(name, summary=payload)
                form = customrule_form.parse_form(detail.get("summary", {}), detail.get("detail", {}))
                domains = [d.strip() for d in (form.get("domain") or "").splitlines() if d.strip()]
                return ("app", {
                    "name": name, "depict": str(payload.get("depict") or ""),
                    "ips": detail.get("ip_list", []) or [], "domains": domains,
                }, None)
            name = payload["name"]
            entries = client.get_url_group_content(name)
            return ("url", {
                "name": name, "depict": str(payload.get("depict") or ""),
                "inside": bool(payload.get("inside")), "entries": entries,
            }, None)
        except Exception as exc:  # noqa: BLE001  单对象失败不拖垮整体
            label = payload.get("rulename") or payload.get("name")
            return (kind, None, f"{label}: {exc}")

    tasks = [("app", r) for r in rules] + [("url", n) for n in url_nodes]
    apps_idx: list[dict] = []
    urls_idx: list[dict] = []
    if tasks:
        max_workers = min(settings.fetch_concurrency, max(1, len(tasks)))
        with ThreadPoolExecutor(max_workers=max_workers, initializer=_init_worker, initargs=(web,)) as pool:
            for kind, data, error in pool.map(fetch, tasks):
                if error or data is None:
                    errors.append(error or "未知错误")
                elif kind == "app":
                    apps_idx.append(data)
                else:
                    urls_idx.append(data)

    return {"apps": apps_idx, "urls": urls_idx, "policies": policies_idx, "errors": errors}


def search(instance: Instance, query: str, *, force: bool = False) -> dict:
    """在该实例的索引上做两类匹配，返回分组命中结果。

    - **按内容**：域名 / IP 智能匹配自定义应用的 IP·域名、各 URL 库的条目（见模块 docstring）。
    - **按名称**：对象名的子串匹配，覆盖自定义应用 / URL 库 / **访问权限策略**——用户常记得的是
      「钉钉白名单」这类名字而非具体条目。两类结果同时返回，前端分区展示。

    返回额外带 ``cached`` / ``cache_age_seconds`` 供前端展示「索引 · N 分钟前」。
    """
    q = (query or "").strip()
    index, cached, age = search_cache.get_or_compute(
        instance.id, lambda: _build_index(instance), force=force
    )
    query_is_ip = looks_like_ip(q) if q else False

    apps: list[dict] = []
    custom_urls: list[dict] = []
    builtin_urls: list[dict] = []
    name_hits: list[dict] = []
    if q:
        for app in index["apps"]:
            tokens = app["ips"] if query_is_ip else app["domains"]
            matches = _match_tokens(q, tokens, query_is_ip)
            if matches:
                apps.append({"name": app["name"], "matches": matches})
            if name_match(app["name"], q):
                name_hits.append({
                    "kind": "customrule", "name": app["name"], "depict": app.get("depict", ""),
                })
        for u in index["urls"]:
            matches = _match_tokens(q, u["entries"], query_is_ip)
            if matches:
                hit = {"name": u["name"], "matches": matches}
                (builtin_urls if u["inside"] else custom_urls).append(hit)
            if name_match(u["name"], q):
                name_hits.append({
                    "kind": "url", "name": u["name"], "depict": u.get("depict", ""),
                    "builtin": bool(u["inside"]),
                })
        for p in index.get("policies", []):
            if name_match(p["name"], q):
                name_hits.append({"kind": "policy", "name": p["name"], "depict": p.get("depict", "")})

    return {
        "query": q,
        "query_type": "ip" if query_is_ip else "domain",
        "apps": apps,
        "custom_urls": custom_urls,
        "builtin_urls": builtin_urls,
        "name_hits": name_hits,
        "total_hits": len(apps) + len(custom_urls) + len(builtin_urls) + len(name_hits),
        "indexed_apps": len(index["apps"]),
        "indexed_url_groups": len(index["urls"]),
        "indexed_policies": len(index.get("policies", [])),
        "errors": index["errors"],
        "cached": cached,
        "cache_age_seconds": age,
    }
