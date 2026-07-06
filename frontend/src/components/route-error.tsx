import { AlertTriangle, RotateCcw } from "lucide-react";
import { useRouteError } from "react-router-dom";

import { Button } from "@/components/ui/button";

/**
 * 路由级错误页（react-router errorElement）：页面渲染/加载抛错时兜底显示，
 * 避免整个应用白屏。展示错误信息并提供刷新入口。
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error != null && "statusText" in error
        ? String((error as { statusText: unknown }).statusText)
        : String(error);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
        <AlertTriangle className="h-6 w-6 text-red-400" />
      </div>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">页面出错了</h1>
        <p className="max-w-md break-all text-sm text-muted-foreground">{message || "发生未知错误"}</p>
      </div>
      <Button variant="outline" onClick={() => window.location.reload()}>
        <RotateCcw className="h-4 w-4" /> 刷新页面
      </Button>
    </div>
  );
}
