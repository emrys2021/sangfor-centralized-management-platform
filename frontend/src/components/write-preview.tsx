import { AlertTriangle } from "lucide-react";

import { JsonView } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WriteResult } from "@/lib/types";

/**
 * 展示一次写操作的结果。dry-run 时展示将提交的报文预览；
 * 真实提交（写接口抓包确认后）展示设备返回。
 */
export function WritePreviewDialog({
  open,
  onOpenChange,
  title,
  result,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  result: WriteResult | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            {result?.dry_run ? (
              <Badge variant="warning">Dry-run 预览</Badge>
            ) : (
              <Badge variant="success">已提交</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {result?.dry_run
              ? "以下是将发送给 AC 的请求报文。写接口报文经抓包确认并登记后，此操作才会真正提交。"
              : "设备已返回结果。"}
          </DialogDescription>
        </DialogHeader>

        {result?.dry_run && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              当前为安全预览模式，不会改动设备配置。该对象类型的写报文确认后，可在后端
              <code className="mx-1 rounded bg-muted px-1">CONFIRMED_WRITES</code>登记以启用真实写入。
            </span>
          </div>
        )}

        <JsonView data={result?.payload ?? result?.result ?? {}} />

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
