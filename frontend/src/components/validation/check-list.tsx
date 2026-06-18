/** 可勾选列表（带搜索、全选/清除）。 */
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function CheckList({
  title,
  color,
  items,
  selected,
  onChange,
  maxVisible,
  selectAllVisibleOnly = false,
}: {
  title: string;
  color: string;
  items: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  maxVisible?: number;
  selectAllVisibleOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const { shown, matchCount } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const limit = maxVisible ?? Number.POSITIVE_INFINITY;
    const nextShown: string[] = [];
    let nextMatchCount = 0;
    for (const item of items) {
      if (q && !item.toLowerCase().includes(q)) continue;
      nextMatchCount += 1;
      if (nextShown.length < limit) nextShown.push(item);
    }
    return { shown: nextShown, matchCount: nextMatchCount };
  }, [items, maxVisible, search]);
  const toggle = (name: string) => {
    const next = new Set(selected);
    next.has(name) ? next.delete(name) : next.add(name);
    onChange(next);
  };
  const selectAll = () => {
    const q = search.trim().toLowerCase();
    const matchedItems = q ? items.filter((item) => item.toLowerCase().includes(q)) : items;
    onChange(selectAllVisibleOnly ? new Set([...selected, ...matchedItems]) : new Set(matchedItems));
  };
  const searchActive = search.trim().length > 0;
  return (
    <Card>
      <CardContent className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
            {title}
            <span className="text-xs text-muted-foreground">
              {selected.size}/{items.length}
            </span>
          </div>
          <div className="flex gap-2 text-xs">
            <button className="hover:text-primary" onClick={selectAll}>
              {selectAllVisibleOnly || searchActive ? "全选当前" : "全选"}
            </button>
            <button className="hover:text-foreground" onClick={() => onChange(new Set())}>
              清除
            </button>
          </div>
        </div>
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索…"
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="max-h-56 space-y-0.5 overflow-auto">
          {shown.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配</div>
          ) : (
            <>
              {shown.map((name) => (
                <button
                  key={name}
                  onClick={() => toggle(name)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                      selected.has(name) ? "border-primary bg-primary text-primary-foreground" : "border-input"
                    )}
                  >
                    {selected.has(name) && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="truncate" title={name}>
                    {name}
                  </span>
                </button>
              ))}
              {matchCount > shown.length && (
                <div className="px-1.5 py-1 text-xs text-muted-foreground">
                  已显示 {shown.length}/{matchCount} 项
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
