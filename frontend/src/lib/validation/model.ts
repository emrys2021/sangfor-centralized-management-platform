/** 数据校验可视化：桑基图 / 力导向图的纯数据·option 构建器与资源分类。 */
import { directionLabel, protocolLabel } from "@/lib/customrule";
import type { AppSummary, PolicyLink, PolicyUrlLink, ResourceOverlap, UrlSummary } from "@/lib/types";
import { ACTION_ALLOW_COLOR, ACTION_DENY_COLOR, ACTION_UNKNOWN_COLOR, AGGREGATED_DOMAIN_COLOR, AGGREGATED_IP_COLOR, AGGREGATED_URL_COLOR, APP_COLOR, CONFLICT_COLOR, DOMAIN_COLOR, FIXED_SANKEY_NODE_VALUE, IP_COLOR, KEY_SEPARATOR, POLICY_COLOR, URL_ITEM_COLOR, URL_LIBRARY_COLOR } from "@/lib/validation/constants";
import type { AppSankeyPrimary, UrlSankeyPrimary } from "@/lib/validation/constants";

export function makeKey(...parts: string[]) {
  return parts.join(KEY_SEPARATOR);
}

export function fixedSankeyNode<T extends Record<string, unknown>>(node: T) {
  return { ...node, value: FIXED_SANKEY_NODE_VALUE };
}

export function normalizeLinksForFixedNodes(links: any[]) {
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const link of links) {
    const source = String(link.source);
    const target = String(link.target);
    outDegree.set(source, (outDegree.get(source) ?? 0) + 1);
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  for (const link of links) {
    const source = String(link.source);
    const target = String(link.target);
    link.value = FIXED_SANKEY_NODE_VALUE / Math.max(outDegree.get(source) ?? 1, inDegree.get(target) ?? 1);
  }
}

export function formatTooltipList(values: string[], maxItems = 30) {
  const shown = values.slice(0, maxItems);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join("<br/>")}<br/>... 另 ${rest} 个` : shown.join("<br/>");
}

// 协议颜色：TCP=蓝 / UDP=绿 / ICMP=紫 / 其他=灰
export const PROTO_COLORS: Record<string, string> = { "0": "#3b82f6", "1": "#10b981", "2": "#a855f7" };
export function protoColor(p: string) {
  return PROTO_COLORS[String(p)] ?? "#94a3b8";
}
export function dirArrow(d: string) {
  return d === "lan2wan" ? "→" : d === "wan2lan" ? "←" : "↔";
}

export function resolveAppBrowseScope(
  apps: AppSummary[],
  policyLinks: PolicyLink[],
  selPolicies: Set<string>,
  selApps: Set<string>,
  primary: AppSankeyPrimary
) {
  const appByName = new Map(apps.map((a) => [a.name, a]));
  const selectedApps = [...selApps].filter((n) => appByName.has(n));
  const selectedAppSet = new Set(selectedApps);
  if (primary === "app") {
    const linkedPolicies = new Set(policyLinks.filter((l) => selectedAppSet.has(l.app)).map((l) => l.policy));
    return {
      renderedPolicies: new Set([...linkedPolicies].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))),
      renderedApps: selectedApps,
    };
  }

  const linkedApps = new Set(policyLinks.filter((l) => selPolicies.has(l.policy)).map((l) => l.app));
  return {
    renderedPolicies: new Set(selPolicies),
    renderedApps: apps
      .map((a) => a.name)
      .filter((n) => appByName.has(n) && linkedApps.has(n))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
  };
}

export function resolveUrlBrowseScope(
  urls: UrlSummary[],
  policyUrlLinks: PolicyUrlLink[],
  selPolicies: Set<string>,
  selUrls: Set<string>,
  primary: UrlSankeyPrimary
) {
  const urlByName = new Map(urls.map((u) => [u.name, u]));
  const selectedUrls = [...selUrls].filter((n) => urlByName.has(n));
  const selectedUrlSet = new Set(selectedUrls);
  if (primary === "url") {
    const linkedPolicies = new Set(policyUrlLinks.filter((l) => selectedUrlSet.has(l.url)).map((l) => l.policy));
    return {
      renderedPolicies: new Set([...linkedPolicies].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))),
      renderedUrls: selectedUrls,
    };
  }

  const linkedUrls = new Set(policyUrlLinks.filter((l) => selPolicies.has(l.policy)).map((l) => l.url));
  return {
    renderedPolicies: new Set(selPolicies),
    renderedUrls: urls.map((u) => u.name).filter((n) => linkedUrls.has(n)),
  };
}

/** 通用桑基图 option（含 trajectory 高亮、淡化、label/tooltip 配置）。
 *  layoutIterations=0：关闭竖直居中松弛，节点从顶部紧挨排列、不在节点间留空。 */
export function sankeyOption(
  nodes: any[],
  links: any[],
  opts: { layoutIterations?: number; linkOpacity?: number; labelColor?: string } = {}
) {
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(20,20,30,0.92)",
      borderColor: "rgba(255,255,255,0.1)",
      textStyle: { color: "#e2e8f0", fontSize: 12 },
      formatter: (p: any) =>
        p.dataType === "edge" ? p.data._tip ?? "" : p.data?._tip ?? p.data?.label ?? p.name,
    },
    series: [
      {
        type: "sankey",
        layout: "none",
        layoutIterations: opts.layoutIterations ?? 32,
        // 收紧左右边距以缩短每层横向间距，并给最右列（IP/资源）标签留出空间避免被裁掉
        left: 12,
        right: 150,
        top: 8,
        bottom: 8,
        nodeGap: 7,
        nodeWidth: 12,
        draggable: false,
        // trajectory：悬停任一节点都高亮整条上下游路径，其余淡化。
        emphasis: { focus: "trajectory", lineStyle: { opacity: 0.55 } },
        blur: { itemStyle: { opacity: 0.12 }, lineStyle: { opacity: 0.04 } },
        data: nodes,
        links,
        label: {
          color: opts.labelColor ?? "#e2e8f0",
          fontSize: 12,
          overflow: "truncate",
          width: 160,
          formatter: (p: any) => p.data?.label ?? p.name,
        },
        lineStyle: { color: "source", opacity: opts.linkOpacity ?? 0.32, curveness: 0.5 },
      },
    ],
  };
}

/** 策略→应用/URL 连线动作 → 颜色。 */
export function policyLinkColor(action?: string): string {
  switch (action) {
    case "allow":
      return ACTION_ALLOW_COLOR;
    case "deny":
      return ACTION_DENY_COLOR;
    default:
      return ACTION_UNKNOWN_COLOR;
  }
}

/** 策略→应用/URL 连线动作 → 中文标签。 */
export function policyLinkActionLabel(action?: string): string {
  switch (action) {
    case "allow":
      return "放行";
    case "deny":
      return "拒绝";
    default:
      return "动作未知";
  }
}

/**
 * 力导向「应用相似度」关系图：应用为节点，两个应用共享 ≥1 个资源就连边，
 * 边越粗=共享越多、布局上越靠近；节点越大=涉及的重叠资源越多；
 * 共享同「方向·协议·端口」的应用对（强冲突）连红边。数据来自现有分析结果，无需后端。
 */
export function buildGraphOption(overlaps: ResourceOverlap[], labelColor = "#cbd5e1") {
  const pairKey = (x: string, y: string) => (x < y ? makeKey(x, y) : makeKey(y, x));
  const pairs = new Map<string, { a: string; b: string; weight: number; conflict: boolean }>();
  const degree = new Map<string, Set<string>>();

  for (const o of overlaps) {
    const names = [...new Set(o.apps.map((a) => a.name))];
    for (const n of names) (degree.get(n) ?? degree.set(n, new Set()).get(n)!).add(`${o.type}:${o.value}`);
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const k = pairKey(names[i], names[j]);
        const p = pairs.get(k) ?? { a: names[i], b: names[j], weight: 0, conflict: false };
        p.weight += 1;
        pairs.set(k, p);
      }
    // 强冲突应用对：同资源下同「方向|协议|端口」分组里 ≥2 个应用
    const groups = new Map<string, string[]>();
    for (const a of o.apps) {
      const sig = `${a.direction}|${a.protocol}|${a.port}`;
      (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(a.name);
    }
    for (const g of groups.values()) {
      const gn = [...new Set(g)];
      for (let i = 0; i < gn.length; i++)
        for (let j = i + 1; j < gn.length; j++) {
          const p = pairs.get(pairKey(gn[i], gn[j]));
          if (p) p.conflict = true;
        }
    }
  }

  const nodes = [...degree.entries()].map(([name, res]) => ({
    name,
    value: res.size,
    symbolSize: 14 + Math.min(46, res.size * 5),
    itemStyle: { color: APP_COLOR },
  }));
  const links = [...pairs.values()].map((p) => ({
    source: p.a,
    target: p.b,
    value: p.weight,
    _conflict: p.conflict,
    lineStyle: {
      width: Math.min(9, 1 + p.weight),
      color: p.conflict ? CONFLICT_COLOR : "rgba(148,163,184,0.45)",
      opacity: p.conflict ? 0.9 : 0.5,
      curveness: 0,
    },
  }));

  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(20,20,30,0.92)",
      borderColor: "rgba(255,255,255,0.1)",
      textStyle: { color: "#e2e8f0", fontSize: 12 },
      formatter: (p: any) =>
        p.dataType === "edge"
          ? `${p.data.source} ↔ ${p.data.target}<br/>共享 ${p.data.value} 个资源${p.data._conflict ? "（含强冲突）" : ""}`
          : `${p.name}<br/>涉及 ${p.value} 个重叠资源`,
    },
    series: [
      {
        type: "graph",
        layout: "force",
        roam: true,
        draggable: true,
        data: nodes,
        links,
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.95 } },
        force: { repulsion: 130, edgeLength: [40, 170], gravity: 0.08, friction: 0.2 },
        label: { show: true, color: labelColor, fontSize: 10, position: "right", formatter: (p: any) => p.name },
        scaleLimit: { min: 0.4, max: 5 },
      },
    ],
  };
}

/**
 * 关系浏览桑基图：勾选的 策略 → 应用 → 协议·端口·方向 → 资源(IP/域名)。
 * 协议·端口·方向作为可见的一层（按协议着色、标注端口）；同一资源下同一「协议·端口·方向」
 * 被 ≥2 个应用引用时该中间节点标红（强冲突）。
 */
export function buildBrowseModel(
  apps: AppSummary[],
  policyLinks: PolicyLink[],
  selPolicies: Set<string>,
  selApps: Set<string>,
  primary: AppSankeyPrimary,
  labelColor = "#e2e8f0"
) {
  const appByName = new Map(apps.map((a) => [a.name, a]));
  const { renderedPolicies, renderedApps } = resolveAppBrowseScope(apps, policyLinks, selPolicies, selApps, primary);
  const renderedAppSet = new Set(renderedApps);
  const renderedPolicySet = new Set(renderedPolicies);
  const includedLinks = policyLinks.filter((l) => renderedPolicySet.has(l.policy) && renderedAppSet.has(l.app));

  const resourceNodes = new Map<string, { label: string; color: string; tip?: string }>();
  // 中间层：协议·端口·方向。一个应用的所有资源共享同一签名，故按"每应用"合并成一个节点。
  const midNodes = new Map<string, { label: string; tip: string; protocol: string }>();
  // 资源 -> 签名 -> 引用它的应用集合，用于在合并后仍能识别强冲突
  const resBySig = new Map<string, Map<string, Set<string>>>();
  const links: any[] = [];
  for (const l of includedLinks)
    links.push({
      source: `P:${l.policy}`,
      target: `A:${l.app}`,
      value: 1,
      _tip: `策略 ${l.policy} →〔${policyLinkActionLabel(l.action)}〕应用 ${l.app}`,
      // 连线颜色随该策略引用此应用的规则动作（放行/拒绝/混合）
      lineStyle: { color: policyLinkColor(l.action) },
    });

  // 第一遍：统计每个资源被哪些应用引用，用于识别强冲突与生成资源节点。
  const appResList = new Map<string, { id: string; label: string; color: string }[]>();
  for (const name of renderedApps) {
    const a = appByName.get(name)!;
    const resList: { id: string; label: string; color: string }[] = [];
    for (const ip of a.ips ?? []) resList.push({ id: `R:ip:${ip}`, label: ip, color: IP_COLOR });
    for (const d of a.domains ?? []) resList.push({ id: `R:dom:${d}`, label: d, color: DOMAIN_COLOR });
    if (resList.length === 0) continue;
    appResList.set(name, resList);
  }
  const resourceSources = new Map<string, Set<string>>();
  for (const [name, resList] of appResList) {
    const midId = `M:${name}`;
    for (const r of resList) (resourceSources.get(r.id) ?? resourceSources.set(r.id, new Set()).get(r.id)!).add(midId);
  }

  // 第二遍：先按业务关系生成连接，最后统一归一化；节点高度由 node.value 固定。
  for (const [name, resList] of appResList) {
    const a = appByName.get(name)!;
    const sig = `${a.direction}|${a.protocol}|${a.port}`;
    const proto = protocolLabel(a.protocol);
    const midLabel = `${proto}·${a.port} ${dirArrow(a.direction)}`;
    const midId = `M:${name}`;
    midNodes.set(midId, {
      label: midLabel,
      tip: `${directionLabel(a.direction)}｜${proto}｜端口 ${a.port}｜${resList.length} 个资源`,
      protocol: a.protocol,
    });
    const privateIpResources = resList.filter(
      (r) => r.id.startsWith("R:ip:") && (resourceSources.get(r.id)?.size ?? 0) === 1
    );
    const aggregatedPrivateIpIds = new Set<string>();
    if (privateIpResources.length > 1) {
      const labels = privateIpResources.map((r) => r.label).sort((x, y) => x.localeCompare(y, "zh-Hans-CN"));
      const groupId = `R:ip-group:${name}`;
      privateIpResources.forEach((r) => aggregatedPrivateIpIds.add(r.id));
      resourceNodes.set(groupId, {
        label: `${labels.length} 个 IP`,
        color: AGGREGATED_IP_COLOR,
        tip: `${midLabel} 下 ${labels.length} 个仅被该协议端口引用的 IP<br/>${formatTooltipList(labels)}`,
      });
      links.push({ source: midId, target: groupId, value: 1, _tip: `${midLabel} → ${labels.length} 个独立 IP` });
    }
    for (const r of resList) {
      if (aggregatedPrivateIpIds.has(r.id)) continue;
      if (!resourceNodes.has(r.id)) resourceNodes.set(r.id, { label: r.label, color: r.color });
      links.push({ source: midId, target: r.id, value: 1, _tip: `${midLabel} → ${r.label}` });
      const bySig = resBySig.get(r.id) ?? resBySig.set(r.id, new Map()).get(r.id)!;
      (bySig.get(sig) ?? bySig.set(sig, new Set()).get(sig)!).add(name);
    }
    links.push({ source: `A:${name}`, target: midId, value: 1, _tip: `${name} — ${midLabel}（${resList.length} 个资源）` });
  }

  // 强冲突：同一资源被 ≥2 个应用以相同「方向·协议·端口」引用 → 资源节点标红
  const conflictRes = new Set(
    [...resBySig.entries()]
      .filter(([, bySig]) => [...bySig.values()].some((apps) => apps.size >= 2))
      .map(([id]) => id)
  );

  normalizeLinksForFixedNodes(links);

  const hasPolicy = renderedPolicies.size > 0;
  const dApp = hasPolicy ? 1 : 0;
  const nodes = [
    ...[...renderedPolicies].map((p) =>
      fixedSankeyNode({ name: `P:${p}`, label: p, depth: 0, itemStyle: { color: POLICY_COLOR } })
    ),
    ...renderedApps.map((n) => {
      const a = appByName.get(n)!;
      return fixedSankeyNode({
        name: `A:${n}`,
        label: n,
        depth: dApp,
        _tip: `${n}｜${directionLabel(a.direction)}｜${protocolLabel(a.protocol)}｜端口 ${a.port}`,
        itemStyle: { color: APP_COLOR },
      });
    }),
    ...[...midNodes.entries()].map(([id, m]) =>
      fixedSankeyNode({
        name: id,
        label: m.label,
        depth: dApp + 1,
        _tip: m.tip,
        itemStyle: { color: protoColor(m.protocol) },
      })
    ),
    ...[...resourceNodes.entries()].map(([id, m]) =>
      fixedSankeyNode({
        name: id,
        label: m.label,
        depth: dApp + 2,
        _tip: m.tip,
        itemStyle: { color: conflictRes.has(id) ? CONFLICT_COLOR : m.color },
      })
    ),
  ];
  const maxColumnCount = Math.max(
    renderedApps.length,
    resourceNodes.size,
    renderedPolicies.size,
    midNodes.size
  );
  return {
    // 开启竖直居中松弛 → 应用/协议端口节点落在所连 IP 扇形的加权中点（IP 散开时偏向最大那团）；
    // 连线变细故提高不透明度
    option: sankeyOption(nodes, links, { layoutIterations: 32, linkOpacity: 0.5, labelColor }),
    nodeCount: nodes.length,
    selectedPolicyCount: selPolicies.size,
    selectedAppCount: selApps.size,
    policyCount: renderedPolicies.size,
    appCount: renderedApps.length,
    resourceCount: resourceNodes.size,
    maxColumnCount,
    primary,
  };
}

/**
 * 自定义 URL 桑基图：勾选的 策略 → URL 库 → URL 条目。
 * 只属于同一个 URL 库的大量 IP、域名或其他 URL 会按类型聚合；被多个 URL 库重复引用的条目保持独立并标红。
 */
export function buildUrlBrowseModel(
  urls: UrlSummary[],
  policyUrlLinks: PolicyUrlLink[],
  selPolicies: Set<string>,
  selUrls: Set<string>,
  showUrlItems: boolean,
  selectedDomainIpItems: Set<string>,
  primary: UrlSankeyPrimary,
  labelColor = "#e2e8f0"
) {
  const linkedUrls = withPolicyLinkedUrlSummaries(urls, policyUrlLinks);
  const urlByName = new Map(linkedUrls.map((u) => [u.name, u]));
  const { renderedPolicies, renderedUrls } = resolveUrlBrowseScope(
    linkedUrls,
    policyUrlLinks,
    selPolicies,
    selUrls,
    primary
  );
  const renderedUrlSet = new Set(renderedUrls);
  const renderedPolicySet = new Set(renderedPolicies);
  const includedLinks = policyUrlLinks.filter((l) => renderedPolicySet.has(l.policy) && renderedUrlSet.has(l.url));

  const links: any[] = [];
  for (const l of includedLinks) {
    const rules = l.rules ?? [];
    const ruleTip =
      rules.length > 0
        ? `<br/>引用规则：<br/>${formatTooltipList(
            rules.map((rule) => `${rule.index ?? "-"} ${rule.name || "未命名规则"}`),
            12
          )}`
        : "";
    links.push({
      source: `P:${l.policy}`,
      target: `U:${l.url}`,
      value: 1,
      _tip: `策略 ${l.policy} →〔${policyLinkActionLabel(l.action)}〕URL 库 ${l.url}${ruleTip}`,
      // 连线颜色随该策略引用此 URL 库的规则动作（放行/拒绝/混合）
      lineStyle: { color: policyLinkColor(l.action) },
    });
  }

  const resourceNodes = new Map<string, { label: string; color: string; tip?: string }>();
  if (showUrlItems) {
    const urlItemsByGroup = new Map<string, string[]>();
    const itemSources = new Map<string, Set<string>>();
    const itemMetaByValue = new Map<string, { kind: UrlResourceKind; color: string }>();
    const classifyItem = (item: string) => {
      const cached = itemMetaByValue.get(item);
      if (cached) return cached;
      const meta = classifyUrlResource(item);
      itemMetaByValue.set(item, meta);
      return meta;
    };
    for (const name of renderedUrls) {
      const uniqueItems = listUnique(urlByName.get(name)?.urls ?? []).filter((item) => {
        const selectorKey = getUrlDomainIpSelectorKey(item);
        return selectorKey ? selectedDomainIpItems.has(selectorKey) : true;
      });
      urlItemsByGroup.set(name, uniqueItems);
      for (const item of uniqueItems) {
        const itemId = `RU:${item}`;
        (itemSources.get(itemId) ?? itemSources.set(itemId, new Set()).get(itemId)!).add(name);
      }
    }

    const duplicatedItems = new Set(
      [...itemSources.entries()].filter(([, sources]) => sources.size > 1).map(([id]) => id)
    );

    for (const [name, items] of urlItemsByGroup) {
      const groupNode = `U:${name}`;
      const privateItems = items.filter((item) => (itemSources.get(`RU:${item}`)?.size ?? 0) === 1);
      const aggregatedPrivateIds = new Set<string>();
      const privateItemsByKind = new Map<UrlResourceKind, string[]>();
      for (const item of privateItems) {
        const kind = classifyItem(item).kind;
        (privateItemsByKind.get(kind) ?? privateItemsByKind.set(kind, []).get(kind)!).push(item);
      }
      for (const [kind, kindItems] of privateItemsByKind) {
        if (kindItems.length <= 1) continue;
        const labels = kindItems.slice().sort((x, y) => x.localeCompare(y, "zh-Hans-CN"));
        const aggregate = aggregateUrlResourceMeta(kind, labels.length);
        const groupId = `RU:group:${kind}:${name}`;
        kindItems.forEach((item) => aggregatedPrivateIds.add(`RU:${item}`));
        resourceNodes.set(groupId, {
          label: aggregate.label,
          color: aggregate.color,
          tip: `${name} 下 ${labels.length} 个仅被该 URL 库引用的 ${aggregate.resourceLabel}<br/>${formatTooltipList(labels)}`,
        });
        links.push({ source: groupNode, target: groupId, value: 1, _tip: `${name} → ${aggregate.label}` });
      }

      for (const item of items) {
        const itemId = `RU:${item}`;
        if (aggregatedPrivateIds.has(itemId)) continue;
        if (!resourceNodes.has(itemId)) {
          const sources = itemSources.get(itemId)?.size ?? 0;
          const meta = classifyItem(item);
          resourceNodes.set(itemId, {
            label: item,
            color: duplicatedItems.has(itemId) ? CONFLICT_COLOR : meta.color,
            tip: sources > 1 ? `${item}<br/>被 ${sources} 个 URL 库引用` : item,
          });
        }
        links.push({ source: groupNode, target: itemId, value: 1, _tip: `${name} → ${item}` });
      }
    }
  }

  normalizeLinksForFixedNodes(links);

  const hasPolicy = renderedPolicies.size > 0;
  const dUrl = hasPolicy ? 1 : 0;
  const nodes = [
    ...[...renderedPolicies].map((p) =>
      fixedSankeyNode({ name: `P:${p}`, label: p, depth: 0, itemStyle: { color: POLICY_COLOR } })
    ),
    ...renderedUrls.map((name) => {
      const summary = urlByName.get(name)!;
      return fixedSankeyNode({
        name: `U:${name}`,
        label: name,
        depth: dUrl,
        _tip: `${name}｜${summary.url_count} 个 URL`,
        itemStyle: { color: URL_LIBRARY_COLOR },
      });
    }),
    ...(showUrlItems
      ? [...resourceNodes.entries()].map(([id, node]) =>
          fixedSankeyNode({
            name: id,
            label: node.label,
            depth: dUrl + 1,
            _tip: node.tip,
            itemStyle: { color: node.color },
          })
        )
      : []),
  ];
  const maxColumnCount = Math.max(renderedPolicies.size, renderedUrls.length, resourceNodes.size);
  return {
    option: sankeyOption(nodes, links, { layoutIterations: 32, linkOpacity: 0.5, labelColor }),
    nodeCount: nodes.length,
    selectedPolicyCount: selPolicies.size,
    selectedUrlCount: selUrls.size,
    policyCount: renderedPolicies.size,
    urlCount: renderedUrls.length,
    resourceCount: resourceNodes.size,
    maxColumnCount,
    primary,
  };
}

export function withPolicyLinkedUrlSummaries(urls: UrlSummary[], policyUrlLinks: PolicyUrlLink[]) {
  const byName = new Map(urls.map((u) => [u.name, u]));
  for (const link of policyUrlLinks) {
    const name = link.url.trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, { name, url_count: 0, urls: [] });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function listUrlDomainIpItems(urls: UrlSummary[], selectedUrls: Set<string>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const summary of urls) {
    if (!selectedUrls.has(summary.name)) continue;
    for (const raw of summary.urls ?? []) {
      const item = raw.trim();
      const selectorKey = getUrlDomainIpSelectorKey(item);
      if (!selectorKey || seen.has(selectorKey)) continue;
      seen.add(selectorKey);
      out.push(selectorKey);
    }
  }
  return out;
}

export function listUnique(values: string[]) {
  return listTrimmed(values).filter((value, index, array) => array.indexOf(value) === index);
}

export function listTrimmed(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

export type UrlResourceKind = "ip" | "domain" | "url";

export function classifyUrlResource(value: string): { kind: UrlResourceKind; color: string } {
  const key = getUrlDomainIpSelectorKey(value);
  if (key && isIpv4Like(key)) return { kind: "ip", color: IP_COLOR };
  if (key) return { kind: "domain", color: DOMAIN_COLOR };
  return { kind: "url", color: URL_ITEM_COLOR };
}

export function getUrlDomainIpSelectorKey(value: string) {
  const host = extractHostLikeValue(value);
  if (isIpv4Like(host)) return host;
  if (isDomainLike(host)) return host.toLowerCase();
  return "";
}

export function aggregateUrlResourceMeta(kind: UrlResourceKind, count: number) {
  if (kind === "ip") return { label: `${count} 个 IP`, color: AGGREGATED_IP_COLOR, resourceLabel: "IP" };
  if (kind === "domain") return { label: `${count} 个域名`, color: AGGREGATED_DOMAIN_COLOR, resourceLabel: "域名" };
  return { label: `${count} 个 URL`, color: AGGREGATED_URL_COLOR, resourceLabel: "URL" };
}

export function extractHostLikeValue(value: string) {
  let text = value.trim().replace(/^["']|["']$/g, "");
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  text = text.split(/[/?#]/)[0] ?? text;
  text = text.replace(/^\*+\./, "");
  text = text.replace(/^\.+/, "");
  text = text.replace(/[\s,;，；]+$/, "");
  if (/^[^:]+:[0-9*]+$/.test(text)) {
    text = text.replace(/:[0-9*]+$/, "");
  }
  return text.toLowerCase();
}

export function isIpv4Like(value: string) {
  return isIpv4OrCidr(value) || isIpv4Range(value) || isIpv4Wildcard(value);
}

export function isIpv4OrCidr(value: string) {
  const [ip, mask] = value.split("/");
  if (mask != null && (!/^\d{1,2}$/.test(mask) || Number(mask) > 32)) return false;
  return isIpv4Address(ip);
}

export function isIpv4Address(value: string) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function isIpv4Range(value: string) {
  const [start, end, ...rest] = value.split("-");
  return rest.length === 0 && Boolean(start) && Boolean(end) && isIpv4Address(start) && isIpv4Address(end);
}

export function isIpv4Wildcard(value: string) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => part === "*" || (/^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255));
}

export function isDomainLike(value: string) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}
