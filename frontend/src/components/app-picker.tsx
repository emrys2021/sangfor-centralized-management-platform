import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search, Square, SquareCheck } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { CenteredSpinner, EmptyState } from "@/components/common";
import { RefChip } from "@/components/ref-chip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { policyApi } from "@/lib/api";
import { nodeToRef, refKey } from "@/lib/policy-refs";
import { cn } from "@/lib/utils";
import type { AppTreeNode, PolicyAppRef } from "@/lib/types";

/** 节点稳定键（展开态用）。 */
function nodeKey(n: AppTreeNode): string {
  return `${n.crc}|${n.value || n.name}`;
}

/** 按搜索词 + 标签裁剪树：命中或有命中后代的节点保留。 */
function pruneTree(
  nodes: AppTreeNode[],
  search: string,
  tag: string
): { kept: AppTreeNode[]; matchedKeys: Set<string> } {
  const matchedKeys = new Set<string>();
  const kw = search.trim().toLowerCase();

  function selfMatch(n: AppTreeNode): boolean {
    const tagOk = tag === "all" || (n.tags ?? []).includes(tag);
    const searchOk =
      !kw ||
      n.name.toLowerCase().includes(kw) ||
      (n.value ?? "").toLowerCase().includes(kw);
    return tagOk && searchOk;
  }

  function walk(list: AppTreeNode[]): AppTreeNode[] {
    const out: AppTreeNode[] = [];
    for (const n of list) {
      const keptChildren = n.children ? walk(n.children) : [];
      if (selfMatch(n) || keptChildren.length > 0) {
        if (keptChildren.length > 0) matchedKeys.add(nodeKey(n));
        out.push({ ...n, children: keptChildren });
      }
    }
    return out;
  }

  return { kept: walk(nodes), matchedKeys };
}

function TreeRow({
  node,
  depth,
  expanded,
  toggleExpand,
  isSelected,
  toggleSelect,
}: {
  node: AppTreeNode;
  depth: number;
  expanded: Set<string>;
  toggleExpand: (k: string) => void;
  isSelected: (n: AppTreeNode) => boolean;
  toggleSelect: (n: AppTreeNode) => void;
}) {
  const k = nodeKey(node);
  const hasChildren = !!node.children && node.children.length > 0;
  const open = expanded.has(k);
  const selected = isSelected(node);
  return (
    <div>
      <div
        className="flex items-center gap-1 rounded-md py-0.5 pr-1 hover:bg-white/5"
        style={{ paddingLeft: depth * 16 }}
      >
        <button
          type="button"
          onClick={() => hasChildren && toggleExpand(k)}
          className={cn("flex h-4 w-4 shrink-0 items-center justify-center", !hasChildren && "invisible")}
          aria-label={open ? "收起" : "展开"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => toggleSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {selected ? (
            <SquareCheck className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Square className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          )}
          <span className={cn("truncate text-sm", selected && "text-primary")}>{node.name}</span>
          {hasChildren && (
            <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-muted-foreground">
              {node.children!.length}
            </span>
          )}
        </button>
      </div>
      {open && hasChildren && (
        <div>
          {node.children!.map((c) => (
            <TreeRow
              key={nodeKey(c)}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggleExpand={toggleExpand}
              isSelected={isSelected}
              toggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 「选择适用应用」选择器：左侧标签筛选 + 中间应用树（含模糊搜索）+ 右侧已选列表。
 *
 * 仿 AC 原生编辑规则弹框设计。应用树来自 acnetpolicy ``listAppTree``，每个节点带
 * 设备分配的 ``crc``；选中节点即用其 ``value``/``type``/``crc`` 构造引用，无需臆造 crc。
 * 内置应用、自定义应用、URL 类目（访问网站）均在树中。
 */
export function AppPicker({
  open,
  onOpenChange,
  instanceId,
  title,
  initialRefs,
  initialAction = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  instanceId: number;
  title: string;
  initialRefs: PolicyAppRef[];
  /** 底部「动作」初始值（true=允许 / false=拒绝），与图3 一致 */
  initialAction?: boolean;
  /** 确定回调：返回已选引用与底部的动作/生效时间 */
  onConfirm: (refs: PolicyAppRef[], meta: { action: boolean; time: string }) => void;
}) {
  const tree = useQuery({
    queryKey: ["app-tree", instanceId],
    queryFn: () => policyApi.appTree(instanceId),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const [selected, setSelected] = useState<Map<string, PolicyAppRef>>(new Map());
  const [search, setSearch] = useState("");
  // 树较大时，把搜索词延迟传给昂贵的递归裁剪，避免每次按键阻塞输入框
  const deferredSearch = useDeferredValue(search);
  const [tag, setTag] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [action, setAction] = useState(false); // false=拒绝 / true=允许

  // 打开时用传入引用初始化已选；默认展开前两层。
  useEffect(() => {
    if (!open) return;
    setSelected(new Map(initialRefs.map((r) => [refKey(r), r])));
    setSearch("");
    setTag("all");
    setAction(initialAction);
  }, [open, initialRefs, initialAction]);

  const data = tree.data?.data ?? [];
  const tags = tree.data?.tags ?? [];

  // 默认展开：根 + appPathRoot 两层，便于看到顶层分类。
  useEffect(() => {
    if (!data.length) return;
    const init = new Set<string>();
    for (const root of data) {
      init.add(nodeKey(root));
      for (const c of root.children ?? []) if (c.appPathRoot) init.add(nodeKey(c));
    }
    setExpanded(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.data]);

  const { kept, matchedKeys } = useMemo(
    () => pruneTree(data, deferredSearch, tag),
    [data, deferredSearch, tag]
  );

  // 搜索/标签筛选时自动展开命中分支。
  const effectiveExpanded = useMemo(() => {
    if (!deferredSearch.trim() && tag === "all") return expanded;
    return new Set([...expanded, ...matchedKeys]);
  }, [expanded, matchedKeys, deferredSearch, tag]);

  const toggleExpand = (k: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const isSelected = (n: AppTreeNode) => selected.has(refKey(nodeToRef(n)));

  const toggleSelect = (n: AppTreeNode) =>
    setSelected((m) => {
      const ref = nodeToRef(n);
      const key = refKey(ref);
      const next = new Map(m);
      next.has(key) ? next.delete(key) : next.set(key, ref);
      return next;
    });

  const selectedList = [...selected.values()];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] max-h-[86vh] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>选择适用应用 · {title}</DialogTitle>
          <DialogDescription>
            勾选要引用的应用 / URL（内置、自定义、访问网站均在树中）；分类即「全部」，应用为单项。
          </DialogDescription>
        </DialogHeader>

        {tree.isLoading ? (
          <CenteredSpinner label="加载应用树…" />
        ) : tree.isError ? (
          <EmptyState title="应用树加载失败" hint={(tree.error as any)?.response?.data?.detail} />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[160px_1fr_260px] gap-3 overflow-hidden">
            {/* 左：标签筛选 */}
            <div className="min-h-0 overflow-auto rounded-lg border border-white/10 p-1.5">
              <button
                type="button"
                onClick={() => setTag("all")}
                className={cn(
                  "mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-xs",
                  tag === "all" ? "bg-primary/15 text-primary" : "hover:bg-white/5"
                )}
              >
                全部
              </button>
              {tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTag(t.id)}
                  title={t.description || t.name}
                  className={cn(
                    "mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-xs",
                    tag === t.id ? "bg-primary/15 text-primary" : "hover:bg-white/5"
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>

            {/* 中：应用树 + 搜索 */}
            <div className="flex min-h-0 flex-col rounded-lg border border-white/10">
              <div className="relative shrink-0 border-b border-white/10 p-2">
                <Search className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="模糊搜索应用…"
                  className="h-8 pl-7 text-sm"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1.5">
                {kept.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">无匹配应用</div>
                ) : (
                  kept.map((n) => (
                    <TreeRow
                      key={nodeKey(n)}
                      node={n}
                      depth={0}
                      expanded={effectiveExpanded}
                      toggleExpand={toggleExpand}
                      isSelected={isSelected}
                      toggleSelect={toggleSelect}
                    />
                  ))
                )}
              </div>
            </div>

            {/* 右：已选列表 */}
            <div className="flex min-h-0 flex-col rounded-lg border border-white/10">
              <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-2.5 py-1.5">
                <span className="text-xs font-medium text-muted-foreground">已选列表（{selectedList.length}）</span>
                <button
                  type="button"
                  onClick={() => setSelected(new Map())}
                  className="text-xs text-primary hover:underline disabled:opacity-40"
                  disabled={selectedList.length === 0}
                >
                  清空
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
                {selectedList.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground/60">未选择任何应用</div>
                ) : (
                  selectedList.map((r) => (
                    <div key={refKey(r)} className="block">
                      <RefChip
                        refItem={r}
                        onRemove={() =>
                          setSelected((m) => {
                            const next = new Map(m);
                            next.delete(refKey(r));
                            return next;
                          })
                        }
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              动作
              <select
                value={action ? "allow" : "deny"}
                onChange={(e) => setAction(e.target.value === "allow")}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="deny">拒绝</option>
                <option value="allow">允许</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              生效时间
              <select
                disabled
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground"
              >
                <option>全天</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                onConfirm(selectedList, { action, time: "全天" });
                onOpenChange(false);
              }}
            >
              确定（{selectedList.length}）
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
