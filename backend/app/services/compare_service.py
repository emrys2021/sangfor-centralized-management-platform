#! /usr/bin/env python3
# coding=utf-8
"""跨实例「全量对比」：只读地比对两个实例某类对象的**全集**与**逐对象内容**。

对每个对象名做四分类（外加读取失败的 ``error``）：

- ``source_only``  仅源有 —— 同步会新增到目标；
- ``target_only``  仅目标有 —— 源没有；
- ``identical``    两边都有且内容一致；
- ``different``    两边都有但内容不一致（带字段级差异）。

复用同步服务的快照与字段差异逻辑（:func:`sync_service._build_snapshot` /
:func:`sync_service._diff_snapshots` / :func:`sync_service._list_object_names`），但**不写设备**。

策略特殊处理（见 :func:`_policy_equal`）：**只覆盖 应用控制 / 端口控制 / 代理控制 三段**
外加策略启用状态（其余段——Web 关键字/文件类型过滤、邮件、QQ、SaaS 等——不纳入对比）。
每段先比 ``include`` 开关；开关为 True 才比该段内容（应用控制没启用就不比规则，与设备语义
一致）。规则按**位置**对位、忽略跨实例必然不同的 rule_id/crc（否则会把「内容相同」误判为
不一致）；应用规则含动作(放行/拒绝)。``different`` 时用字段级 diff 携带两边完整快照，供前端
逐段展开明细。

性能：每个实例的「该类全部对象快照」并行拉取（复用 :meth:`clone_session` 的独立 session），
并按 ``(实例 id, 对象类型)`` TTL 缓存（:data:`app.services.analysis_cache.snapshot_cache`）；
写操作经 :func:`app.services.analysis_cache.invalidate_instance` 失效，比较同一源到多个目标时
源快照只拉一次。报文精简：``identical`` 只回对象名、不带快照。
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import Instance
from app.sangfor import session_pool
from app.sangfor.web_client import SangforWebClient
from app.schemas.sync import (
    BatchCompareResult,
    CompareItem,
    CompareTargetResult,
)
from app.services import instance_service, sync_service
from app.services.analysis_cache import snapshot_cache

# 线程池中每个 worker 独占的 Web 客户端克隆（独立 requests.Session）。
_snap_tls = threading.local()


def _init_snap_worker(base: SangforWebClient) -> None:
    clone = getattr(base, "clone_session", None)
    _snap_tls.client = clone() if callable(clone) else base


def _fetch_index(web: SangforWebClient, object_type: str, names: list[str] | None = None) -> dict:
    """并行拉取某实例该类对象的规范化快照。

    ``names`` 不给时取**全部对象**（先 list 名单再逐个拉详情）；给定时视为「已选子集」——
    跳过全量 list，直接按这些名字并行拉详情，选得越少越快。子集场景下某个名字其实不存在于
    该实例，``_build_snapshot`` 会返回 ``not_found``，从返回的 ``names`` 里剔除（其余逻辑
    与全量一致，不影响下游按存在与否分类）。

    返回 ``{"names": [名称...], "snaps": {名称: (status, 快照, 错误)}}``。
    """
    if names is None:
        names = sync_service._list_object_names(web, object_type)
        if not names:
            return {"names": [], "snaps": {}}
        web.login()  # 并发前先登录，避免多线程同时登录

        def one(name: str):
            return name, sync_service._build_snapshot(_snap_tls.client, object_type, name)

        workers = min(settings.fetch_concurrency, max(1, len(names)))
        with ThreadPoolExecutor(max_workers=workers, initializer=_init_snap_worker, initargs=(web,)) as pool:
            snaps = dict(pool.map(one, names))
        return {"names": names, "snaps": snaps}

    if not names:
        return {"names": [], "snaps": {}}
    web.login()

    def one_subset(name: str):
        return name, sync_service._build_snapshot(_snap_tls.client, object_type, name)

    workers = min(settings.fetch_concurrency, max(1, len(names)))
    with ThreadPoolExecutor(max_workers=workers, initializer=_init_snap_worker, initargs=(web,)) as pool:
        snaps = dict(pool.map(one_subset, names))
    resolved_names = [n for n in names if snaps[n][0] != "not_found"]
    return {"names": resolved_names, "snaps": snaps}


def _index(instance: Instance, object_type: str, *, force: bool = False) -> tuple[dict, bool, int]:
    """取某实例该类对象的快照索引（带 TTL 缓存）。返回 ``(索引, 是否命中缓存, 缓存秒数)``。"""
    return snapshot_cache.get_or_compute(
        (instance.id, object_type),
        lambda: _fetch_index(session_pool.get_web_client(instance), object_type),
        force=force,
    )


def _app_rule_key(rule: dict) -> tuple:
    """应用控制一条规则的指纹：动作 + 引用应用 path 集合 + 引用 URL 名集合（忽略 rule_id）。"""
    return (
        rule.get("action"),
        tuple(sorted(a.get("path", "") for a in rule.get("apps", []))),
        tuple(sorted(u.get("name", "") for u in rule.get("urls", []))),
    )


def _net_rule_key(rule: dict) -> tuple:
    """端口控制一条规则的指纹：目的IP对象 + 服务 + 动作 + 时间（设备侧无 crc/rule_id）。"""
    return (rule.get("dip"), rule.get("service"), rule.get("action"), rule.get("time"))


def _rules_equal(src: list, tgt: list, key) -> bool:
    """两组规则按位置对位、内容指纹一致（数量也须相同）。"""
    return len(src) == len(tgt) and all(key(a) == key(b) for a, b in zip(src, tgt))


def _policy_equal(s: dict, t: dict) -> bool:
    """策略是否一致：覆盖 **启用状态 + 应用控制 / 端口控制 / 代理控制** 三段。

    每段先比 ``include`` 开关；开关为 True 才比该段内容（应用控制没启用就不比规则，与设备
    语义一致）。规则按位置对位比、忽略跨实例不同的 rule_id/crc。其余段（Web 过滤/邮件/QQ/
    SaaS 等）不纳入判定。
    """
    if bool(s.get("enable", True)) != bool(t.get("enable", True)):
        return False
    # 应用控制
    if bool(s.get("application_include")) != bool(t.get("application_include")):
        return False
    if s.get("application_include") and not _rules_equal(s.get("rules", []), t.get("rules", []), _app_rule_key):
        return False
    # 端口控制
    if bool(s.get("network_include")) != bool(t.get("network_include")):
        return False
    if s.get("network_include") and not _rules_equal(
        s.get("network_rules", []), t.get("network_rules", []), _net_rule_key
    ):
        return False
    # 代理控制
    if bool(s.get("proxy_include")) != bool(t.get("proxy_include")):
        return False
    if s.get("proxy_include") and s.get("proxy") != t.get("proxy"):
        return False
    return True


def _list_names(instance: Instance, object_type: str) -> list[str]:
    """只取某实例该类对象的**名单**（不拉详情），供「仅名单」快速对比用。"""
    return sync_service._list_object_names(session_pool.get_web_client(instance), object_type)


def _compare_names(
    src_names: list[str], tgt_names: list[str], names_filter: set[str] | None = None
) -> CompareTargetResult:
    """仅名单对比：只按对象名分「仅源有 / 仅目标有 / 两边都有」，不比内容。

    ``names_filter`` 给定时（已选子集）只看这些名字，不看源/目标全集的并集——这些名字本就
    取自源的对象名单，故不会出现「仅目标有」。
    """
    src_set, tgt_set = set(src_names), set(tgt_names)
    items: list[CompareItem] = []
    counts = {"source_only": 0, "target_only": 0, "both": 0}
    universe = names_filter if names_filter is not None else (src_set | tgt_set)
    for name in sorted(universe, key=lambda x: x.lower()):
        in_s, in_t = name in src_set, name in tgt_set
        status = "both" if (in_s and in_t) else "source_only" if in_s else "target_only"
        items.append(CompareItem(name=name, status=status))
        counts[status] += 1
    return CompareTargetResult(
        instance_id=0, instance_name="",
        source_only=counts["source_only"], target_only=counts["target_only"], both=counts["both"],
        items=items,
    )


def _compare_pair(
    object_type: str, src_index: dict, tgt_index: dict, names_filter: set[str] | None = None
) -> CompareTargetResult:
    """据源 / 目标两份快照索引，产出逐对象四分类结果（不含实例标识，由调用方补齐）。

    ``names_filter`` 给定时（已选子集）只看这些名字，理由同 :func:`_compare_names`。
    """
    src_names, src_snaps = src_index["names"], src_index["snaps"]
    tgt_names, tgt_snaps = tgt_index["names"], tgt_index["snaps"]
    src_set, tgt_set = set(src_names), set(tgt_names)

    items: list[CompareItem] = []
    counts = {"source_only": 0, "target_only": 0, "identical": 0, "different": 0, "error": 0}

    universe = names_filter if names_filter is not None else (src_set | tgt_set)
    for name in sorted(universe, key=lambda x: x.lower()):
        in_s, in_t = name in src_set, name in tgt_set
        s_status, s_snap, s_err = src_snaps.get(name, ("error", {}, "源快照缺失"))
        t_status, t_snap, t_err = tgt_snaps.get(name, ("error", {}, "目标快照缺失"))

        if in_s and not in_t:
            status = "source_only" if s_status == "found" else "error"
            items.append(
                CompareItem(
                    name=name, status=status,
                    source_snapshot=s_snap if s_status == "found" else None,
                    error="" if s_status == "found" else s_err,
                )
            )
        elif in_t and not in_s:
            status = "target_only" if t_status == "found" else "error"
            items.append(
                CompareItem(
                    name=name, status=status,
                    target_snapshot=t_snap if t_status == "found" else None,
                    error="" if t_status == "found" else t_err,
                )
            )
        else:  # 两边都有
            if s_status != "found" or t_status != "found":
                items.append(CompareItem(name=name, status="error", error=s_err or t_err or "读取失败"))
                counts["error"] += 1
                continue
            if object_type == "policy":
                # 语义判等（忽略 rule_id、按段 include 门控）；不一致时用字段级 diff 供前端逐段展开
                same = _policy_equal(s_snap, t_snap)
                diffs = [] if same else sync_service._diff_snapshots(s_snap, t_snap)
            else:
                diffs = sync_service._diff_snapshots(s_snap, t_snap)
                same = not diffs
            if same:
                items.append(CompareItem(name=name, status="identical"))
            else:
                items.append(CompareItem(name=name, status="different", source_snapshot=s_snap, diffs=diffs))
        counts[items[-1].status] += 1

    return CompareTargetResult(
        instance_id=0, instance_name="",
        source_only=counts["source_only"], target_only=counts["target_only"],
        identical=counts["identical"], different=counts["different"], error_count=counts["error"],
        items=items,
    )


def compare(
    db: Session,
    *,
    object_type: str,
    source_instance_id: int,
    target_instance_ids: list[int],
    names_only: bool = False,
    force: bool = False,
    object_names: list[str] | None = None,
) -> BatchCompareResult:
    """把源实例某类对象逐个目标做只读对比。

    ``names_only=True`` 时只比对象名单（仅源有 / 仅目标有 / 两边都有），不拉详情、秒级；
    否则比名单 + 内容（仅源有 / 仅目标有 / 一致 / 不一致）。

    ``object_names`` 给定时只对比这个子集（「已选对象」场景），不再对比源上全部——内容对比
    还会跳过全量快照缓存、直接按这几个名字拉取，选得越少越快。已选子集**不直接信任**——
    仍会现取一次源名单核对，选中但源上其实已不存在的名字（前端名单缓存滞后，或恰好被
    别人删除）标记为 ``error`` 而非误判成 ``both``/``source_only``。
    """
    source_inst = instance_service.get_instance(db, source_instance_id)
    if not source_inst:
        raise ValueError("源实例不存在")

    # 仅名单：只取名单、不拉详情，也不走快照缓存。已选子集仍需现取一次源名单核对存在性——
    # 这只是一次名单接口调用（不逐个拉详情），代价和「全量」路径本来就要付的一样，不算破坏
    # 「选得越少越快」这个目标（真正要省的是逐对象详情拉取，不是这一次名单调用）。
    if names_only:
        current_src_names = _list_names(source_inst, object_type)
        if object_names:
            current_set = set(current_src_names)
            stale = [n for n in object_names if n not in current_set]
            src_names = [n for n in object_names if n in current_set]
        else:
            stale = []
            src_names = current_src_names
        targets: list[CompareTargetResult] = []
        for tid in target_instance_ids:
            if tid == source_instance_id:
                continue
            target_inst = instance_service.get_instance(db, tid)
            if not target_inst:
                targets.append(CompareTargetResult(instance_id=tid, instance_name=f"#{tid}", error="目标实例不存在"))
                continue
            try:
                tgt_names = _list_names(target_inst, object_type)
            except Exception as exc:  # noqa: BLE001  连接/登录/拉取失败
                targets.append(
                    CompareTargetResult(instance_id=tid, instance_name=target_inst.name, error=f"读取目标失败：{exc}")
                )
                continue
            result = _compare_names(src_names, tgt_names, names_filter=set(src_names) if object_names else None)
            for n in stale:
                result.items.append(
                    CompareItem(
                        name=n, status="error",
                        error="已选对象在源实例上已不存在（可能刚被删除，请刷新对象列表）",
                    )
                )
                result.error_count += 1
            result.instance_id = tid
            result.instance_name = target_inst.name
            targets.append(result)
        return BatchCompareResult(
            object_type=object_type,
            source_instance_id=source_instance_id,
            source_count=len(src_names) if object_names else len(set(src_names)),
            names_only=True,
            targets=targets,
        )

    # 内容：已选子集时跳过全量快照缓存、按给定名字直接拉；否则拉两边全部对象快照（带缓存）。
    # 子集里若有名字其实在源上已不存在，_fetch_index/_build_snapshot 会拉到 not_found、
    # 该名字不进 src_index["names"]；下面 _compare_pair 据此把它判成 error 而非误报，
    # 不需要像「仅名单」路径那样额外核对——这里本来就会逐个真实读一次。
    names_filter = set(object_names) if object_names else None
    if object_names:
        source_web = session_pool.get_web_client(source_inst)
        src_index = _fetch_index(source_web, object_type, names=object_names)
        src_cached, src_age = False, 0
    else:
        src_index, src_cached, src_age = _index(source_inst, object_type, force=force)
    targets = []
    for tid in target_instance_ids:
        if tid == source_instance_id:
            continue
        target_inst = instance_service.get_instance(db, tid)
        if not target_inst:
            targets.append(CompareTargetResult(instance_id=tid, instance_name=f"#{tid}", error="目标实例不存在"))
            continue
        try:
            if object_names:
                tgt_index = _fetch_index(session_pool.get_web_client(target_inst), object_type, names=object_names)
            else:
                tgt_index, _cached, _age = _index(target_inst, object_type, force=force)
        except Exception as exc:  # noqa: BLE001  连接/登录/拉取失败
            targets.append(
                CompareTargetResult(instance_id=tid, instance_name=target_inst.name, error=f"读取目标失败：{exc}")
            )
            continue
        result = _compare_pair(object_type, src_index, tgt_index, names_filter=names_filter)
        result.instance_id = tid
        result.instance_name = target_inst.name
        targets.append(result)

    return BatchCompareResult(
        object_type=object_type,
        source_instance_id=source_instance_id,
        source_count=len(object_names) if object_names else len(src_index["names"]),
        names_only=False,
        source_cached=src_cached,
        source_cache_age_seconds=src_age,
        targets=targets,
    )
