import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CenteredSpinner, EmptyState, PageHeader } from "@/components/common";
import { NoInstance } from "@/components/no-instance";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckList } from "@/components/validation/check-list";
import { LegendChip } from "@/components/validation/legend-chip";
import { PolicyUsageCard } from "@/components/validation/policy-usage-card";
import { Stat } from "@/components/validation/stat";
import { useCurrentInstance } from "@/hooks/use-current-instance";
import { useAppStore } from "@/stores/app";
import { customRuleApi } from "@/lib/api";
import { exportChartHtml } from "@/lib/chart-export";
import { ACTION_ALLOW_COLOR, ACTION_DENY_COLOR, AGGREGATED_DOMAIN_COLOR, AGGREGATED_IP_COLOR, AGGREGATED_URL_COLOR, APP_COLOR, CONFLICT_COLOR, DOMAIN_COLOR, IP_COLOR, POLICY_COLOR, URL_ITEM_COLOR, URL_LIBRARY_COLOR } from "@/lib/validation/constants";
import type { AppSankeyPrimary, UrlSankeyPrimary, ValidationView } from "@/lib/validation/constants";
import { PROTO_COLORS, buildBrowseModel, buildGraphOption, buildUrlBrowseModel, listUrlDomainIpItems, resolveUrlBrowseScope, withPolicyLinkedUrlSummaries } from "@/lib/validation/model";

/** 缓存已存在时长 → 「· N 分钟前 / · N 秒前」展示文案。 */
function formatCacheAge(seconds?: number | null): string {
  if (seconds == null) return "";
  if (seconds < 5) return " · 刚刚";
  if (seconds < 60) return ` · ${seconds}秒前`;
  return ` · ${Math.floor(seconds / 60)}分钟前`;
}

export function ValidationPage() {
  const { instanceId } = useCurrentInstance();
  const [view, setView] = useState<ValidationView>("app-sankey");
  // 信息密度：1（疏）..100（密）→ 每节点高度 40..12px，无级调节
  const [density, setDensity] = useState(75);
  const nodePx = Math.round(40 - ((density - 1) / 99) * 28);
  // 图表标签颜色随主题：暗色用浅字、亮色用深字（否则亮色背景上浅字看不清）
  const theme = useAppStore((s) => s.theme);
  const chartLabelColor = theme === "dark" ? "#e2e8f0" : "#475569";

  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["cr-analysis", instanceId],
    // 普通加载走服务端缓存（refresh=false）：命中则秒回、不访问设备
    queryFn: () => customRuleApi.analysis(instanceId!),
    enabled: instanceId != null,
    staleTime: 5 * 60 * 1000,
  });
  // 「重新分析」强制刷新：绕过服务端缓存重算，并把结果写回查询缓存
  const reanalyze = useMutation({
    mutationFn: () => customRuleApi.analysis(instanceId!, true),
    onSuccess: (d) => queryClient.setQueryData(["cr-analysis", instanceId], d),
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "分析失败"),
  });
  const analyzing = q.isFetching || reanalyze.isPending;

  const data = q.data;
  const policyLinks = useMemo(() => data?.policy_links ?? [], [data]);
  const policyUrlLinks = useMemo(() => data?.policy_url_links ?? [], [data]);

  // 关系图：合并 IP + 域名重叠
  const allOverlaps = useMemo(
    () => [...(data?.ip_overlaps ?? []), ...(data?.domain_overlaps ?? [])],
    [data]
  );
  const graphOption = useMemo(
    () => buildGraphOption(allOverlaps, chartLabelColor),
    [allOverlaps, chartLabelColor]
  );

  // 关系浏览：全部策略 / 全部应用 的可勾选清单
  const appSummaries = useMemo(() => data?.apps ?? [], [data]);
  const allApps = useMemo(
    () => appSummaries.map((a) => a.name).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [appSummaries]
  );
  // 完整策略清单（含只引用内置应用、未匹配的策略）
  const allPolicies = useMemo(
    () => (data?.policies ?? []).slice().sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [data]
  );
  const linkedPolicyCount = useMemo(() => new Set(policyLinks.map((l) => l.policy)).size, [policyLinks]);
  const linkedUrlPolicyCount = useMemo(() => new Set(policyUrlLinks.map((l) => l.policy)).size, [policyUrlLinks]);
  const [selApps, setSelApps] = useState<Set<string>>(new Set());
  const [selUrls, setSelUrls] = useState<Set<string>>(new Set());
  const [selUrlDomainIps, setSelUrlDomainIps] = useState<Set<string>>(new Set());
  const [selPolicies, setSelPolicies] = useState<Set<string>>(new Set());
  const [appSankeyPrimary, setAppSankeyPrimary] = useState<AppSankeyPrimary>("policy");
  const [urlSankeyPrimary, setUrlSankeyPrimary] = useState<UrlSankeyPrimary>("policy");
  const [showUrlItems, setShowUrlItems] = useState(true);
  useEffect(() => setSelApps(new Set(allApps)), [allApps]);
  useEffect(() => setSelPolicies(new Set(allPolicies)), [allPolicies]);
  const relationModel = useMemo(
    () => buildBrowseModel(appSummaries, policyLinks, selPolicies, selApps, appSankeyPrimary, chartLabelColor),
    [appSummaries, policyLinks, selPolicies, selApps, appSankeyPrimary, chartLabelColor]
  );
  // 高度 = 最多一列节点数 × 每节点高度（由密度滑块控制）；过高时页面竖直滚动
  const relationHeight = useMemo(
    () => Math.min(16000, Math.max(360, relationModel.maxColumnCount * nodePx)),
    [relationModel.maxColumnCount, nodePx]
  );
  const urlSummaries = useMemo(
    () => withPolicyLinkedUrlSummaries(data?.urls ?? [], policyUrlLinks),
    [data?.urls, policyUrlLinks]
  );
  const allUrls = useMemo(() => urlSummaries.map((u) => u.name), [urlSummaries]);
  useEffect(() => setSelUrls(new Set(allUrls)), [allUrls]);
  const urlScope = useMemo(
    () => resolveUrlBrowseScope(urlSummaries, policyUrlLinks, selPolicies, selUrls, urlSankeyPrimary),
    [urlSummaries, policyUrlLinks, selPolicies, selUrls, urlSankeyPrimary]
  );
  const renderedUrlSetForItems = useMemo(() => new Set(urlScope.renderedUrls), [urlScope.renderedUrls]);
  const allUrlDomainIps = useMemo(
    () => listUrlDomainIpItems(urlSummaries, renderedUrlSetForItems),
    [urlSummaries, renderedUrlSetForItems]
  );
  useEffect(() => {
    const allowed = new Set(allUrlDomainIps);
    setSelUrlDomainIps((prev) => {
      const next = new Set([...prev].filter((item) => allowed.has(item)));
      return next.size === prev.size ? prev : next;
    });
  }, [allUrlDomainIps]);
  const urlRelationModel = useMemo(
    () =>
      buildUrlBrowseModel(
        urlSummaries,
        policyUrlLinks,
        selPolicies,
        selUrls,
        showUrlItems,
        selUrlDomainIps,
        urlSankeyPrimary,
        chartLabelColor
      ),
    [
      urlSummaries,
      policyUrlLinks,
      selPolicies,
      selUrls,
      showUrlItems,
      selUrlDomainIps,
      urlSankeyPrimary,
      chartLabelColor,
    ]
  );
  const urlRelationHeight = useMemo(
    () => Math.min(16000, Math.max(360, urlRelationModel.maxColumnCount * nodePx)),
    [urlRelationModel.maxColumnCount, nodePx]
  );
  const ranking = useMemo(() => {
    const deg = new Map<string, number>();
    allOverlaps.forEach((o) => {
      [...new Set(o.apps.map((a) => a.name))].forEach((n) => deg.set(n, (deg.get(n) ?? 0) + 1));
    });
    return [...deg.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [allOverlaps]);
  const graphHasData = allOverlaps.length > 0;

  const conflictCount =
    (data?.ip_overlaps.filter((o) => o.conflict).length ?? 0) +
    (data?.domain_overlaps.filter((o) => o.conflict).length ?? 0);

  if (instanceId == null) return <NoInstance />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="数据校验"
        description="自定义应用桑基图展示访问权限策略 → 自定义应用 → 协议·端口·方向 → 资源(IP/域名)；自定义 URL 桑基图展示访问权限策略 → URL 库 → URL 条目的覆盖关系。"
        actions={
          view === "policy-usage" ? null : (
            <div className="flex items-center gap-2">
              {data?.cached && !analyzing && (
                <span
                  className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
                  title="结果来自服务端缓存，点「重新分析」可强制重算最新数据"
                >
                  缓存{formatCacheAge(data.cache_age_seconds)}
                </span>
              )}
              <Button variant="outline" onClick={() => reanalyze.mutate()} disabled={analyzing}>
                <RefreshCw className={analyzing ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> 重新分析
              </Button>
            </div>
          )
        }
      />

      {/* 标签页常驻：策略引用校验作为独立 tab（自带数据与加载，不依赖桑基图分析） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={view} onValueChange={(v) => setView(v as ValidationView)}>
          <TabsList>
            <TabsTrigger value="app-sankey">自定义应用桑基图</TabsTrigger>
            <TabsTrigger value="url-sankey">自定义URL桑基图</TabsTrigger>
            <TabsTrigger value="graph">关系图（应用相似度）</TabsTrigger>
            <TabsTrigger value="policy-usage">策略引用校验</TabsTrigger>
          </TabsList>
        </Tabs>
        {view !== "graph" && view !== "policy-usage" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>信息密度</span>
            <span>疏</span>
            <input
              type="range"
              min={1}
              max={100}
              value={density}
              onChange={(e) => setDensity(Number(e.target.value))}
              className="h-1.5 w-40 cursor-pointer accent-[hsl(var(--primary))]"
              title={`每节点高度 ${nodePx}px`}
            />
            <span>密</span>
          </div>
        )}
      </div>

      {view === "policy-usage" ? (
        <PolicyUsageCard instanceId={instanceId} />
      ) : q.isLoading ? (
        <Card>
          <CenteredSpinner label="正在拉取自定义应用、URL 库和策略关系，请稍候…" />
        </Card>
      ) : q.isError ? (
        <Card>
          <EmptyState
            title="分析失败"
            hint={
              (q.error as any)?.response?.data?.detail ??
              (q.error as any)?.message ??
              "请求超时或网络异常，可点「重新分析」重试"
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="已分析应用" value={`${data?.analyzed_apps ?? 0} / ${data?.total_apps ?? 0}`} />
            <Stat label="URL 库" value={data?.url_count ?? 0} color="text-teal-400" />
            <Stat label="IP 重叠" value={data?.ip_overlaps.length ?? 0} color="text-cyan-400" />
            <Stat label="域名重叠" value={data?.domain_overlaps.length ?? 0} color="text-amber-400" />
            <Stat label="强冲突" value={conflictCount} color="text-rose-400" />
          </div>

          {data && data.errors.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-400">
              {data.errors.length} 项分析数据拉取失败，已跳过（结果可能不完整）。
            </div>
          )}

          {view === "app-sankey" ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <CheckList
                  key="app-sankey-policy-filter"
                  title="访问权限策略"
                  color={POLICY_COLOR}
                  items={allPolicies}
                  selected={selPolicies}
                  onChange={(next) => {
                    setAppSankeyPrimary("policy");
                    setSelPolicies(next);
                  }}
                />
                <CheckList
                  key="app-sankey-app-filter"
                  title="自定义应用"
                  color={APP_COLOR}
                  items={allApps}
                  selected={selApps}
                  onChange={(next) => {
                    setAppSankeyPrimary("app");
                    setSelApps(next);
                  }}
                />
              </div>
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 pb-3">
                    <LegendChip color={POLICY_COLOR} label="访问权限策略" />
                    <LegendChip color={APP_COLOR} label="自定义应用" />
                    <LegendChip color={ACTION_ALLOW_COLOR} label="放行连线" />
                    <LegendChip color={ACTION_DENY_COLOR} label="拒绝连线" />
                    <LegendChip color={PROTO_COLORS["0"]} label="TCP" />
                    <LegendChip color={PROTO_COLORS["1"]} label="UDP" />
                    <LegendChip color={PROTO_COLORS["2"]} label="ICMP" />
                    <LegendChip color={IP_COLOR} label="IP" />
                    <LegendChip color={AGGREGATED_IP_COLOR} label="聚合 IP" />
                    <LegendChip color={DOMAIN_COLOR} label="域名" />
                    <LegendChip color={CONFLICT_COLOR} label="强冲突" />
                    <span className="text-xs text-muted-foreground">
                      · 共 {allPolicies.length} 个策略，其中 {linkedPolicyCount} 个引用了自定义应用；筛选框已选{" "}
                      {relationModel.selectedPolicyCount} 个策略 / {relationModel.selectedAppCount} 个应用；按
                      {relationModel.primary === "policy" ? "策略" : "应用"}关联显示{" "}
                      {relationModel.policyCount} 个策略 / {relationModel.appCount} 个应用 / {relationModel.resourceCount} 个资源
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-7 gap-1.5 text-xs"
                      disabled={relationModel.nodeCount === 0}
                      onClick={() =>
                        exportChartHtml({
                          option: relationModel.option,
                          title: "自定义应用桑基图",
                          height: relationHeight,
                        }).catch((e: any) => toast.error("导出失败：" + (e?.message ?? e)))
                      }
                      title="导出为可缩放、可悬停高亮的离线 HTML"
                    >
                      <Download className="h-3.5 w-3.5" /> 导出 HTML
                    </Button>
                  </div>
                  {selApps.size === 0 && selPolicies.size === 0 ? (
                    <EmptyState title="请在上方勾选策略或应用" />
                  ) : relationModel.nodeCount === 0 ? (
                    <EmptyState
                      title="没有可浏览的关系"
                      hint="当前勾选项没有匹配到已分析的数据"
                    />
                  ) : (
                    <ReactECharts option={relationModel.option} style={{ height: relationHeight }} notMerge lazyUpdate />
                  )}
                </CardContent>
              </Card>
            </>
          ) : view === "url-sankey" ? (
            <>
              <div className="grid gap-3 xl:grid-cols-3">
                <CheckList
                  key="url-sankey-policy-filter"
                  title="访问权限策略"
                  color={POLICY_COLOR}
                  items={allPolicies}
                  selected={selPolicies}
                  onChange={(next) => {
                    setUrlSankeyPrimary("policy");
                    setSelPolicies(next);
                  }}
                />
                <CheckList
                  key="url-sankey-library-filter"
                  title="自定义 URL 库"
                  color={URL_LIBRARY_COLOR}
                  items={allUrls}
                  selected={selUrls}
                  onChange={(next) => {
                    setUrlSankeyPrimary("url");
                    setSelUrls(next);
                  }}
                />
                <CheckList
                  key="url-sankey-domain-ip-filter"
                  title="域名/IP"
                  color={DOMAIN_COLOR}
                  items={allUrlDomainIps}
                  selected={selUrlDomainIps}
                  onChange={setSelUrlDomainIps}
                  maxVisible={300}
                  selectAllVisibleOnly
                />
              </div>
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 pb-3">
                    <LegendChip color={POLICY_COLOR} label="访问权限策略" />
                    <LegendChip color={URL_LIBRARY_COLOR} label="自定义 URL 库" />
                    <LegendChip color={ACTION_ALLOW_COLOR} label="放行连线" />
                    <LegendChip color={ACTION_DENY_COLOR} label="拒绝连线" />
                    {showUrlItems && selUrlDomainIps.size > 0 && (
                      <>
                        <LegendChip color={IP_COLOR} label="IP" />
                        <LegendChip color={AGGREGATED_IP_COLOR} label="聚合 IP" />
                        <LegendChip color={DOMAIN_COLOR} label="域名" />
                        <LegendChip color={AGGREGATED_DOMAIN_COLOR} label="聚合域名" />
                      </>
                    )}
                    {showUrlItems && (
                      <>
                        <LegendChip color={URL_ITEM_COLOR} label="其他 URL" />
                        <LegendChip color={AGGREGATED_URL_COLOR} label="聚合 URL" />
                        <LegendChip color={CONFLICT_COLOR} label="重复引用" />
                      </>
                    )}
                    <span className="text-xs text-muted-foreground">
                      · 共 {allPolicies.length} 个策略，其中 {linkedUrlPolicyCount} 个引用了自定义 URL 库；筛选框已选{" "}
                      {urlRelationModel.selectedPolicyCount} 个策略 / {urlRelationModel.selectedUrlCount} 个 URL 库；按
                      {urlRelationModel.primary === "policy" ? "策略" : "URL 库"}关联显示{" "}
                      {urlRelationModel.policyCount} 个策略 / {urlRelationModel.urlCount} 个 URL 库 /{" "}
                      {urlRelationModel.resourceCount} 个 URL 节点
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <label className="inline-flex items-center gap-2 rounded-md border border-white/10 px-2.5 py-1 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={showUrlItems}
                          onChange={(e) => setShowUrlItems(e.target.checked)}
                          className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                        />
                        显示 URL 条目
                      </label>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        disabled={urlRelationModel.nodeCount === 0}
                        onClick={() =>
                          exportChartHtml({
                            option: urlRelationModel.option,
                            title: "自定义URL桑基图",
                            height: urlRelationHeight,
                          }).catch((e: any) => toast.error("导出失败：" + (e?.message ?? e)))
                        }
                        title="导出为可缩放、可悬停高亮的离线 HTML"
                      >
                        <Download className="h-3.5 w-3.5" /> 导出 HTML
                      </Button>
                    </div>
                  </div>
                  {selUrls.size === 0 && selPolicies.size === 0 ? (
                    <EmptyState title="请在上方勾选策略或 URL 库" />
                  ) : urlRelationModel.nodeCount === 0 ? (
                    <EmptyState
                      title="没有可浏览的 URL 关系"
                      hint={
                        urlRelationModel.primary === "policy"
                          ? "所选策略未引用已分析到的自定义 URL 库，或关联 URL 库未被勾选"
                          : "所选 URL 库没有可展示的 URL 条目"
                      }
                    />
                  ) : (
                    <ReactECharts
                      option={urlRelationModel.option}
                      style={{ height: urlRelationHeight }}
                      notMerge
                      lazyUpdate
                    />
                  )}
                </CardContent>
              </Card>
            </>
          ) : !graphHasData ? (
            <Card>
              <CardContent className="pt-6">
                <EmptyState title="暂无可建立关系的重叠" hint="没有被多个应用共享的 IP/域名" />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 pb-3 text-xs text-muted-foreground">
                    <LegendChip color={APP_COLOR} label="应用（越大=涉及重叠越多）" />
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-5 rounded" style={{ background: "rgba(148,163,184,0.7)" }} /> 共享资源（线越粗越多）
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-5 rounded" style={{ background: CONFLICT_COLOR }} /> 强冲突
                    </span>
                    <span>· 可拖动 / 滚轮缩放 / 悬停高亮邻居</span>
                  </div>
                  <ReactECharts option={graphOption} style={{ height: 560 }} notMerge lazyUpdate />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className="mb-2 text-sm font-medium">应用重叠度 Top（涉及多少个被共享的资源）</div>
                  <div className="space-y-1.5">
                    {ranking.map((r) => (
                      <div key={r.name} className="flex items-center gap-2">
                        <span className="w-44 truncate text-xs" title={r.name}>
                          {r.name}
                        </span>
                        <div className="h-2 flex-1 rounded bg-white/5">
                          <div
                            className="h-2 rounded bg-gradient-to-r from-violet-500 to-fuchsia-500"
                            style={{ width: `${(r.count / (ranking[0]?.count || 1)) * 100}%` }}
                          />
                        </div>
                        <span className="w-8 text-right text-xs text-muted-foreground">{r.count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
