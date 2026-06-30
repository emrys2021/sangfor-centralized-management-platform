import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Spinner } from "@/components/common";
import { useConfirm } from "@/components/confirm-dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { customRuleApi } from "@/lib/api";
import { DIRECTIONS, PROTOCOL_OPTIONS } from "@/lib/customrule";
import type { CustomRuleForm, WriteResult } from "@/lib/types";
import { cn } from "@/lib/utils";

export const emptyCustomRuleForm: CustomRuleForm = {
  status: true,
  rulename: "",
  depict: "",
  apptype: "",
  appname: "",
  direction: "both",
  protocol: "0",
  protocol_num: "",
  port_mode: "all",
  port_range: "",
  ip_mode: "all",
  ip_range: "",
  domain: "",
};

/** 左标签 + 右内容的一行（对齐原生对话框）。``required`` 标红星，``error`` 显示字段级错误。 */
function Row({
  label,
  children,
  hint,
  required,
  error,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-3 py-1.5">
      <Label className="pt-2 text-right text-xs text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      <div className="space-y-1">
        {children}
        {error ? (
          <p className="text-[11px] text-destructive">{error}</p>
        ) : (
          hint && <p className="text-[11px] text-muted-foreground/70">{hint}</p>
        )}
      </div>
    </div>
  );
}

/** 分段单选控件。 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-input bg-background p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 分组标题。 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-white/10 p-3">
      <legend className="px-1 text-xs font-semibold text-primary">{title}</legend>
      {children}
    </fieldset>
  );
}

export function CustomRuleFormDialog({
  open,
  onOpenChange,
  mode,
  instanceId,
  initial,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "create" | "edit";
  instanceId: number;
  initial: CustomRuleForm;
  onDone: (result: WriteResult) => void;
}) {
  const confirm = useConfirm();
  const [form, setForm] = useState<CustomRuleForm>(initial);
  // 新增(add)/编辑(modify) 报文均已抓包确认，可实际写入；默认仍为安全预览。
  const [realSubmit, setRealSubmit] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setForm(initial);
      setRealSubmit(false);
      setShowErrors(false);
      setTouched(new Set());
    }
  }, [open, initial]);

  const set = <K extends keyof CustomRuleForm>(k: K, v: CustomRuleForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const dryRun = !realSubmit;

  // 字段级校验（与 AC 一致）：字段 → 短提示
  const FIELD_LABELS: Record<string, string> = {
    rulename: "应用基本信息 → 规则名称",
    apptype: "应用基本信息 → 应用类型",
    appname: "应用基本信息 → 应用名称",
    port_range: "数据包特征 → 指定端口或范围",
    ip_range: "数据包特征 → 指定IP或范围",
  };
  const fieldErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!form.rulename.trim()) e.rulename = "不允许为空";
    if (!form.apptype.trim()) e.apptype = "不允许为空";
    if (!form.appname.trim()) e.appname = "不允许为空";
    if (form.port_mode === "specified" && !form.port_range.trim()) e.port_range = "端口或范围为必输项";
    if (form.ip_mode === "specified" && !form.ip_range.trim()) e.ip_range = "IP或范围为必输项";
    return e;
  }, [form]);
  // 字段已触碰或提交过才显示该字段错误（避免一打开就满屏红）
  const errFor = (field: string) => ((showErrors || touched.has(field)) ? fieldErrors[field] : undefined);
  const invalid = (field: string) =>
    errFor(field) ? "border-destructive focus-visible:ring-destructive" : "";
  const blur = (field: string) => () => setTouched((s) => new Set(s).add(field));
  const errors = Object.entries(fieldErrors).map(([f, m]) => `${FIELD_LABELS[f]}：${m}`);

  // 协议下拉：若当前值不在预设里，补一个动态项以保证往返一致
  const protocolOptions = PROTOCOL_OPTIONS.some((o) => o.value === form.protocol)
    ? PROTOCOL_OPTIONS
    : [{ value: form.protocol, label: `协议(${form.protocol})` }, ...PROTOCOL_OPTIONS];

  const submit = useMutation({
    mutationFn: () => {
      const body = form as unknown as Record<string, unknown>;
      return mode === "create"
        ? customRuleApi.create(instanceId, body, dryRun)
        : customRuleApi.update(instanceId, form.rulename, body, dryRun);
    },
    onSuccess: (r) => {
      onOpenChange(false);
      onDone(r);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "提交失败"),
  });

  async function handleSubmit() {
    setShowErrors(true);
    if (Object.keys(fieldErrors).length) return;
    // AC 提示：所有端口 + 所有IP 会匹配全部流量，提交前二次确认
    if (form.port_mode === "all" && form.ip_mode === "all") {
      const ok = await confirm({
        title: "将匹配全部流量",
        description:
          "当前自定义应用选择了「所有端口、所有 IP」，所有数据都将匹配此应用而无法匹配其他内置应用；" +
          "若策略拒绝此自定义应用，可能造成网络无法访问。确认提交？",
        variant: "destructive",
        confirmText: "确认提交",
      });
      if (!ok) return;
    }
    submit.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新增自定义应用" : "编辑自定义应用"}</DialogTitle>
          <DialogDescription>
            提交后先生成报文预览（dry-run），核对无误即可启用真实写入。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-1">
          <div className="flex items-center gap-2">
            <Switch checked={form.status} onCheckedChange={(v) => set("status", v)} id="cr-status" />
            <Label htmlFor="cr-status" className="text-sm">
              启用应用
            </Label>
          </div>

          <Section title="应用基本信息">
            <Row label="规则名称" required error={mode === "edit" ? undefined : errFor("rulename")}>
              <Input
                value={form.rulename}
                disabled={mode === "edit"}
                onChange={(e) => set("rulename", e.target.value)}
                onBlur={blur("rulename")}
                className={mode === "edit" ? "" : invalid("rulename")}
                placeholder="必填，唯一"
              />
            </Row>
            <Row label="描述信息">
              <Input value={form.depict} onChange={(e) => set("depict", e.target.value)} />
            </Row>
            <Row label="应用类型" required error={errFor("apptype")}>
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                  自定义应用_
                </span>
                <Input
                  value={form.apptype}
                  onChange={(e) => set("apptype", e.target.value)}
                  onBlur={blur("apptype")}
                  className={invalid("apptype")}
                />
              </div>
            </Row>
            <Row label="应用名称" required error={errFor("appname")}>
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                  自定义应用_
                </span>
                <Input
                  value={form.appname}
                  onChange={(e) => set("appname", e.target.value)}
                  onBlur={blur("appname")}
                  className={invalid("appname")}
                />
              </div>
            </Row>
          </Section>

          <Section title="数据包特征">
            <Row label="数据包方向" hint="只有符合该方向的数据包才会进行特征识别。">
              <Segmented value={form.direction} onChange={(v) => set("direction", v)} options={DIRECTIONS} />
            </Row>
            <Row label="三层协议" hint="协议映射（TCP=1/UDP=2/ICMP=3）为推测，如与设备不符可在原始数据核对。">
              <Select value={form.protocol} onValueChange={(v) => set("protocol", v)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {protocolOptions.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="协议号" hint="仅特定协议需要填写。">
              <Input
                value={form.protocol_num}
                onChange={(e) => set("protocol_num", e.target.value)}
                className="w-44"
              />
            </Row>
            <Row
              label="目标端口"
              required={form.port_mode === "specified"}
              error={errFor("port_range")}
            >
              <Segmented
                value={form.port_mode}
                onChange={(v) => set("port_mode", v)}
                options={[
                  { value: "all", label: "所有端口" },
                  { value: "specified", label: "指定端口或范围" },
                ]}
              />
              {form.port_mode === "specified" && (
                <Input
                  className={cn("mt-2", invalid("port_range"))}
                  value={form.port_range}
                  onChange={(e) => set("port_range", e.target.value)}
                  onBlur={blur("port_range")}
                  placeholder="如 80,443,1000-2000"
                />
              )}
            </Row>
            <Row label="IP地址" required={form.ip_mode === "specified"} error={errFor("ip_range")}>
              <Segmented
                value={form.ip_mode}
                onChange={(v) => set("ip_mode", v)}
                options={[
                  { value: "all", label: "所有IP" },
                  { value: "specified", label: "指定IP或范围" },
                ]}
              />
              {form.ip_mode === "specified" && (
                <Textarea
                  className={cn("mt-2 font-mono text-xs", invalid("ip_range"))}
                  value={form.ip_range}
                  onChange={(e) => set("ip_range", e.target.value)}
                  onBlur={blur("ip_range")}
                  placeholder={"192.168.0.1\n2001::1\n192.168.0.1-192.168.0.100"}
                />
              )}
            </Row>
            <Row label="匹配目标域名">
              <Textarea
                className="font-mono text-xs"
                value={form.domain}
                onChange={(e) => set("domain", e.target.value)}
                placeholder="可在此输入、编辑、删除，每行一个"
              />
            </Row>
          </Section>
        </div>

        {showErrors && errors.length > 0 && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-3.5 w-3.5" /> 表单存在错误
            </div>
            <ul className="ml-5 list-disc space-y-0.5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <div className="flex items-center gap-2">
            <Switch checked={realSubmit} onCheckedChange={setRealSubmit} id="cr-real" />
            <Label htmlFor="cr-real" className="text-xs text-muted-foreground">
              实际写入设备{!realSubmit && "（关闭时仅预览报文）"}
            </Label>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submit.isPending}
              variant={dryRun ? "default" : "destructive"}
            >
              {submit.isPending && <Spinner />} {dryRun ? "提交（预览）" : "提交并写入"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
