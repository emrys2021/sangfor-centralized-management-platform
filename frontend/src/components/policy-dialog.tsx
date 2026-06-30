import { useMutation } from "@tanstack/react-query";
import { Info, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppPicker } from "@/components/app-picker";
import { Spinner } from "@/components/common";
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
import { Label } from "@/components/ui/label";
import { policyApi } from "@/lib/api";
import { refKey } from "@/lib/policy-refs";
import type { PolicyAppRef, PolicyDetail, WriteResult } from "@/lib/types";
import { cn } from "@/lib/utils";

type DialogRule = { id: string; action: boolean; refs: PolicyAppRef[] };

function genRuleId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/**
 * 访问权限策略「新建 / 编辑」对话框（仿原生，图2/图3）。
 *
 * 新建 (`opr=add`) 与编辑 (`opr=modify`) 共用同一界面：启用该策略 / 名称 / 描述 + 「应用控制」
 * 勾选后增删多条规则（每条经仿原生「选择适用应用」选择器设动作/生效时间/应用·URL）。编辑时
 * 名称只读（按名匹配往返）、其余字段（适用对象/高级配置等）原样保留。适用用户暂不在此设置。
 */
export function PolicyDialog({
  open,
  onOpenChange,
  mode,
  instanceId,
  detail,
  existingNames,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "create" | "edit";
  instanceId: number;
  detail?: PolicyDetail | null;
  existingNames: string[];
  onDone: (result: WriteResult) => void;
}) {
  const [enable, setEnable] = useState(true);
  const [name, setName] = useState("");
  const [depict, setDepict] = useState("");
  const [include, setInclude] = useState(true);
  const [rules, setRules] = useState<DialogRule[]>([]);
  const [realSubmit, setRealSubmit] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  // null=关闭；"new"=新增规则；number=编辑该索引规则
  const [pickerFor, setPickerFor] = useState<number | "new" | null>(null);
  const dryRun = !realSubmit;

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && detail) {
      setEnable(detail.enable);
      setName(detail.policy_name);
      setDepict(detail.depict);
      setInclude(detail.application_include);
      setRules(detail.rules.map((r) => ({ id: r.rule_id || genRuleId(), action: r.action_bool, refs: r.refs })));
    } else {
      setEnable(true);
      setName("");
      setDepict("");
      setInclude(true);
      setRules([]);
    }
    setRealSubmit(false);
    setShowErrors(false);
    setNameTouched(false);
    setPickerFor(null);
  }, [open, mode, detail]);

  const trimmed = name.trim();
  const nameError =
    mode === "edit"
      ? ""
      : !trimmed
        ? "策略名称不允许为空"
        : existingNames.includes(trimmed)
          ? "策略名称已存在"
          : "";
  // 字段触碰或提交后才显示名称错误
  const showNameError = !!nameError && (nameTouched || showErrors);

  const pickerInitialRefs = useMemo<PolicyAppRef[]>(
    () => (typeof pickerFor === "number" ? rules[pickerFor]?.refs ?? [] : []),
    [pickerFor, rules]
  );
  const pickerInitialAction = typeof pickerFor === "number" ? rules[pickerFor]?.action ?? false : false;

  const submit = useMutation({
    mutationFn: () => {
      const ruleRefs = (r: DialogRule) =>
        r.refs.map((x) => ({ path: x.path, type: x.type, crc: x.crc, extra: x.extra }));
      if (mode === "create") {
        return policyApi.create(
          instanceId,
          { name: trimmed, depict, enable, include, rules: rules.map((r) => ({ action: r.action, refs: ruleRefs(r) })) },
          dryRun
        );
      }
      return policyApi.updateApplication(
        instanceId,
        name,
        { rules: rules.map((r) => ({ name: r.id, action: r.action, refs: ruleRefs(r) })), include, enable, depict },
        dryRun
      );
    },
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

  function onPickerConfirm(refs: PolicyAppRef[], meta: { action: boolean; time: string }) {
    if (pickerFor === "new") {
      setRules((prev) => [...prev, { id: genRuleId(), action: meta.action, refs }]);
    } else if (typeof pickerFor === "number") {
      const idx = pickerFor;
      setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, action: meta.action, refs } : r)));
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>{mode === "create" ? "新建访问权限策略" : `访问权限策略 [${name}]`}</DialogTitle>
            <DialogDescription>
              在「应用控制」中增删规则；点某行「应用」可重新选择。提交先生成报文预览（dry-run）。
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs text-sky-600 dark:text-sky-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>当前仅配置「应用控制」；适用用户/对象与高级配置暂不在此编辑，提交时原样保留。</span>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enable}
                onChange={(e) => setEnable(e.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
              启用该策略
            </label>

            <div className="space-y-1.5">
              <Label htmlFor="pd-name">
                策略名称
                {mode !== "edit" && <span className="text-destructive"> *</span>}
              </Label>
              <Input
                id="pd-name"
                value={name}
                disabled={mode === "edit"}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                className={cn(showNameError && "border-destructive focus-visible:ring-destructive")}
                placeholder="例如：测试白名单"
              />
              {mode === "edit" && <p className="text-xs text-muted-foreground">编辑按名称匹配，暂不支持改名。</p>}
              {showNameError && <p className="text-xs text-destructive">{nameError}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pd-depict">描述信息</Label>
              <Input id="pd-depict" value={depict} onChange={(e) => setDepict(e.target.value)} />
            </div>

            {/* 应用控制 */}
            <div className="rounded-xl border border-white/10 bg-white/[0.03]">
              <label className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={include}
                  onChange={(e) => setInclude(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                应用控制
              </label>

              {include && (
                <div className="p-2.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mb-2 h-7 text-xs"
                    onClick={() => setPickerFor("new")}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> 添加
                  </Button>

                  {rules.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-white/10 py-6 text-center text-xs text-muted-foreground">
                      暂无规则，点「添加」选择适用应用
                    </div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr className="border-b border-white/10 text-left">
                          <th className="w-10 py-1.5 font-medium">序号</th>
                          <th className="py-1.5 font-medium">应用</th>
                          <th className="w-20 py-1.5 font-medium">生效时间</th>
                          <th className="w-16 py-1.5 font-medium">动作</th>
                          <th className="w-12 py-1.5 text-center font-medium">移除</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rules.map((rule, idx) => (
                          <tr key={rule.id} className="border-b border-white/5 align-top">
                            <td className="py-1.5 text-muted-foreground">{idx + 1}</td>
                            <td className="py-1.5">
                              <button
                                type="button"
                                title="点击重新选择应用 / URL"
                                onClick={() => setPickerFor(idx)}
                                className="flex flex-wrap gap-1 rounded text-left hover:opacity-80"
                              >
                                {rule.refs.length === 0 ? (
                                  <span className="text-primary hover:underline">（空，点击选择）</span>
                                ) : (
                                  rule.refs.map((r) => <RefChip key={refKey(r)} refItem={r} />)
                                )}
                              </button>
                            </td>
                            <td className="py-1.5 text-muted-foreground">全天</td>
                            <td className="py-1.5">
                              {rule.action ? (
                                <span className="text-emerald-400">允许</span>
                              ) : (
                                <span className="text-rose-400">拒绝</span>
                              )}
                            </td>
                            <td className="py-1.5 text-center">
                              <button
                                type="button"
                                title="移除"
                                className="text-destructive hover:opacity-70"
                                onClick={() => setRules((prev) => prev.filter((_, i) => i !== idx))}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="items-center gap-3 sm:justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={realSubmit}
                onChange={(e) => setRealSubmit(e.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
              实际写入设备{!realSubmit && "（关闭时仅预览报文）"}
            </label>
            <Button onClick={handleSubmit} disabled={submit.isPending} variant={dryRun ? "default" : "destructive"}>
              {submit.isPending && <Spinner />} {dryRun ? "提交（预览）" : "提交并写入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AppPicker
        open={pickerFor !== null}
        onOpenChange={(v) => !v && setPickerFor(null)}
        instanceId={instanceId}
        title={mode === "edit" ? name : "新建策略规则"}
        initialRefs={pickerInitialRefs}
        initialAction={pickerInitialAction}
        onConfirm={onPickerConfirm}
      />
    </>
  );
}
