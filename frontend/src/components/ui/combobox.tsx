import { Check, ChevronsUpDown, Search } from "lucide-react";
import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * 搜索框键盘导航：↑/↓ 移动高亮项、Enter 选中（仅 1 个匹配时可直接 Enter）。
 * Esc 关闭由 Radix Popover 自带。query 变化时高亮复位，高亮项滚动保持可见。
 */
function useListKeyboardNav(count: number, pick: (index: number) => void, query: string) {
  const [active, setActive] = React.useState(-1);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setActive(-1), [query]);
  React.useEffect(() => {
    if (active >= 0)
      listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (count === 0 ? -1 : (a + 1) % count));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (count === 0 ? -1 : (a - 1 + count) % count));
    } else if (e.key === "Enter") {
      const target = active >= 0 && active < count ? active : count === 1 ? 0 : -1;
      if (target >= 0) {
        e.preventDefault();
        pick(target);
      }
    }
  }
  return { active, setActive, listRef, onKeyDown };
}

/**
 * 带搜索的下拉选择框（基于 Popover，无额外依赖）。
 * 条目较多时输入关键字即时过滤，支持键盘 ↑/↓ 高亮、Enter 选中、Esc 关闭。
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  emptyText = "无匹配项",
  disabled,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // 打开时清空上次搜索词并聚焦输入框
  React.useEffect(() => {
    if (open) {
      setQuery("");
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  function select(v: string) {
    onChange(v);
    setOpen(false);
  }

  const nav = useListKeyboardNav(filtered.length, (i) => select(filtered[i].value), query);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <div className="flex items-center border-b border-border/60 px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={nav.onKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={nav.listRef} className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((o, i) => (
              <button
                key={o.value}
                type="button"
                data-idx={i}
                onClick={() => select(o.value)}
                onMouseMove={() => nav.setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  o.value === value && "bg-accent/50",
                  nav.active === i && "bg-accent"
                )}
              >
                <Check className={cn("h-3.5 w-3.5 shrink-0", o.value === value ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{o.label}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface MultiComboboxProps {
  options: ComboboxOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * 带搜索的多选下拉框：点选不关闭面板，收起态显示「已选 N 个」（选 1 个时显示其名称）。
 * 勾选/取消逻辑（如某选项与其余互斥）由调用方在 onChange 里处理，本组件只管「切换是否在
 * value 数组里」。键盘 ↑/↓ 高亮、Enter 切换勾选（不关面板）、Esc 关闭。
 */
export function MultiCombobox({
  options,
  value,
  onChange,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  emptyText = "无匹配项",
  disabled,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selectedSet = React.useMemo(() => new Set(value), [value]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  function toggle(v: string) {
    onChange(selectedSet.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  const nav = useListKeyboardNav(filtered.length, (i) => toggle(filtered[i].value), query);

  const triggerLabel =
    value.length === 0
      ? placeholder
      : value.length === 1
      ? options.find((o) => o.value === value[0])?.label ?? value[0]
      : `已选 ${value.length} 个`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <div className="flex items-center border-b border-border/60 px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={nav.onKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="shrink-0 px-1.5 text-xs text-muted-foreground/70 hover:text-foreground"
            >
              清空
            </button>
          )}
        </div>
        <div ref={nav.listRef} className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((o, i) => {
              const checked = selectedSet.has(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  data-idx={i}
                  onClick={() => toggle(o.value)}
                  onMouseMove={() => nav.setActive(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    checked && "bg-accent/50",
                    nav.active === i && "bg-accent"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
                    )}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
