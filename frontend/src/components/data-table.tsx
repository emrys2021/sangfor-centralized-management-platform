import {
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { FacetedFilter } from "@/components/faceted-filter";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 多选筛选：筛选值为数组，行值命中其一即保留。 */
const multiSelectFilter: FilterFn<any> = (row, columnId, value) => {
  const selected = (value as string[]) ?? [];
  if (!selected.length) return true;
  return selected.includes(String(row.getValue(columnId)));
};

function SortIcon({ dir }: { dir: false | "asc" | "desc" }) {
  if (dir === "asc") return <ArrowUp className="h-3.5 w-3.5 text-primary" />;
  if (dir === "desc") return <ArrowDown className="h-3.5 w-3.5 text-primary" />;
  return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />;
}

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[];
  data: TData[];
  /** 全局搜索占位符；提供则显示全局搜索框 */
  globalFilterPlaceholder?: string;
  /** 行点击回调 */
  onRowClick?: (row: TData) => void;
  /** 右上角附加操作 */
  toolbar?: React.ReactNode;
  /** 表格可滚动区域的最大高度（含固定表头） */
  maxHeight?: string;
  emptyText?: string;
}

export function DataTable<TData>({
  columns,
  data,
  globalFilterPlaceholder,
  onRowClick,
  toolbar,
  maxHeight = "calc(100vh - 270px)",
  emptyText = "无数据",
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  // 大表格筛选延迟到非紧急更新，保持输入框跟手
  const deferredGlobalFilter = useDeferredValue(globalFilter);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter: deferredGlobalFilter },
    defaultColumn: { filterFn: multiSelectFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const rows = table.getRowModel().rows;

  return (
    <div className="space-y-3">
      {(globalFilterPlaceholder || toolbar) && (
        <div className="flex items-center justify-between gap-3">
          {globalFilterPlaceholder ? (
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-xs"
                placeholder={globalFilterPlaceholder}
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
              />
            </div>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{rows.length} 行</span>
            {toolbar}
          </div>
        </div>
      )}

      <div
        className="glass overflow-auto rounded-xl"
        style={{ maxHeight }}
      >
        <table className="w-full caption-bottom text-xs">
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-white/10">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      className="bg-card/95 px-2.5 py-1.5 align-middle backdrop-blur-xl"
                    >
                      <div className="flex items-center gap-1 font-medium text-muted-foreground">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            canSort && "cursor-pointer select-none hover:text-foreground"
                          )}
                          onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort && <SortIcon dir={header.column.getIsSorted()} />}
                        </span>
                        {header.column.getCanFilter() && <FacetedFilter column={header.column} />}
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-8 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    "border-b border-white/[0.04] transition-colors hover:bg-white/[0.03]",
                    onRowClick && "cursor-pointer"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-2.5 py-1 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
