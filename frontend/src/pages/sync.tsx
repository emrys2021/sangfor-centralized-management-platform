import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, GitCompareArrows, RefreshCw, Rocket, Scale } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader, Spinner } from "@/components/common";
import { TargetCard } from "@/components/sync/object-diff";
import { ApplyResultCard, BatchResultCard, CompareResultCard } from "@/components/sync/result-cards";
import { SourceSummary } from "@/components/sync/snapshot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiCombobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { customRuleApi, instanceApi, policyApi, syncApi, urlApi } from "@/lib/api";
import type {
  BatchCompareResult,
  BatchSyncResult,
  ObjectType,
  SyncApplyResult,
  SyncDiffResult,
} from "@/lib/types";

const OBJECT_TYPES: { value: ObjectType; label: string }[] = [
  { value: "customrule", label: "自定义应用" },
  { value: "url", label: "自定义 URL 库" },
  { value: "policy", label: "访问权限策略" },
];

// 对象选择框里的特殊项：选它表示「整类全部对象」（对比/同步 的批量子选项）。
// 用不可能与真实对象名冲突的哨兵值。
const ALL_OBJECTS = "__ALL_OBJECTS__";

// sync-names 按 [对象类型, 实例id] 缓存；策略同步可能顺带在目标自动建/改自定义应用或 URL 库
// 引用（见 policy_sync 的自动建引用），故失效时三种类型都覆盖，不只当次同步的 objectType。
const ALL_OBJECT_TYPES: ObjectType[] = ["customrule", "url", "policy"];

/** 真实同步写入后失效目标实例的相关前端缓存。
 *
 * 全局 staleTime=30s/5min（见 main.tsx、app-picker.tsx 的应用树）后，切到目标实例页面短时间内
 * 会直接读旧缓存——同步刚写完立刻去目标实例核对结果、或打开策略编辑器选应用是常见操作，必须
 * 主动失效，否则会看到「同步成功但页面/应用树没变」的假象。TanStack Query 默认按前缀匹配，故
 * 这里只传各 query 的前几段 key 即可覆盖其带详情名的变体（如 ["policy", id] 一并失效
 * ["policy", id, name]）。
 */
function invalidateTargetInstanceQueries(qc: ReturnType<typeof useQueryClient>, instanceId: number) {
  qc.invalidateQueries({ queryKey: ["policies", instanceId] });
  qc.invalidateQueries({ queryKey: ["policy", instanceId] });
  qc.invalidateQueries({ queryKey: ["app-tree", instanceId] });
  qc.invalidateQueries({ queryKey: ["customrules", instanceId] });
  qc.invalidateQueries({ queryKey: ["customrule", instanceId] });
  qc.invalidateQueries({ queryKey: ["urls", instanceId] });
  qc.invalidateQueries({ queryKey: ["url-content", instanceId] });
  qc.invalidateQueries({ queryKey: ["cr-analysis", instanceId] });
  qc.invalidateQueries({ queryKey: ["policy-usage", instanceId] });
  qc.invalidateQueries({ queryKey: ["search", instanceId] });
  for (const ot of ALL_OBJECT_TYPES) qc.invalidateQueries({ queryKey: ["sync-names", ot, instanceId] });
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export function SyncPage() {
  const qc = useQueryClient();
  const { data: instances = [] } = useQuery({ queryKey: ["instances"], queryFn: () => instanceApi.list() });
  const enabled = instances.filter((i) => i.enabled);

  const [objectType, setObjectType] = useState<ObjectType>("customrule");
  const [sourceId, setSourceId] = useState<number | null>(null);
  // 对象范围：多选。ALL_OBJECTS 哨兵与具体对象互斥——选中哨兵即整类批量，见下方 onChange。
  const [objectNames, setObjectNames] = useState<string[]>([]);
  const [targets, setTargets] = useState<number[]>([]);
  const [diff, setDiff] = useState<SyncDiffResult | null>(null);
  const [applyResult, setApplyResult] = useState<SyncApplyResult | null>(null);
  // 记录生成当前预览时的配置，配置改变后据此标记预览「已过期」（而非直接清空）
  const [resultKey, setResultKey] = useState<string | null>(null);
  // 真实写入二次确认弹窗：null 关闭，否则携带「是否一键推送全部 + 是否批量」
  const [confirmApply, setConfirmApply] = useState<{ pushAll: boolean; batch: boolean } | null>(null);
  // 意图：对比（只读，理解差异）/ 同步（写入，推送变更）——读写分离，写入口只在「同步」下出现
  const [mode, setMode] = useState<"compare" | "sync">("compare");
  // 镜像：删除目标多余对象（仅同步 + 全部对象）
  const [mirror, setMirror] = useState(false);
  // 策略同步：允许写入「降级（丢弃了目标缺失引用、与源不等价）」的策略；默认关（后端会拒绝降级写入）
  const [allowDegrade, setAllowDegrade] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchSyncResult | null>(null);
  const [compareResult, setCompareResult] = useState<BatchCompareResult | null>(null);

  const sourceName = instances.find((i) => i.id === sourceId)?.name ?? "源";
  const isPolicy = objectType === "policy";
  // 范围（单个/多选/全部）是对象选择框里的子选项：选中「全部对象」哨兵即整类批量；
  // 选中 2 个及以上具体对象同样走「批量」渲染（汇总名单视图），只是子集范围更小。
  const isAll = objectNames.length === 1 && objectNames[0] === ALL_OBJECTS;
  const isBatch = isAll || objectNames.length > 1;
  const isCompare = mode === "compare";
  // 单对象场景下的对象名（供沿用「单对象」诊断链路：字段级 diff / 单对象写）
  const singleObjectName = !isBatch ? objectNames[0] ?? "" : "";
  // 批量场景下要传给后端的「已选子集」；全选时不传（后端按全量处理，走原有缓存路径）
  const selectedSubset = isBatch && !isAll ? objectNames : undefined;

  // 当前配置指纹；与 resultKey 不一致即说明右侧结果已过期
  const currentKey = JSON.stringify({
    mode, objectType, sourceId, objectNames: [...objectNames].sort(), mirror, targets: [...targets].sort(),
  });
  const stale = resultKey != null && resultKey !== currentKey;

  const names = useQuery({
    queryKey: ["sync-names", objectType, sourceId],
    enabled: sourceId != null,
    queryFn: async () => {
      if (objectType === "customrule")
        return (await customRuleApi.list(sourceId!)).map((r) => String(r.rulename));
      if (objectType === "url")
        return (await urlApi.list(sourceId!)).flat.filter((n) => !n.inside).map((n) => n.name);
      return (await policyApi.list(sourceId!)).access_policies.map((p) => String(p.name));
    },
  });

  const targetCandidates = useMemo(
    () => enabled.filter((i) => i.id !== sourceId),
    [enabled, sourceId]
  );

  const diffMut = useMutation({
    mutationFn: () =>
      syncApi.diff({
        object_type: objectType,
        object_name: singleObjectName,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
      }),
    onSuccess: (r) => { setDiff(r); setApplyResult(null); setCompareResult(null); setResultKey(currentKey); },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "差异计算失败"),
  });

  // 只读对比（batch 模式）。namesOnly=true 只比名单（秒级）；false 比内容（四分类，较慢）。
  const compareMut = useMutation({
    mutationFn: ({ namesOnly, force }: { namesOnly: boolean; force?: boolean }) =>
      syncApi.compare({
        object_type: objectType,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
        names_only: namesOnly,
        force: force ?? false,
        object_names: selectedSubset,
      }),
    onSuccess: (r) => { setCompareResult(r); setBatchResult(null); setResultKey(currentKey); },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "对比失败"),
  });

  const applyMut = useMutation({
    mutationFn: ({ pushAll, dryRun }: { pushAll: boolean; dryRun: boolean }) =>
      syncApi.apply({
        object_type: objectType,
        object_name: singleObjectName,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
        push_all: pushAll,
        dry_run: dryRun,
        allow_degrade: allowDegrade,
      }),
    onSuccess: (r, vars) => {
      setApplyResult(r);
      setCompareResult(null);
      setResultKey(currentKey);
      setConfirmApply(null);
      if (vars.dryRun) {
        toast.success("已生成同步预览（dry-run）");
      } else {
        // 真实写入：失效所有目标实例的相关缓存，避免切到目标页面 30 秒内仍看到旧数据
        for (const x of r.results) invalidateTargetInstanceQueries(qc, x.instance_id);
        const failed = r.results.filter((x) => !x.success).length;
        const degraded = r.results.filter((x) => x.degraded && x.success).length;
        if (failed > 0) toast.warning(`同步完成，${failed} 个目标失败/被拒绝`);
        else if (degraded > 0) toast.warning(`同步完成，${degraded} 个为降级写入（与源不等价）`);
        else toast.success("同步完成");
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "同步失败"),
  });

  const batchMut = useMutation({
    mutationFn: ({ pushAll, dryRun }: { pushAll: boolean; dryRun: boolean }) =>
      syncApi.batch({
        object_type: objectType,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
        push_all: pushAll,
        mirror,
        dry_run: dryRun,
        allow_degrade: allowDegrade,
        object_names: selectedSubset,
      }),
    onSuccess: (r, vars) => {
      setBatchResult(r);
      setCompareResult(null);
      setResultKey(currentKey);
      setConfirmApply(null);
      const failed = r.targets.reduce((n, t) => n + t.failed.length, 0);
      if (vars.dryRun) {
        toast.success("已生成批量同步预览（dry-run）");
      } else {
        // 真实写入：失效所有目标实例的相关缓存，避免切到目标页面 30 秒内仍看到旧数据
        for (const t of r.targets) invalidateTargetInstanceQueries(qc, t.instance_id);
        if (failed === 0) toast.success("批量同步完成");
        else toast.warning(`批量同步完成，${failed} 项失败`);
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "批量同步失败"),
  });

  function toggleTarget(id: number) {
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  const ready = sourceId != null && objectNames.length > 0;
  const applying = applyMut.isPending || batchMut.isPending;
  const comparing = compareMut.isPending;
  // 当前意图 + 范围对应的结果：对比→字段差异 / 全量对比；同步→单对象写 / 批量写
  const activeResult = isCompare ? (isBatch ? compareResult : diff) : isBatch ? batchResult : applyResult;

  return (
    <div className="space-y-5">
      <PageHeader
        title="实例对比与同步"
        description="先「对比」理解两实例的差异（只读，不写设备），再「同步」把源推送到目标。两种意图分开：对比页只有对比按钮，写入口只在同步页出现。"
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr] lg:items-start">
        {/* 左：配置 */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader><CardTitle className="text-base">配置</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* 意图：对比（只读）/ 同步（写入） */}
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1">
              {(["compare", "sync"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    mode === m
                      ? m === "sync"
                        ? "bg-background text-amber-500 shadow-sm"
                        : "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "compare" ? "对比（只读）" : "同步（写入）"}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">对象类型</Label>
              <Select value={objectType} onValueChange={(v) => { setObjectType(v as ObjectType); setObjectNames([]); setMirror(false); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OBJECT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {isPolicy && (
                <p className="text-[11px] text-muted-foreground/70">
                  策略仅对比 <span className="text-foreground/70">应用控制 / 端口控制 / 代理控制</span> 三段及启用状态；
                  其余段（Web 关键字/文件类型过滤、邮件、QQ、SaaS 等）不参与对比，也不在差异里显示。
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">源实例</Label>
              <Select value={sourceId != null ? String(sourceId) : undefined} onValueChange={(v) => { setSourceId(Number(v)); setObjectNames([]); setMirror(false); }}>
                <SelectTrigger><SelectValue placeholder="选择源实例" /></SelectTrigger>
                <SelectContent>
                  {enabled.map((i) => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* 范围作为对象选择框的子选项：支持多选；「全部对象」与具体对象互斥（选中前者会清掉
                后者，反之亦然），见 onChange。选中 2 个及以上（含「全部对象」）都走批量渲染。 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {isCompare ? "对比范围" : "同步范围"} {names.isFetching && <Spinner className="ml-1 inline" />}
              </Label>
              <MultiCombobox
                options={[
                  { value: ALL_OBJECTS, label: `全部对象（${names.data?.length ?? 0} 个）` },
                  ...(names.data ?? []).map((n) => ({ value: n, label: n })),
                ]}
                value={objectNames}
                onChange={(next) => {
                  const wasAll = objectNames.includes(ALL_OBJECTS);
                  const nowAll = next.includes(ALL_OBJECTS);
                  const final =
                    !wasAll && nowAll
                      ? [ALL_OBJECTS] // 刚勾选「全部对象」：清掉其余单选
                      : wasAll && nowAll
                      ? next.filter((v) => v !== ALL_OBJECTS) // 全选下又点具体项：退出全选
                      : next;
                  setObjectNames(final);
                  // 镜像模式只对「全部对象」开放；一旦不再是全选就顺带关掉，避免残留状态导致后端拒绝
                  if (mirror && !(final.length === 1 && final[0] === ALL_OBJECTS)) setMirror(false);
                }}
                disabled={sourceId == null}
                placeholder={sourceId == null ? "请先选择源实例" : "选择一个或多个对象，或「全部对象」"}
                searchPlaceholder="输入关键字搜索…"
                emptyText="无匹配对象"
              />
              {isBatch && (
                <p className="text-[11px] text-muted-foreground">
                  {isCompare ? "将对比源与目标的" : "将把源的"}
                  <span className="text-foreground/70">
                    {isAll
                      ? `全部${OBJECT_TYPES.find((t) => t.value === objectType)?.label}`
                      : `已选 ${objectNames.length} 个${OBJECT_TYPES.find((t) => t.value === objectType)?.label}`}
                  </span>
                  {isCompare ? "（名单 + 内容）。" : "写入所选目标。"}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">目标实例</Label>
              <div className="flex flex-wrap gap-2">
                {targetCandidates.length === 0 && (
                  <span className="text-xs text-muted-foreground">无其他可用实例</span>
                )}
                {targetCandidates.map((i) => (
                  <Badge
                    key={i.id}
                    variant={targets.includes(i.id) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleTarget(i.id)}
                  >
                    {i.name}
                  </Badge>
                ))}
              </div>
            </div>

            {isBatch && !isCompare && isAll && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium text-amber-300/90">镜像模式</Label>
                  <p className="text-[11px] text-muted-foreground">删除目标上「源没有」的{OBJECT_TYPES.find((t) => t.value === objectType)?.label}</p>
                </div>
                <Switch checked={mirror} onCheckedChange={setMirror} />
              </div>
            )}
            {isBatch && !isCompare && !isAll && (
              <p className="text-[11px] text-muted-foreground/60">
                镜像模式（删除目标多余对象）仅支持「全部对象」，已选子集时不可用——否则会把未选中但双方都合法存在的对象误删。
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              {isCompare ? (
                // 对比（只读）：无写按钮。单对象→字段级差异；全部对象→「只对比名称」/「对比名称和内容」二选一。
                isBatch ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => compareMut.mutate({ namesOnly: true })}
                      disabled={!ready || targets.length === 0 || comparing}
                      title="只比对象名单：仅源有 / 仅目标有 / 两边都有（不拉详情，秒级）"
                    >
                      {comparing && compareMut.variables?.namesOnly === true ? <Spinner /> : <Scale className="h-4 w-4" />}
                      只对比名称
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => compareMut.mutate({ namesOnly: false })}
                      disabled={!ready || targets.length === 0 || comparing}
                      title="比名单 + 内容：仅源有 / 仅目标有 / 一致 / 不一致（逐对象拉详情，较慢）"
                    >
                      {comparing && compareMut.variables?.namesOnly === false ? <Spinner /> : <GitCompareArrows className="h-4 w-4" />}
                      对比名称和内容
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => diffMut.mutate()}
                    disabled={!ready || targets.length === 0 || diffMut.isPending}
                    title="比源与目标该对象的字段级差异，不写设备"
                  >
                    {diffMut.isPending ? <Spinner /> : <Scale className="h-4 w-4" />}
                    开始对比
                  </Button>
                )
              ) : (
                // 同步（写入）：先「同步预览」看将执行什么（dry-run），再确认写入。
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      isBatch
                        ? batchMut.mutate({ pushAll: false, dryRun: true })
                        : applyMut.mutate({ pushAll: false, dryRun: true })
                    }
                    disabled={!ready || targets.length === 0 || applying}
                    title="dry-run：只算并展示将执行的写操作（新增/覆盖/删除），不改设备"
                  >
                    {applying ? <Spinner /> : <GitCompareArrows className="h-4 w-4" />}
                    同步预览
                  </Button>
                  <Button onClick={() => setConfirmApply({ pushAll: false, batch: isBatch })} disabled={!ready || targets.length === 0 || applying}>
                    <ArrowRight className="h-4 w-4" />
                    {isBatch ? "批量同步到所选" : "同步到所选目标"}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmApply({ pushAll: true, batch: isBatch })} disabled={!ready || applying}>
                    <Rocket className="h-4 w-4" />
                    一键推送到全部
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 右：对比 / 同步 结果 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isCompare
                ? isBatch
                  ? isAll
                    ? "全部对象对比（只读）"
                    : "已选对象对比（只读）"
                  : "单个对象对比（只读）"
                : isBatch
                ? batchResult
                  ? batchResult.targets.some((t) => !t.dry_run)
                    ? "批量同步结果"
                    : "批量同步预览（dry-run）"
                  : "批量同步"
                : applyResult
                ? applyResult.results.some((r) => !r.dry_run)
                  ? "同步结果"
                  : "同步预览（dry-run）"
                : "同步"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 配置已变更：保留上次结果但标记过期，提示重新执行 */}
            {stale && activeResult && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs">
                <span className="text-amber-300/90">配置已变更，下方为上一次的结果（已过期）。</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0"
                  onClick={() =>
                    isCompare
                      ? isBatch
                        ? compareMut.mutate({ namesOnly: compareResult?.names_only ?? false })
                        : diffMut.mutate()
                      : isBatch
                      ? batchMut.mutate({ pushAll: false, dryRun: true })
                      : applyMut.mutate({ pushAll: false, dryRun: true })
                  }
                  disabled={!ready || targets.length === 0 || diffMut.isPending || applying || comparing}
                >
                  {diffMut.isPending || applying || comparing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {isCompare ? "重新对比" : "重新预览"}
                </Button>
              </div>
            )}

            <div className={stale ? "pointer-events-none opacity-40 transition-opacity" : "transition-opacity"}>
              <div className="space-y-3">
                {isCompare ? (
                  isBatch ? (
                    compareResult ? (
                      <>
                        <div className="text-xs text-muted-foreground">
                          源共 {compareResult.source_count} 个对象 ·{" "}
                          {compareResult.names_only
                            ? "只对比名称（仅比对象名单，未拉内容）"
                            : "对比名称和内容（逐对象，只读不写设备）"}
                          {!compareResult.names_only && compareResult.source_cached && (
                            <span className="text-amber-500/80" title="源快照来自缓存；写操作后或缓存过期会自动重取">
                              {" "}· 源快照缓存{
                                compareResult.source_cache_age_seconds < 60
                                  ? "刚刚"
                                  : `${Math.floor(compareResult.source_cache_age_seconds / 60)}分钟前`
                              }
                            </span>
                          )}
                        </div>
                        {compareResult.targets.map((t) => (
                          <CompareResultCard
                            key={t.instance_id}
                            t={t}
                            objectType={objectType}
                            namesOnly={compareResult.names_only}
                          />
                        ))}
                      </>
                    ) : (
                      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                        配置左侧后点击「只对比名称」或「对比名称和内容」
                      </div>
                    )
                  ) : diff ? (
                    <>
                      <SourceSummary data={diff.source_snapshot as Record<string, unknown>} objectType={objectType} />
                      {diff.targets.map((t) => (
                        <TargetCard
                          key={t.instance_id}
                          t={t}
                          src={diff.source_snapshot as Record<string, unknown>}
                          objectType={objectType}
                          sourceName={sourceName}
                        />
                      ))}
                    </>
                  ) : (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      配置左侧后点击「开始对比」
                    </div>
                  )
                ) : isBatch ? (
                  batchResult ? (
                    <>
                      <div className="text-xs text-muted-foreground">
                        源共 {batchResult.source_count} 个对象{batchResult.mirror && <span className="text-amber-300/90"> · 镜像模式（删除目标多余）</span>}
                      </div>
                      {batchResult.targets.map((t) => (
                        <BatchResultCard key={t.instance_id} t={t} objectType={batchResult.object_type} />
                      ))}
                    </>
                  ) : (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      配置左侧后点击「同步预览」，或直接「批量同步 / 一键推送」（会先弹确认）
                    </div>
                  )
                ) : applyResult ? (
                  applyResult.results.map((r) => <ApplyResultCard key={r.instance_id} r={r} />)
                ) : (
                  <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    配置左侧后点击「同步预览」，或直接「同步 / 一键推送」（会先弹确认）
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 真实写入二次确认 */}
      <Dialog open={confirmApply != null} onOpenChange={(v) => !v && setConfirmApply(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmApply?.batch ? "确认批量同步" : "确认同步"}</DialogTitle>
            <DialogDescription>
              「确认写入」会真实修改下列目标实例的配置，操作不可自动撤销；如仅想查看将提交的内容，请选「仅预览」。
            </DialogDescription>
          </DialogHeader>
          {confirmApply &&
            (() => {
              const effective = confirmApply.pushAll
                ? enabled.filter((i) => i.id !== sourceId)
                : enabled.filter((i) => targets.includes(i.id));
              const typeLabel = OBJECT_TYPES.find((t) => t.value === objectType)?.label;
              return (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <span className="text-muted-foreground">对象类型</span>
                    <span>{typeLabel}</span>
                    <span className="text-muted-foreground">{confirmApply.batch ? "范围" : "对象"}</span>
                    <span className="font-medium">
                      {confirmApply.batch
                        ? isAll
                          ? `全部${typeLabel}${names.data ? `（${names.data.length} 个）` : ""}`
                          : `已选 ${objectNames.length} 个${typeLabel}`
                        : singleObjectName}
                    </span>
                    <span className="text-muted-foreground">源实例</span>
                    <span>{sourceName}</span>
                    <span className="text-muted-foreground">目标实例</span>
                    <span className="flex flex-wrap gap-1">
                      {effective.length === 0 ? (
                        <span className="text-muted-foreground">无可用目标</span>
                      ) : (
                        effective.map((i) => (
                          <Badge key={i.id} variant="secondary">
                            {i.name}
                          </Badge>
                        ))
                      )}
                    </span>
                  </div>
                  {confirmApply.batch && mirror && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-xs text-red-300/90">
                      已开启<span className="font-medium">镜像模式</span>：目标上「源没有」的{typeLabel}会被<span className="font-medium">删除</span>。请务必先「仅预览」核对删除清单。
                    </div>
                  )}
                  {isPolicy && (
                    <div className="space-y-2">
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300/90">
                        访问权限策略会按目标设备的 crc 重建报文写入：目标缺少的「自定义」应用 / URL 库会自动先建到目标；
                        但若目标有<span className="font-medium">无法解析的引用</span>（内置对象缺失、或自定义引用创建失败），丢掉它会写出与源<span className="font-medium">不等价（降级）</span>的策略（如拒绝规则少挡了对象=安全缺口）。此时<span className="font-medium">默认拒绝写入策略</span>（已建的自定义对象会保留在目标）。建议先「仅预览」核对。
                        另外：若源和目标<span className="font-medium">已存在同名</span>的自定义应用 / URL 库但<span className="font-medium">内容不同</span>，不会被识别为差异——策略同步只按名字重映射引用，不会比对或覆盖这些对象本身的内容。
                      </div>
                      <label className="flex items-start gap-2 rounded-md border border-rose-500/25 bg-rose-500/[0.05] px-3 py-2 text-xs text-rose-300/90">
                        <input
                          type="checkbox"
                          checked={allowDegrade}
                          onChange={(e) => setAllowDegrade(e.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-rose-500"
                        />
                        <span>
                          <span className="font-medium">允许降级同步</span>：目标有无法解析的引用（内置缺失或自定义引用创建失败）时，仍写入丢弃了这些引用的
                          <span className="font-medium">不等价版本</span>（不勾则遇到此情况会被拒绝、不写策略）。
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              );
            })()}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() =>
                (confirmApply!.batch ? batchMut : applyMut).mutate({ pushAll: confirmApply!.pushAll, dryRun: true })
              }
              disabled={applying}
            >
              {applying && <Spinner />}
              仅预览（dry-run）
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                (confirmApply!.batch ? batchMut : applyMut).mutate({ pushAll: confirmApply!.pushAll, dryRun: false })
              }
              disabled={applying}
            >
              {applying ? <Spinner /> : <ArrowRight className="h-4 w-4" />}
              确认写入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
