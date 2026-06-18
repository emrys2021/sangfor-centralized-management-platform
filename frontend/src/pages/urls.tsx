import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { CenteredSpinner, EmptyState, PageHeader, Spinner } from "@/components/common";
import { DataTable } from "@/components/data-table";
import { NoInstance } from "@/components/no-instance";
import { UrlGroupFormDialog } from "@/components/url-form";
import { WritePreviewDialog } from "@/components/write-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCurrentInstance } from "@/hooks/use-current-instance";
import { urlApi } from "@/lib/api";
import type { UrlGroupForm, UrlNode, WriteResult } from "@/lib/types";

export function UrlsPage() {
  const { instanceId } = useCurrentInstance();
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [formReadOnly, setFormReadOnly] = useState(false);
  const [formInitial, setFormInitial] = useState<UrlGroupForm | undefined>(undefined);
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);

  const list = useQuery({
    queryKey: ["urls", instanceId],
    queryFn: () => urlApi.list(instanceId!),
    enabled: instanceId != null,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["urls", instanceId] });
    qc.invalidateQueries({ queryKey: ["url-content", instanceId] });
  };

  const del = useMutation({
    mutationFn: (name: string) => urlApi.remove(instanceId!, name, false),
    onSuccess: (r) => {
      setWriteResult(r);
      invalidate();
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "删除失败"),
  });

  function openCreate() {
    setFormMode("create");
    setFormReadOnly(false);
    setFormInitial(undefined);
    setFormOpen(true);
  }

  // 点击 URL 类别：取库内明细并以对话框打开（自定义=可编辑，内置=只读查看）。
  // 经 React Query 缓存（staleTime 5 分钟）：同一库窗口内再次点开秒回、不再请求设备。
  async function openLibrary(node: UrlNode) {
    if (instanceId == null || loadingName) return;
    const name = node.name;
    try {
      setLoadingName(name);
      const c = await qc.fetchQuery({
        queryKey: ["url-content", instanceId, name],
        queryFn: () => urlApi.content(instanceId, name),
        staleTime: 5 * 60 * 1000,
      });
      setFormInitial({ name: c.name, depict: c.depict, url: c.url_text, keyword: c.keyword });
      setFormReadOnly(!!node.inside); // 内置库只读
      setFormMode("edit");
      setFormOpen(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail ?? "加载详情失败");
    } finally {
      setLoadingName(null);
    }
  }

  const columns = useMemo<ColumnDef<UrlNode, any>[]>(
    () => [
      {
        accessorKey: "name",
        header: "URL 类别名称",
        cell: ({ row, getValue }) => {
          const name = String(getValue() ?? "");
          return (
            <span
              className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
              style={{ paddingLeft: `${(row.original.level - 1) * 16}px` }}
            >
              {loadingName === name && <Spinner />}
              {name}
            </span>
          );
        },
      },
      {
        accessorKey: "depict",
        header: "描述",
        cell: ({ getValue }) => (
          <div className="max-w-[520px] truncate text-xs text-muted-foreground" title={String(getValue() ?? "")}>
            {String(getValue() ?? "") || "—"}
          </div>
        ),
      },
      {
        id: "type",
        header: "类型",
        accessorFn: (row) => (row.inside ? "内置" : "自定义"),
        cell: ({ getValue }) =>
          getValue() === "内置" ? <Badge variant="secondary">内置</Badge> : <Badge variant="default">自定义</Badge>,
      },
      {
        id: "delete",
        header: "删除",
        enableSorting: false,
        enableColumnFilter: false,
        cell: ({ row }) => {
          const node = row.original;
          const name = String(node.name);
          if (node.inside) {
            // 内置库不可删除（与原生一致，置灰）
            return <X className="h-4 w-4 text-muted-foreground/30" />;
          }
          return (
            <button
              type="button"
              title="删除"
              className="text-destructive transition-opacity hover:opacity-70"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`确认删除 URL 库「${name}」？该操作会真实写入设备且不可撤销。`)) del.mutate(name);
              }}
            >
              <X className="h-4 w-4" />
            </button>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadingName]
  );

  if (instanceId == null) return <NoInstance />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="自定义 URL 库"
        description="AC 上的 URL 分类库。点击类别名打开对话框（自定义库可编辑、内置库只读）；可新增、删除自定义库。"
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">共 {list.data?.flat.length ?? 0} 个分类</Badge>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> 新增
            </Button>
          </div>
        }
      />

      {list.isLoading ? (
        <Card>
          <CenteredSpinner label="加载 URL 库…" />
        </Card>
      ) : list.isError ? (
        <Card>
          <EmptyState title="加载失败" hint={(list.error as any)?.response?.data?.detail} />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={list.data?.flat ?? []}
          globalFilterPlaceholder="全局搜索名称 / 描述…"
          onRowClick={(n) => openLibrary(n)}
          emptyText="暂无 URL 分类"
        />
      )}

      <UrlGroupFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        instanceId={instanceId}
        mode={formMode}
        readOnly={formReadOnly}
        initial={formInitial}
        onDone={(r) => {
          setWriteResult(r);
          if (!r.dry_run) invalidate();
        }}
      />

      <WritePreviewDialog
        open={writeResult != null}
        onOpenChange={(v) => !v && setWriteResult(null)}
        title="URL 库写操作"
        result={writeResult}
      />
    </div>
  );
}
