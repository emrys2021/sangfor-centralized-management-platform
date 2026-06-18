import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CenteredSpinner, JsonView, PageHeader } from "@/components/common";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { auditApi } from "@/lib/api";
import type { AuditLog } from "@/lib/types";

const OBJECT_TYPES = ["", "instance", "customrule", "url", "policy", "sync"];
const ACTIONS = ["", "create", "update", "delete", "sync", "dry_run"];

function safeParse(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function AuditPage() {
  const [objectType, setObjectType] = useState("");
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AuditLog | null>(null);
  const pageSize = 20;

  // 输入防抖：停止输入 300ms 后再查询，避免每个字符都打一次请求
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const query = useQuery({
    queryKey: ["audit", objectType, action, debouncedSearch, page],
    queryFn: () =>
      auditApi.list({
        object_type: objectType || undefined,
        action: action || undefined,
        search: debouncedSearch || undefined,
        page,
        page_size: pageSize,
      }),
    placeholderData: (prev) => prev,
  });

  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const columns = useMemo<ColumnDef<AuditLog, any>[]>(
    () => [
      {
        accessorKey: "created_at",
        header: "时间",
        enableColumnFilter: false,
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {new Date(String(getValue())).toLocaleString()}
          </span>
        ),
      },
      { accessorKey: "actor", header: "操作人" },
      {
        accessorKey: "instance_name",
        header: "实例",
        cell: ({ getValue }) => <span className="text-xs">{String(getValue() ?? "") || "—"}</span>,
      },
      {
        accessorKey: "object_type",
        header: "对象类型",
        cell: ({ getValue }) => <Badge variant="secondary">{String(getValue() ?? "")}</Badge>,
      },
      {
        accessorKey: "object_name",
        header: "对象",
        cell: ({ getValue }) => (
          <div className="max-w-[200px] truncate text-xs" title={String(getValue() ?? "")}>
            {String(getValue() ?? "") || "—"}
          </div>
        ),
      },
      {
        accessorKey: "action",
        header: "动作",
        cell: ({ getValue }) => (
          <Badge variant={getValue() === "dry_run" ? "warning" : "default"}>{String(getValue() ?? "")}</Badge>
        ),
      },
      {
        accessorKey: "success",
        header: "结果",
        enableColumnFilter: false,
        cell: ({ getValue }) =>
          getValue() ? <Badge variant="success">成功</Badge> : <Badge variant="destructive">失败</Badge>,
      },
      {
        accessorKey: "message",
        header: "摘要",
        enableColumnFilter: false,
        enableSorting: false,
        cell: ({ getValue }) => {
          const v = String(getValue() ?? "");
          return (
            <div className="max-w-[280px] truncate text-xs text-muted-foreground" title={v}>
              {v || "—"}
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "详情",
        enableSorting: false,
        enableColumnFilter: false,
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" onClick={() => setDetail(row.original)}>
            查看
          </Button>
        ),
      },
    ],
    []
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="操作日志"
        description="所有写 / 同步操作的审计记录，包含操作人、对象、动作与变更前后快照。"
        actions={<Badge variant="secondary">共 {total} 条</Badge>}
      />

      {query.isLoading ? (
        <Card>
          <CenteredSpinner />
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={query.data?.items ?? []}
          emptyText="暂无日志"
          maxHeight="calc(100vh - 340px)"
          toolbar={
            <div className="flex items-center gap-2">
              <div className="relative w-[240px]">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-xs"
                  placeholder="搜索摘要 / 对象 / IP / 域名 / 操作人…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select
                value={objectType || "all"}
                onValueChange={(v) => {
                  setObjectType(v === "all" ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[150px]">
                  <SelectValue placeholder="对象类型" />
                </SelectTrigger>
                <SelectContent>
                  {OBJECT_TYPES.map((t) => (
                    <SelectItem key={t || "all"} value={t || "all"}>
                      {t === "" ? "全部类型" : t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={action || "all"}
                onValueChange={(v) => {
                  setAction(v === "all" ? "" : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[150px]">
                  <SelectValue placeholder="动作" />
                </SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a || "all"} value={a || "all"}>
                      {a === "" ? "全部动作" : a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
      )}

      <div className="flex items-center justify-end gap-3 text-sm">
        <span className="text-muted-foreground">
          第 {page} / {totalPages} 页
        </span>
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          上一页
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          下一页
        </Button>
      </div>

      <Dialog open={detail != null} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail?.object_type} · {detail?.action} · {detail?.object_name}
            </DialogTitle>
          </DialogHeader>
          {detail?.message && <div className="text-sm text-muted-foreground">{detail.message}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">变更前</div>
              <JsonView data={safeParse(detail?.before ?? "")} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">变更后 / 报文</div>
              <JsonView data={safeParse(detail?.after ?? "")} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
