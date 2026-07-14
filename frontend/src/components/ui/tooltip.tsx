import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 轻量应用内 tooltip（无额外依赖）：hover / 键盘聚焦时显示深色气泡，替代浏览器原生 `title`
 * 的系统风格，与卡片 / 弹层统一。长文本自动换行（max-w-xs）。
 *
 * - `content` 为空时不渲染气泡（等价于无 tooltip）。
 * - `side` 控制气泡在触发元素的上 / 下方，默认上方。
 * - 触发元素默认 `inline-flex` 包裹，一般不影响布局；如需右对齐避免溢出可传 `align="end"`。
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
  align?: "center" | "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const alignCls =
    align === "center" ? "left-1/2 -translate-x-1/2" : align === "start" ? "left-0" : "right-0";
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && content && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 w-max max-w-xs whitespace-normal rounded-md border border-white/10 bg-card px-2 py-1 text-[11px] leading-snug text-card-foreground shadow-xl",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            alignCls,
            className
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
