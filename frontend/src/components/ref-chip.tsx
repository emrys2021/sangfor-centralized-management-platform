import { Plus, X } from "lucide-react";

import { kindMeta } from "@/lib/policy-refs";
import { cn } from "@/lib/utils";
import type { PolicyAppRef } from "@/lib/types";

/** 引用徽标：左侧类别标签 + 路径，可选移除 / 添加按钮。 */
export function RefChip({
  refItem,
  onRemove,
  onAdd,
}: {
  refItem: PolicyAppRef;
  onRemove?: () => void;
  onAdd?: () => void;
}) {
  const meta = kindMeta(refItem);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        meta.cls
      )}
    >
      <span className="rounded bg-black/20 px-1 py-px text-[9px] font-sans opacity-80">{meta.label}</span>
      <span className="max-w-[22rem] truncate" title={refItem.path}>
        {refItem.path}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded-full p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
          aria-label="移除引用"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="ml-0.5 rounded-full p-0.5 opacity-70 hover:bg-white/10 hover:opacity-100"
          aria-label="加入"
        >
          <Plus className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
