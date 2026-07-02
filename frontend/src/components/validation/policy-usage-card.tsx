import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CenteredSpinner, EmptyState } from "@/components/common";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { policyApi } from "@/lib/api";
import type { PolicyUsageItem } from "@/lib/types";

function formatCacheAge(seconds?: number | null): string {
  if (seconds == null) return "";
  if (seconds < 5) return " · 刚刚";
  if (seconds < 60) return ` · ${seconds}秒前`;
  return ` · ${Math.floor(seconds / 60)}分钟前`;
}

/**
 * 策略引用校验：列出全部访问权限策略、标出无人引用的（创建后没人用），可单条删除或一键清理。
 *
 * 「被引用」= 设备算好的「用户生效策略」（组默认 + 用户添加 − 排除）的并集；无人引用即补集。
 */
export function PolicyUsageCard({ instanceId }: { instanceId: number }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["policy-usage", instanceId],
    queryFn: () => policyApi.usage(instanceId),
    staleTime: 5 * 60 * 1000,
  });
  const refresh = useMutation({
    mutationFn: () => policyApi.usage(instanceId, true),
    onSuccess: (d) => qc.setQueryData(["policy-usage", instanceId], d),
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "校验失败"),
  });
  const analyzing = q.isFetching || refresh.isPending;
  const data = q.data;
  const policies = data?.policies ?? [];
  const unused = policies.filter((p) => !p.used);
  // 有组读取失败时，「无人引用」结果不可信：失败组的用户没统计到，其正在用的策略会被误判为无人引用。
  // 此时禁止「一键清理」（批量、不可逆），必须先「重新校验」到 0 失败。
  const failedGroups = data?.errors ?? [];
  const hasErrors = failedGroups.length > 0;

  async function deleteOne(name: string) {
    const ok = await confirm({
      title: "删除访问权限策略",
      description: hasErrors ? (
        <div className="space-y-2">
          <p>确认删除策略「{name}」？将真实写入设备，且不可撤销。</p>
          <p className="text-rose-300">
            注意：本次有组读取失败，「无人引用」判断可能不准——请确认这条<span className="font-medium">确实没人在用</span>再删。
          </p>
        </div>
      ) : (
        `确认删除策略「${name}」？将真实写入设备，且不可撤销。`
      ),
      variant: "destructive",
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      setBusy(true);
      await policyApi.remove(instanceId, name, false);
      toast.success(`已删除「${name}」`);
      refresh.mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail ?? "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function clearAllUnused() {
    if (unused.length === 0 || hasErrors) return; // 有组读取失败时禁止批量清理（防误删在用策略）
    setBusy(true);
    try {
      // B1：删除前**强制重新校验**，用最新结果做删除依据，避免拿过期分析误删「已变成有人引用」的策略。
      const fresh = await policyApi.usage(instanceId, true);
      qc.setQueryData(["policy-usage", instanceId], fresh);
      if (fresh.errors.length > 0) {
        toast.error(`重新校验后有 ${fresh.errors.length} 个组读取失败，「无人引用」不可信，已中止清理`);
        return;
      }
      const freshUnused = fresh.policies.filter((p) => !p.used);
      if (freshUnused.length === 0) {
        toast.info("重新校验后已无「无人引用」的策略，无需清理");
        return;
      }
      // 旧清单里、重新校验后已变成「有人引用」（或已不在无人引用里）的条数——已自动从本次清理移除
      const freshNames = new Set(freshUnused.map((p) => p.name));
      const dropped = unused.filter((p) => !freshNames.has(p.name)).length;

      const ok = await confirm({
        title: `清理 ${freshUnused.length} 条无人引用的策略`,
        description: (
          <div className="space-y-2">
            {dropped > 0 && (
              <p className="text-amber-300">
                重新校验后有 {dropped} 条已变成「有人引用」，已自动从本次清理移除。
              </p>
            )}
            <p>
              以下策略经<span className="font-medium text-foreground">最新</span>校验确认无人引用，将真实删除、不可撤销。请核对清单：
            </p>
            <div className="max-h-52 space-y-0.5 overflow-auto rounded border p-2 text-xs">
              {freshUnused.map((p) => (
                <div key={p.name} className="break-all">
                  {p.name}
                  {p.depict && <span className="text-muted-foreground"> — {p.depict}</span>}
                </div>
              ))}
            </div>
          </div>
        ),
        variant: "destructive",
        confirmText: `删除这 ${freshUnused.length} 条`,
      });
      if (!ok) return;

      let failed = 0;
      for (const p of freshUnused) {
        try {
          await policyApi.remove(instanceId, p.name, false);
        } catch {
          failed += 1;
        }
      }
      if (failed === 0) toast.success(`已清理 ${freshUnused.length} 条无人引用的策略`);
      else toast.warning(`清理完成，${failed} 条失败`);
      refresh.mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail ?? "重新校验失败，已中止清理");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">策略引用校验</span>
            {data && (
              <span className="text-xs text-muted-foreground">
                共 {data.total_policies} 条 · 无人引用{" "}
                <span className={data.unused_count > 0 ? "text-rose-400" : "text-emerald-400"}>
                  {data.unused_count}
                </span>{" "}
                · 已统计 {data.total_users} 个用户
                {data.cached && (
                  <span className="ml-1 text-amber-500/80" title="结果来自缓存，点「重新校验」强制重算">
                    （缓存{formatCacheAge(data.cache_age_seconds)}）
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unused.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={clearAllUnused}
                disabled={busy || analyzing || hasErrors}
                title={
                  hasErrors
                    ? "有组读取失败，「无人引用」结果不可信，已禁用批量清理，请先「重新校验」到 0 失败"
                    : undefined
                }
              >
                <Trash2 className="h-3.5 w-3.5" /> 一键清理无人引用（{unused.length}）
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={analyzing}>
              <RefreshCw className={analyzing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> 重新校验
            </Button>
          </div>
        </div>

        {q.isLoading ? (
          <CenteredSpinner label="正在遍历组织树、统计每条策略的引用用户…" />
        ) : q.isError ? (
          <EmptyState
            title="校验失败"
            hint={(q.error as any)?.response?.data?.detail ?? "请求超时或网络异常，可点「重新校验」重试"}
          />
        ) : policies.length === 0 ? (
          <EmptyState title="没有访问权限策略" />
        ) : (
          <>
            {hasErrors && (
              <div className="space-y-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
                <div className="flex items-center gap-1.5 font-medium text-rose-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {failedGroups.length} 个组读取失败——「无人引用」结果不可信，已禁用「一键清理」
                </div>
                <p className="text-rose-300/90">
                  这些组的用户没统计到，它们正在用的策略会被<span className="font-medium">误判成「无人引用」</span>；
                  此时批量清理可能<span className="font-medium">误删实际在用的策略（不可逆）</span>。请先点右上「重新校验」，
                  直到<span className="font-medium">0 个失败</span>，再清理。单条删除仍可用，但请自行确认该条确实无人使用。
                </p>
                <details className="text-rose-300/80">
                  <summary className="cursor-pointer select-none">查看失败的组（{failedGroups.length}）</summary>
                  <div className="mt-1 max-h-32 space-y-0.5 overflow-auto rounded border border-rose-500/20 p-2">
                    {failedGroups.map((e, i) => (
                      <div key={i} className="break-all">{e}</div>
                    ))}
                  </div>
                </details>
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-white/10">
              <div className="grid grid-cols-[40px_1fr_120px_90px_70px_50px] gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2 text-[11px] font-medium text-muted-foreground">
                <span>序号</span>
                <span>策略名称</span>
                <span>创建者</span>
                <span>引用用户</span>
                <span>状态</span>
                <span className="text-right">操作</span>
              </div>
              <div className="max-h-[460px] divide-y divide-white/5 overflow-auto">
                {policies.map((p: PolicyUsageItem) => (
                  <div
                    key={p.name}
                    className={`grid grid-cols-[40px_1fr_120px_90px_70px_50px] items-center gap-2 px-3 py-2 text-xs transition-colors ${
                      p.used ? "hover:bg-white/[0.02]" : "bg-rose-500/[0.07]"
                    }`}
                  >
                    <span className="text-muted-foreground">{p.order}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium" title={p.name}>
                          {p.name}
                        </span>
                        {!p.used && <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[10px]">无人引用</Badge>}
                      </div>
                      {p.depict && (
                        <div className="truncate text-[11px] text-muted-foreground" title={p.depict}>
                          {p.depict}
                        </div>
                      )}
                    </div>
                    <span className="truncate text-muted-foreground" title={p.founder}>
                      {p.founder || "—"}
                    </span>
                    <span className={p.used ? "text-foreground/80" : "text-rose-400"}>{p.user_count} 人</span>
                    <span>
                      {p.status ? (
                        <Badge variant="success" className="h-4 px-1 text-[10px]">启用</Badge>
                      ) : (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">禁用</Badge>
                      )}
                    </span>
                    <div className="text-right">
                      <button
                        type="button"
                        title="删除该策略"
                        className="text-destructive transition-opacity hover:opacity-70 disabled:opacity-40"
                        disabled={busy}
                        onClick={() => deleteOne(p.name)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
