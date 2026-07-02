#! /usr/bin/env python3
# coding=utf-8
"""功能 1：自定义应用 / 规则（customrule）服务。

读：列表、详情（含解析后的表单字段 ``form``）。
写：新增/编辑接收前端表单字段，经 :mod:`app.services.customrule_form` 构造为 AC 报文。
"""

from __future__ import annotations

import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session

from app.config import settings
from app.core import audit
from app.core.auth import CurrentUser
from app.db.models import Instance
from app.sangfor import session_pool
from app.services import customrule_form
from app.services.analysis_cache import analysis_cache, invalidate_instance
from app.services.policy_relations import (
    _build_policy_relations,
    _build_url_summaries,
    _ensure_linked_url_summaries,
)

# 线程池中每个 worker 独占的 Web 客户端克隆（独立 requests.Session）。
_worker_tls = threading.local()


def _init_worker(base) -> None:
    """ThreadPool 初始化器：为本 worker 线程绑定一个独立 session 的客户端克隆。

    不支持克隆协议的对象（如测试替身）回退为直接共享 base。
    """
    clone = getattr(base, "clone_session", None)
    _worker_tls.client = clone() if callable(clone) else base


def list_rules(instance: Instance) -> list[dict]:
    return session_pool.get_web_client(instance).list_custom_rules()


def get_rule(instance: Instance, rule_name: str) -> dict:
    detail = session_pool.get_web_client(instance).get_custom_rule_detail(rule_name)
    detail["form"] = customrule_form.parse_form(detail.get("summary", {}), detail.get("detail", {}))
    return detail


def _audit(db, user, instance, action, name, result, before=None, message: str = ""):
    if result.get("dry_run"):
        message = f"[预览] {message}" if message else "dry_run"
    audit.record(
        db,
        actor=user.username,
        object_type="customrule",
        action=action,
        object_name=name,
        instance_id=instance.id,
        instance_name=instance.name,
        message=message,
        before=before,
        after=result.get("payload") or result.get("result"),
    )


def _lines(text: str) -> list[str]:
    return [s.strip() for s in str(text or "").replace("\r\n", "\n").split("\n") if s.strip()]


def _rule_message(verb: str, name: str, form: dict) -> str:
    """构造带内容的审计摘要：含 IP / 域名，便于直观查看与按 IP/域名检索。"""
    parts = [f"{verb}自定义应用「{name}」"]
    bits: list[str] = []
    if form.get("ip_mode") == "all":
        bits.append("所有 IP")
    else:
        ips = _lines(form.get("ip_range", ""))
        if ips:
            bits.append(f"IP {len(ips)} 条：{'、'.join(ips[:6])}{' 等' if len(ips) > 6 else ''}")
    domains = _lines(form.get("domain", ""))
    if domains:
        bits.append(f"域名 {len(domains)} 条：{'、'.join(domains[:6])}{' 等' if len(domains) > 6 else ''}")
    if bits:
        parts.append("（" + "；".join(bits) + "）")
    return "".join(parts)


def create_rule(db: Session, user: CurrentUser, instance: Instance, form: dict, dry_run: bool):
    web = session_pool.get_web_client(instance)
    payload = customrule_form.build_payload(form)
    result = web.create_custom_rule(payload, dry_run=dry_run)
    name = form.get("rulename", "")
    _audit(
        db, user, instance, "dry_run" if dry_run else "create", name, result,
        message=_rule_message("新增", name, form),
    )
    if not dry_run:
        invalidate_instance(instance.id)  # 真实写入后让该实例的分析缓存失效
    return result


def update_rule(
    db: Session, user: CurrentUser, instance: Instance, rule_name: str, form: dict, dry_run: bool
):
    web = session_pool.get_web_client(instance)
    before = None
    try:
        before = web.get_custom_rule_detail(rule_name)
    except Exception:  # noqa: BLE001
        pass
    payload = customrule_form.build_payload({**form, "rulename": rule_name})
    result = web.update_custom_rule(payload, dry_run=dry_run)
    _audit(
        db, user, instance, "dry_run" if dry_run else "update", rule_name, result, before,
        message=_rule_message("编辑", rule_name, form),
    )
    if not dry_run:
        invalidate_instance(instance.id)
    return result


def delete_rule(db: Session, user: CurrentUser, instance: Instance, rule_name: str, dry_run: bool):
    web = session_pool.get_web_client(instance)
    result = web.delete_custom_rule(rule_name, dry_run=dry_run)
    _audit(
        db, user, instance, "dry_run" if dry_run else "delete", rule_name, result,
        message=f"删除自定义应用「{rule_name}」",
    )
    if not dry_run:
        invalidate_instance(instance.id)
    return result


def _port_text(form: dict) -> str:
    return "所有端口" if form.get("port_mode") == "all" else (form.get("port_range") or "指定端口")


def analyze_overlaps(instance: Instance, *, force: bool = False) -> dict:
    """数据校验分析（带服务端 TTL 缓存）。

    命中缓存时直接返回上次结果、不访问设备；``force=True``（前端「重新分析」）绕过缓存
    强制重算。返回值额外带 ``cached``（本次是否来自缓存）与 ``cache_age_seconds``（缓存
    已存在秒数），供前端展示「缓存 · N 分钟前」。缓存逻辑见 :mod:`app.services.analysis_cache`。
    """
    value, cached, age = analysis_cache.get_or_compute(
        instance.id, lambda: _compute_analysis(instance), force=force
    )
    # 不修改被缓存的原对象，叠加缓存元信息后返回
    return {**value, "cached": cached, "cache_age_seconds": age}


def _compute_analysis(instance: Instance) -> dict:
    """遍历所有自定义应用，统计哪些 IP / 域名被多个应用引用。

    返回供前端可视化（桑基图）与冲突表使用的结构。同时计算「强冲突」：同一资源被
    ≥2 个应用引用，且其中存在「数据包方向 + 三层协议 + 端口」也相同的应用对——这种
    报文可能被多个自定义应用同时命中，配置上需重点关注。
    """
    web = session_pool.get_web_client(instance)
    web.login()  # 并发拉取前先登录，避免多线程同时登录
    rules = [s for s in web.list_custom_rules() if s.get("rulename")]

    apps: list[dict] = []
    ip_map: dict[str, list[dict]] = defaultdict(list)
    domain_map: dict[str, list[dict]] = defaultdict(list)
    errors: list[str] = []

    def fetch(summary: dict):
        name = summary.get("rulename")
        try:
            # 用本线程独占的 session 克隆，避免并发共享同一 requests.Session
            return name, _worker_tls.client.get_custom_rule_detail(name, summary=summary), None
        except Exception as exc:  # noqa: BLE001
            return name, None, str(exc)

    # 每个自定义应用需一次 listItem 调用，应用多时串行很慢，用线程池并发拉取。
    # 每个 worker 用 web.clone_session() 的独立 session，规避 requests.Session 非线程安全。
    max_workers = min(settings.fetch_concurrency, max(1, len(rules)))
    with ThreadPoolExecutor(max_workers=max_workers, initializer=_init_worker, initargs=(web,)) as pool:
        results = list(pool.map(fetch, rules))

    for name, detail, error in results:
        if error or detail is None:
            errors.append(f"{name}: {error}")
            continue
        form = customrule_form.parse_form(detail.get("summary", {}), detail.get("detail", {}))
        # 同一应用内部去重，避免重复条目把"被引用次数"刷高造成误判
        ip_list = list(dict.fromkeys(detail.get("ip_list", []) or []))
        domains = list(dict.fromkeys(d.strip() for d in (form.get("domain") or "").splitlines() if d.strip()))
        port_text = _port_text(form)

        ref = {
            "name": name,
            "direction": form["direction"],
            "protocol": form["protocol"],
            "protocol_num": form.get("protocol_num", ""),
            "port": port_text,
        }
        apps.append(
            {
                "name": name,
                "direction": form["direction"],
                "protocol": form["protocol"],
                "port": port_text,
                "ip_count": len(ip_list),
                "domain_count": len(domains),
                "ips": ip_list,
                "domains": domains,
            }
        )
        for ip in ip_list:
            ip_map[ip].append(ref)
        for d in domains:
            domain_map[d].append(ref)

    def build_overlaps(mapping: dict[str, list[dict]], rtype: str) -> list[dict]:
        out = []
        for value, refs in mapping.items():
            # 按应用名去重，确保"次数/强冲突"基于不同的应用而非引用条数
            unique = list({r["name"]: r for r in refs}.values())
            if len(unique) < 2:
                continue
            # 强冲突：存在方向+协议+端口完全相同的两个（不同）应用
            signatures = [(r["direction"], r["protocol"], r["port"]) for r in unique]
            conflict = len(set(signatures)) < len(signatures)
            out.append(
                {
                    "value": value,
                    "type": rtype,
                    "count": len(unique),
                    "apps": unique,
                    "conflict": conflict,
                }
            )
        out.sort(key=lambda x: (-x["count"], x["value"]))
        return out

    # 策略关系为附加层，失败不应影响已算好的重叠结果
    try:
        policy_links, policy_url_links, policy_names, url_nodes = _build_policy_relations(web, rules, errors)
    except Exception as exc:  # noqa: BLE001
        policy_links, policy_url_links, policy_names, url_nodes = [], [], [], []
        errors.append(f"策略关系分析失败: {exc}")

    try:
        urls = _build_url_summaries(web, url_nodes, errors)
    except Exception as exc:  # noqa: BLE001
        urls = []
        errors.append(f"URL库内容分析失败: {exc}")
    urls = _ensure_linked_url_summaries(urls, policy_url_links)

    return {
        "total_apps": len(rules),
        "analyzed_apps": len(apps),
        "ip_overlaps": build_overlaps(ip_map, "ip"),
        "domain_overlaps": build_overlaps(domain_map, "domain"),
        "apps": apps,
        "urls": urls,
        "policies": policy_names,
        "policy_links": policy_links,
        "policy_url_links": policy_url_links,
        "policy_count": len(policy_names),
        "url_count": len(urls),
        "errors": errors,
    }
