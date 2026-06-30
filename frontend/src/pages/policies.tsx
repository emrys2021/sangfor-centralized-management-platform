import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Ban, Check, Minus, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { CenteredSpinner, EmptyState, PageHeader, Spinner } from "@/components/common";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { NoInstance } from "@/components/no-instance";
import { PolicyDialog } from "@/components/policy-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WritePreviewDialog } from "@/components/write-preview";
import { useCurrentInstance } from "@/hooks/use-current-instance";
import { policyApi } from "@/lib/api";
import type { PolicyDetail, PolicyInfo, WriteResult } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PoliciesPage() {
  const { instanceId } = useCurrentInstance();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [editDetail, setEditDetail] = useState<PolicyDetail | null>(null);
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);

  const list = useQuery({
    queryKey: ["policies", instanceId],
    queryFn: () => policyApi.list(instanceId!),
    enabled: instanceId != null,
  });

  const allNames = useMemo(
    () =>
      [...(list.data?.access_policies ?? []), ...(list.data?.ssl_decrypt_policies ?? [])].map((p) =>
        String(p.name)
      ),
    [list.data]
  );

  function openCreate() {
    setEditDetail(null);
    setDialogMode("create");
    setDialogOpen(true);
  }

  // 点击策略名/行：取详情（缓存）并以同一对话框编辑（替代右侧详情面板）
  async function openEdit(name: string) {
    if (instanceId == null || loadingName) return;
    try {
      setLoadingName(name);
      const d = await queryClient.fetchQuery({
        queryKey: ["policy", instanceId, name],
        queryFn: () => policyApi.get(instanceId, name),
        staleTime: 5 * 60 * 1000,
      });
      setEditDetail(d);
      setDialogMode("edit");
      setDialogOpen(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail ?? "加载详情失败");
    } finally {
      setLoadingName(null);
    }
  }

  // 上移 / 下移：调整顺序后刷新列表
  const move = useMutation({
    mutationFn: (v: { name: string; direction: "up" | "down" }) =>
      policyApi.move(instanceId!, v.name, v.direction),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["policies", instanceId] }),
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "移动失败"),
  });

  // 批量启用 / 禁用
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const batch = useMutation({
    mutationFn: (v: { names: string[]; enabled: boolean }) =>
      policyApi.setStatus(instanceId!, v.names, v.enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["policies", instanceId] });
      setSelectedNames(new Set());
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "操作失败"),
  });
  const toggleSel = (name: string) =>
    setSelectedNames((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  // 删除策略：二次确认后直接真实写入（opr=delete，已据真实抓包确认）
  const del = useMutation({
    mutationFn: (name: string) => policyApi.remove(instanceId!, name, false),
    onSuccess: (r) => {
      setWriteResult(r);
      queryClient.invalidateQueries({ queryKey: ["policies", instanceId] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "删除失败"),
  });

  const columns = useMemo<ColumnDef<PolicyInfo, any>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableColumnFilter: false,
        header: ({ table }) => {
          const names = table.getRowModel().rows.map((r) => String(r.original.name));
          const allSel = names.length > 0 && names.every((n) => selectedNames.has(n));
          return (
            <input
              type="checkbox"
              aria-label="全选"
              checked={allSel}
              onChange={() =>
                setSelectedNames((prev) => {
                  const next = new Set(prev);
                  if (allSel) names.forEach((n) => next.delete(n));
                  else names.forEach((n) => next.add(n));
                  return next;
                })
              }
              className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
            />
          );
        },
        cell: ({ row }) => {
          const name = String(row.original.name);
          return (
            <input
              type="checkbox"
              checked={selectedNames.has(name)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleSel(name)}
              className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
            />
          );
        },
      },
      {
        id: "order",
        header: "序号",
        accessorFn: (p) => Number(p.order ?? p.inorder ?? 0),
        enableColumnFilter: false,
        cell: ({ getValue }) => <span className="tabular-nums text-muted-foreground">{String(getValue() ?? "")}</span>,
      },
      {
        accessorKey: "name",
        header: "策略名称",
        cell: ({ getValue }) => {
          const v = String(getValue() ?? "");
          return (
            <span className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
              {loadingName === v && <Spinner />}
              {v}
            </span>
          );
        },
      },
      {
        accessorKey: "applies_to",
        header: "适用用户",
        enableColumnFilter: false,
        cell: ({ getValue }) => {
          const v = String(getValue() ?? "");
          return (
            <div className="max-w-[320px] truncate text-xs text-muted-foreground" title={v}>
              {v || "—"}
            </div>
          );
        },
      },
      {
        accessorKey: "location",
        header: "适用位置",
        cell: ({ getValue }) => <span className="text-xs text-muted-foreground">{String(getValue() ?? "") || "—"}</span>,
      },
      {
        accessorKey: "target_area",
        header: "适用目标区域",
        cell: ({ getValue }) => <span className="text-xs text-muted-foreground">{String(getValue() ?? "") || "—"}</span>,
      },
      {
        accessorKey: "founder",
        header: "策略管理员",
        cell: ({ getValue }) => <span className="text-xs">{String(getValue() ?? "")}</span>,
      },
      {
        id: "move",
        header: "上移/下移",
        enableSorting: false,
        enableColumnFilter: false,
        cell: ({ row, table }) => {
          const name = String(row.original.name);
          const rows = table.getRowModel().rows;
          const pos = rows.findIndex((r) => r.id === row.id);
          const isFirst = pos === 0;
          const isLast = pos === rows.length - 1;
          return (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                title="上移"
                disabled={isFirst || move.isPending}
                onClick={() => move.mutate({ name, direction: "up" })}
                className={cn(
                  "transition-opacity hover:opacity-70 disabled:cursor-not-allowed",
                  isFirst ? "text-muted-foreground/30" : "text-emerald-500"
                )}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="下移"
                disabled={isLast || move.isPending}
                onClick={() => move.mutate({ name, direction: "down" })}
                className={cn(
                  "transition-opacity hover:opacity-70 disabled:cursor-not-allowed",
                  isLast ? "text-muted-foreground/30" : "text-rose-500"
                )}
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            </div>
          );
        },
      },
      {
        accessorKey: "expire",
        header: "过期日期",
        enableColumnFilter: false,
        cell: ({ getValue }) => {
          const v = String(getValue() ?? "");
          return (
            <span className={cn("text-xs", v === "已过期" ? "text-destructive" : "text-muted-foreground")}>
              {v || "—"}
            </span>
          );
        },
      },
      {
        id: "status",
        header: "状态",
        accessorFn: (p) => (p.status ? "启用" : "禁用"),
        cell: ({ getValue }) =>
          getValue() === "启用" ? (
            <Check className="h-4 w-4 text-emerald-500" />
          ) : (
            <Minus className="h-4 w-4 text-muted-foreground" />
          ),
      },
      {
        id: "delete",
        header: "删除",
        enableSorting: false,
        enableColumnFilter: false,
        cell: ({ row }) => {
          const name = String(row.original.name);
          return (
            <button
              type="button"
              title="删除"
              className="text-destructive transition-opacity hover:opacity-70 disabled:opacity-40"
              disabled={del.isPending}
              onClick={async (e) => {
                e.stopPropagation();
                if (
                  await confirm({
                    title: "删除访问权限策略",
                    description: `确认删除策略「${name}」？将真实写入设备，且不可撤销。`,
                    variant: "destructive",
                    confirmText: "删除",
                  })
                )
                  del.mutate(name);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [move.isPending, del.isPending, selectedNames, loadingName]
  );

  if (instanceId == null) return <NoInstance />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="访问权限策略"
        description="AC 上的访问权限策略。点击策略名打开仿原生对话框编辑（启用/名称/描述 + 应用控制规则）；可新增、删除。"
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">访问权限 {list.data?.access_policies.length ?? 0}</Badge>
            <Badge variant="outline">SSL 解密 {list.data?.ssl_decrypt_policies.length ?? 0}</Badge>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" /> 新增
            </Button>
          </div>
        }
      />

      {list.isLoading ? (
        <Card>
          <CenteredSpinner label="加载策略…" />
        </Card>
      ) : list.isError ? (
        <Card>
          <EmptyState title="加载失败" hint={(list.error as any)?.response?.data?.detail} />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={list.data?.access_policies ?? []}
          globalFilterPlaceholder="全局搜索策略名…"
          onRowClick={(p) => openEdit(String(p.name))}
          emptyText="暂无访问权限策略"
          toolbar={
            <>
              {selectedNames.size > 0 && (
                <span className="text-xs text-muted-foreground">已选 {selectedNames.size}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={selectedNames.size === 0 || batch.isPending}
                onClick={() => batch.mutate({ names: [...selectedNames], enabled: true })}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> 启用
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={selectedNames.size === 0 || batch.isPending}
                onClick={() => batch.mutate({ names: [...selectedNames], enabled: false })}
              >
                <Ban className="mr-1 h-3.5 w-3.5" /> 禁用
              </Button>
            </>
          }
        />
      )}

      <PolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        instanceId={instanceId}
        detail={editDetail}
        existingNames={allNames}
        onDone={(r) => {
          setWriteResult(r);
          if (!r.dry_run) {
            queryClient.invalidateQueries({ queryKey: ["policies", instanceId] });
            queryClient.invalidateQueries({ queryKey: ["policy", instanceId] });
          }
        }}
      />

      <WritePreviewDialog
        open={writeResult != null}
        onOpenChange={(v) => !v && setWriteResult(null)}
        title="策略写操作"
        result={writeResult}
      />
    </div>
  );
}
