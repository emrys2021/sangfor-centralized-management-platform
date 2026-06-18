import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Minus, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { CenteredSpinner, EmptyState, PageHeader, Spinner } from "@/components/common";
import { CustomRuleFormDialog, emptyCustomRuleForm } from "@/components/customrule-form";
import { DataTable } from "@/components/data-table";
import { NoInstance } from "@/components/no-instance";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WritePreviewDialog } from "@/components/write-preview";
import { useCurrentInstance } from "@/hooks/use-current-instance";
import { customRuleApi } from "@/lib/api";
import type { CustomRule, CustomRuleForm, WriteResult } from "@/lib/types";

export function CustomRulesPage() {
  const { instanceId } = useCurrentInstance();
  const qc = useQueryClient();
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [formInitial, setFormInitial] = useState<CustomRuleForm>(emptyCustomRuleForm);
  const [editLoading, setEditLoading] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["customrules", instanceId],
    queryFn: () => customRuleApi.list(instanceId!),
    enabled: instanceId != null,
  });

  const del = useMutation({
    mutationFn: (name: string) => customRuleApi.remove(instanceId!, name, false),
    onSuccess: (r) => {
      setWriteResult(r);
      qc.invalidateQueries({ queryKey: ["customrules", instanceId] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "操作失败"),
  });

  function openCreate() {
    setFormMode("create");
    setFormInitial(emptyCustomRuleForm);
    setFormOpen(true);
  }

  // 点击规则名 / 行：拉取详情并以「编辑自定义应用」对话框打开（替代右侧详情页）。
  // 经 React Query 缓存（staleTime 5 分钟）：同一规则在窗口内再次点开秒回、不再请求设备。
  async function openEditByName(name: string) {
    if (instanceId == null || editLoading) return;
    try {
      setEditLoading(name);
      const d = await qc.fetchQuery({
        queryKey: ["customrule", instanceId, name],
        queryFn: () => customRuleApi.get(instanceId, name),
        staleTime: 5 * 60 * 1000,
      });
      setFormMode("edit");
      setFormInitial(d.form);
      setFormOpen(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail ?? "加载详情失败");
    } finally {
      setEditLoading(null);
    }
  }

  const columns = useMemo<ColumnDef<CustomRule, any>[]>(
    () => [
      {
        id: "seq",
        header: "序号",
        enableSorting: false,
        enableColumnFilter: false,
        cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.index + 1}</span>,
      },
      {
        accessorKey: "rulename",
        header: "规则名称",
        cell: ({ getValue }) => {
          const name = String(getValue() ?? "");
          return (
            <span className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
              {editLoading === name && <Spinner />}
              {name}
            </span>
          );
        },
      },
      {
        accessorKey: "depict",
        header: "描述",
        cell: ({ getValue }) => (
          <div className="max-w-[280px] truncate text-xs text-muted-foreground" title={String(getValue() ?? "")}>
            {String(getValue() ?? "") || "—"}
          </div>
        ),
      },
      {
        accessorKey: "apptype",
        header: "应用类型",
        cell: ({ getValue }) => String(getValue() ?? ""),
      },
      {
        accessorKey: "appname",
        header: "应用名称",
        cell: ({ getValue }) => String(getValue() ?? ""),
      },
      {
        accessorKey: "status",
        header: "状态",
        enableColumnFilter: false,
        cell: ({ getValue }) =>
          getValue() ? (
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
          const name = String(row.original.rulename);
          return (
            <button
              type="button"
              title="删除"
              className="text-destructive transition-opacity hover:opacity-70"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`确认删除「${name}」？将真实写入设备，且不可撤销。`)) del.mutate(name);
              }}
            >
              <X className="h-4 w-4" />
            </button>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editLoading]
  );

  if (instanceId == null) return <NoInstance />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="自定义应用"
        description="AC 上的自定义应用识别规则。点击规则名打开编辑对话框；可新增、删除。"
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> 新增自定义应用
          </Button>
        }
      />

      {list.isLoading ? (
        <Card>
          <CenteredSpinner label="加载自定义规则…" />
        </Card>
      ) : list.isError ? (
        <Card>
          <EmptyState title="加载失败" hint={(list.error as any)?.response?.data?.detail} />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          globalFilterPlaceholder="全局搜索规则名 / 描述 / 应用…"
          onRowClick={(r) => openEditByName(String(r.rulename))}
          emptyText="暂无自定义规则"
        />
      )}

      {instanceId != null && (
        <CustomRuleFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          mode={formMode}
          instanceId={instanceId}
          initial={formInitial}
          onDone={(r) => {
            setWriteResult(r);
            qc.invalidateQueries({ queryKey: ["customrules", instanceId] });
            // 真实写入后该规则详情已变，失效其缓存，下次点开取最新
            if (!r.dry_run) qc.invalidateQueries({ queryKey: ["customrule", instanceId] });
          }}
        />
      )}

      <WritePreviewDialog
        open={writeResult != null}
        onOpenChange={(v) => !v && setWriteResult(null)}
        title="自定义应用写操作"
        result={writeResult}
      />
    </div>
  );
}
