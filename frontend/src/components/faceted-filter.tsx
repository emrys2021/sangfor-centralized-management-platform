import type { Column } from "@tanstack/react-table";
import { Check, ListFilter, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * 列的「分面筛选」：点击后列出该列所有已有取值供勾选，支持输入文本匹配、
 * 「全选筛选结果」一次选中多个条目。多选为「命中其一即保留」。
 */
export function FacetedFilter<TData>({ column }: { column: Column<TData, unknown> }) {
  const [search, setSearch] = useState("");
  const facets = column.getFacetedUniqueValues();
  const selected = new Set((column.getFilterValue() as string[]) ?? []);

  const options = useMemo(() => {
    const keys = Array.from(facets.keys())
      .map((k) => (k == null ? "" : String(k)))
      .filter((k) => k !== "");
    return Array.from(new Set(keys)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [facets]);

  const shown = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()));

  function setSelected(next: Set<string>) {
    column.setFilterValue(next.size ? Array.from(next) : undefined);
  }

  function toggle(value: string) {
    const next = new Set(selected);
    next.has(value) ? next.delete(value) : next.add(value);
    setSelected(next);
  }

  function selectAllShown() {
    const next = new Set(selected);
    shown.forEach((o) => next.add(o));
    setSelected(next);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          title="筛选"
          className={cn(
            "inline-flex h-6 items-center gap-0.5 rounded px-1 transition-colors hover:bg-accent",
            selected.size > 0 ? "text-primary" : "text-muted-foreground/50 hover:text-foreground"
          )}
        >
          <ListFilter className="h-3.5 w-3.5 shrink-0" />
          {selected.size > 0 && (
            <span className="rounded bg-primary/15 px-1 text-[10px] font-medium leading-4">{selected.size}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="输入文本匹配…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-white/10 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <span>{shown.length} 项</span>
          <div className="flex gap-2">
            <button onClick={selectAllShown} className="hover:text-primary" disabled={shown.length === 0}>
              全选筛选结果
            </button>
            <button
              onClick={() => column.setFilterValue(undefined)}
              className="hover:text-foreground"
              disabled={selected.size === 0}
            >
              清除
            </button>
          </div>
        </div>

        <div className="max-h-64 overflow-auto py-1">
          {shown.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">无匹配项</div>
          ) : (
            shown.map((option) => {
              const checked = selected.has(option);
              return (
                <button
                  key={option}
                  onClick={() => toggle(option)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
                    )}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="flex-1 truncate" title={option}>
                    {option}
                  </span>
                  <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-muted-foreground">
                    {facets.get(option) ?? ""}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
