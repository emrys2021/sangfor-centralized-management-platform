import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Spinner } from "@/components/common";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { urlApi } from "@/lib/api";
import type { UrlGroupForm as UrlForm, WriteResult } from "@/lib/types";
import { cn } from "@/lib/utils";

const EMPTY: UrlForm = { name: "", depict: "", url: "", keyword: "" };

/**
 * 新增 / 编辑 / 查看 自定义 URL 库（仿原生「编辑URL类型」对话框）。
 *
 * 字段对应设备 ``data``：name（URL 组名称）、depict（URL 组描述）、url（换行分隔的 URL）、
 * keyword（域名关键字）。编辑按库名匹配，故编辑时组名只读（不支持改名）。``readOnly``
 * 用于内置库：全部字段只读、不显示提交。提交先生成报文预览（dry-run），打开
 * 「实际写入设备」开关才真正提交。
 */
export function UrlGroupFormDialog({
  open,
  onOpenChange,
  instanceId,
  mode,
  readOnly = false,
  initial,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  instanceId: number;
  mode: "create" | "edit";
  readOnly?: boolean;
  initial?: UrlForm;
  onDone: (result: WriteResult) => void;
}) {
  const [form, setForm] = useState<UrlForm>(EMPTY);
  const [realSubmit, setRealSubmit] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const dryRun = !realSubmit;

  useEffect(() => {
    if (!open) return;
    setForm(initial ?? EMPTY);
    setRealSubmit(false);
    setShowErrors(false);
    setNameTouched(false);
  }, [open, initial]);

  const set = <K extends keyof UrlForm>(k: K, v: UrlForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const nameError = !form.name.trim();
  const nameDisabled = readOnly || mode === "edit";
  // 名称为编辑/只读时不校验；否则字段触碰或提交后才显示错误
  const showNameError = !nameDisabled && nameError && (nameTouched || showErrors);

  const submit = useMutation({
    mutationFn: () =>
      mode === "create"
        ? urlApi.create(instanceId, form, dryRun)
        : urlApi.update(instanceId, initial?.name ?? form.name, form, dryRun),
    onSuccess: (r) => {
      onOpenChange(false);
      onDone(r);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "提交失败"),
  });

  function handleSubmit() {
    setShowErrors(true);
    if (nameError) return;
    submit.mutate();
  }

  const title = readOnly
    ? "查看 URL 库（内置，不可编辑）"
    : mode === "create"
      ? "新增 URL 库"
      : "编辑 URL 类型";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? "内置 URL 库为系统预置，仅供查看。"
              : "提交后先生成报文预览（dry-run），核对无误即可启用真实写入。"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-1">
          <div className="space-y-1.5">
            <Label htmlFor="url-name">
              URL 组名称
              {!nameDisabled && <span className="text-destructive"> *</span>}
            </Label>
            <Input
              id="url-name"
              value={form.name}
              disabled={nameDisabled}
              onChange={(e) => set("name", e.target.value)}
              onBlur={() => setNameTouched(true)}
              className={cn(showNameError && "border-destructive focus-visible:ring-destructive")}
              placeholder="例如：阿里云无影云桌面"
            />
            {mode === "edit" && !readOnly && (
              <p className="text-xs text-muted-foreground">编辑按组名匹配，暂不支持改名。</p>
            )}
            {showNameError && <p className="text-xs text-destructive">URL 组名称不允许为空</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="url-depict">URL 组描述</Label>
            <Input id="url-depict" value={form.depict} disabled={readOnly} onChange={(e) => set("depict", e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="url-url">URL（每行一条）</Label>
            <Textarea
              id="url-url"
              value={form.url}
              disabled={readOnly}
              onChange={(e) => set("url", e.target.value)}
              className="min-h-[140px] font-mono text-xs"
              placeholder={"*.aliyuncs.com\nclient.aliyun.com"}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="url-keyword">域名关键字（每行一条，可选）</Label>
            <Textarea
              id="url-keyword"
              value={form.keyword}
              disabled={readOnly}
              onChange={(e) => set("keyword", e.target.value)}
              className="min-h-[60px] font-mono text-xs"
              placeholder="可以直接在此处输入、编辑、删除"
            />
          </div>
        </div>

        {readOnly ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter className="items-center gap-3 sm:justify-between">
            <div className="flex items-center gap-2">
              <Switch checked={realSubmit} onCheckedChange={setRealSubmit} id="url-real" />
              <Label htmlFor="url-real" className="text-sm">
                实际写入设备{!realSubmit && "（关闭时仅预览报文）"}
              </Label>
            </div>
            <Button
              onClick={handleSubmit}
              disabled={submit.isPending}
              variant={dryRun ? "default" : "destructive"}
            >
              {submit.isPending && <Spinner />} {dryRun ? "提交（预览）" : "提交并写入"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
