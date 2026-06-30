import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, GitCompareArrows, RefreshCw, Rocket } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { JsonView, PageHeader, Spinner } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { customRuleApi, instanceApi, policyApi, syncApi, urlApi } from "@/lib/api";
import type {
  BatchSyncResult,
  BatchTargetResult,
  ObjectType,
  SyncApplyResult,
  SyncDiffResult,
  TargetApplyResult,
} from "@/lib/types";

const OBJECT_TYPES: { value: ObjectType; label: string }[] = [
  { value: "customrule", label: "自定义应用" },
  { value: "url", label: "自定义 URL 库" },
  { value: "policy", label: "访问权限策略" },
];

// ── 字段元数据 ────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  rulename: "名称", depict: "描述", status: "状态", enable: "启用",
  direction: "方向", protocol: "协议", protocol_num: "协议号",
  port_mode: "端口模式", port_range: "端口范围",
  ip_mode: "IP 模式", ip_range: "IP 范围", domain: "域名",
  apptype: "应用类型", appname: "应用名",
  name: "名称", url: "URL 列表", keyword: "关键字",
};

// 内容为多行条目的字段，做行级别 diff
const LIST_FIELDS = new Set(["ip_range", "domain", "url"]);
// 展示权重低的字段（放末尾，且默认折叠到「相同」区）
const LOW_PRIORITY = new Set(["apptype", "appname", "protocol_num", "status"]);

const DIRECTION_MAP: Record<string, string> = { both: "双向", upload: "上行", download: "下行" };
const PROTOCOL_MAP: Record<string, string> = { "0": "全部", "6": "TCP", "17": "UDP", "1": "ICMP" };
const PORT_MODE_MAP: Record<string, string> = { all: "所有端口", specified: "指定端口" };
const IP_MODE_MAP: Record<string, string> = { all: "所有 IP", specified: "指定 IP" };

function fmtScalar(field: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "启用" : "禁用";
  const s = String(value).trim();
  if (field === "direction") return DIRECTION_MAP[s] ?? s;
  if (field === "protocol") return PROTOCOL_MAP[s] ?? s;
  if (field === "port_mode") return PORT_MODE_MAP[s] ?? s;
  if (field === "ip_mode") return IP_MODE_MAP[s] ?? s;
  return s;
}

function parseEntries(val: unknown): string[] {
  return String(val ?? "").split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
}

// ── 行级别列表 diff ───────────────────────────────────────────────────────────

function ListDiff({
  label,
  srcVal,
  tgtVal,
  targetMissing,
}: {
  label: string;
  srcVal: unknown;
  tgtVal: unknown;
  targetMissing: boolean;
}) {
  const [showSame, setShowSame] = useState(false);
  const srcSet = useMemo(() => new Set(parseEntries(srcVal)), [srcVal]);
  const tgtSet = useMemo(() => new Set(parseEntries(tgtVal)), [tgtVal]);

  const added = [...srcSet].filter((x) => !tgtSet.has(x));   // 源有、目标无 → 将新增
  const removed = [...tgtSet].filter((x) => !srcSet.has(x)); // 目标有、源无 → 将删除
  const same = [...srcSet].filter((x) => tgtSet.has(x));

  const hasChange = targetMissing ? srcSet.size > 0 : added.length > 0 || removed.length > 0;
  if (!hasChange && same.length === 0) return null;

  return (
    <div className="rounded border border-border/60 overflow-hidden">
      <div className={`px-3 py-1.5 text-xs font-medium flex items-center justify-between
        ${hasChange ? "bg-amber-500/8 border-b border-amber-500/20 text-amber-300" : "bg-muted/10 border-b border-border/40 text-muted-foreground/50"}`}
      >
        <span>{label}</span>
        <span className="text-muted-foreground/60 font-normal">
          {targetMissing
            ? `${srcSet.size} 条将新建`
            : `+${added.length} / -${removed.length} / =${same.length}`}
        </span>
      </div>
      <div className="px-3 py-2 space-y-0.5 font-mono text-xs max-h-64 overflow-y-auto">
        {targetMissing
          ? [...srcSet].map((e) => (
              <div key={e} className="text-emerald-400">
                <span className="select-none text-emerald-600 mr-1">+</span>{e}
              </div>
            ))
          : (
            <>
              {added.map((e) => (
                <div key={e} className="text-emerald-400">
                  <span className="select-none text-emerald-600 mr-1">+</span>{e}
                </div>
              ))}
              {removed.map((e) => (
                <div key={e} className="text-red-400">
                  <span className="select-none text-red-600 mr-1">-</span>{e}
                </div>
              ))}
              {same.length > 0 && (
                <button
                  className="mt-1 flex items-center gap-1 text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors"
                  onClick={() => setShowSame((v) => !v)}
                >
                  {showSame ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {same.length} 条相同
                </button>
              )}
              {showSame &&
                same.map((e) => (
                  <div key={e} className="text-muted-foreground/55 pl-3">
                    {e}
                  </div>
                ))}
            </>
          )}
      </div>
    </div>
  );
}

// ── 策略规则级对比 ────────────────────────────────────────────────────────────

type AppRef = { path: string; custom: boolean };
type UrlRef = { name: string; custom: boolean };
type PolicyRule = { name: string; apps: AppRef[]; urls: UrlRef[] };

function asRules(val: unknown): PolicyRule[] {
  if (!Array.isArray(val)) return [];
  return val.map((r: any) => ({
    name: String(r?.name ?? ""),
    // 兼容旧结构（字符串数组）与新结构（{path/name, custom}）
    apps: Array.isArray(r?.apps)
      ? r.apps.map((a: any) =>
          typeof a === "string" ? { path: a, custom: false } : { path: String(a?.path ?? ""), custom: !!a?.custom }
        )
      : [],
    urls: Array.isArray(r?.urls)
      ? r.urls.map((u: any) =>
          typeof u === "string" ? { name: u, custom: false } : { name: String(u?.name ?? ""), custom: !!u?.custom }
        )
      : [],
  }));
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
function ruleEq(s: PolicyRule, t: PolicyRule): boolean {
  return (
    sameKeys(s.apps.map((a) => a.path), t.apps.map((a) => a.path)) &&
    sameKeys(s.urls.map((u) => u.name), t.urls.map((u) => u.name))
  );
}

// 统计规则级实际差异数：新增 + 变更 + 目标多出的规则条数（按位置对位匹配）。
function countPolicyDiffs(srcRules: PolicyRule[], tgtRules: PolicyRule[], targetMissing: boolean): number {
  const max = Math.max(srcRules.length, tgtRules.length);
  let n = 0;
  for (let i = 0; i < max; i++) {
    const s = srcRules[i];
    const tg = tgtRules[i];
    if (!s && tg) n++; // 目标多出
    else if (s && (targetMissing || !tg)) n++; // 新增
    else if (s && tg && !ruleEq(s, tg)) n++; // 变更
  }
  return n;
}

type RefState = "added" | "removed" | "same";

// 把某一类引用的源/目标列表合并为带状态的条目：源有目标无=added、目标有源无=removed、共有=same
function diffCategory(src: string[], tgt: string[]): { value: string; state: RefState }[] {
  const srcSet = new Set(src);
  const tgtSet = new Set(tgt);
  const items: { value: string; state: RefState }[] = [];
  src.forEach((v) => items.push({ value: v, state: tgtSet.has(v) ? "same" : "added" }));
  tgt.forEach((v) => {
    if (!srcSet.has(v)) items.push({ value: v, state: "removed" });
  });
  return items;
}

const REF_STATE_CLS: Record<RefState, string> = {
  added: "text-emerald-400",
  removed: "text-red-400 line-through decoration-red-400/50",
  same: "text-muted-foreground/60",
};

// 一类引用（如「自定义应用」）：列出条目，按状态着色
function CategoryRow({ label, items }: { label: string; items: { value: string; state: RefState }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 text-xs">
      <span className="text-muted-foreground/50 whitespace-nowrap">
        {label}
        <span className="text-muted-foreground/30">（{items.length}）</span>
      </span>
      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
        {items.map((it, i) => (
          <span key={i} className={`break-all ${REF_STATE_CLS[it.state]}`}>{it.value}</span>
        ))}
      </span>
    </div>
  );
}

function PolicyDiff({ srcRules, tgtRules, targetMissing }: { srcRules: PolicyRule[]; tgtRules: PolicyRule[]; targetMissing: boolean }) {
  // 按规则顺序（位置）对位匹配：源第 N 条 ↔ 目标第 N 条（跨实例 rule_id 各设备独立分配，
  // 只能按顺序对应才能比出规则内部应用/URL 的细粒度增减）。无论是否一致都展开规则内容，
  // 并把引用分「自定义应用 / 内置应用 / 自定义URL库 / 内置URL库」展示。
  const max = Math.max(srcRules.length, tgtRules.length);
  const rows = Array.from({ length: max }, (_, i) => ({ s: srcRules[i], tg: tgtRules[i], pos: i + 1 }));

  return (
    <div className="space-y-1.5">
      {rows.map(({ s, tg, pos }) => {
        const isExtra = !s && !!tg; // 目标多出（将删除）
        const isNew = !!s && (targetMissing || !tg);
        const effTg = targetMissing ? undefined : tg; // 目标整体不存在时不参与比对（全部按新增）
        const changed = !!s && !!effTg && !ruleEq(s, effTg);
        const highlight = isNew || isExtra || changed;

        const srcApps = s?.apps ?? [];
        const tgtApps = effTg?.apps ?? [];
        const srcUrls = s?.urls ?? [];
        const tgtUrls = effTg?.urls ?? [];
        const pick = <T,>(arr: T[], f: (x: T) => boolean) => arr.filter(f);
        const customApps = diffCategory(
          pick(srcApps, (a) => a.custom).map((a) => a.path),
          pick(tgtApps, (a) => a.custom).map((a) => a.path)
        );
        const builtinApps = diffCategory(
          pick(srcApps, (a) => !a.custom).map((a) => a.path),
          pick(tgtApps, (a) => !a.custom).map((a) => a.path)
        );
        const customUrls = diffCategory(
          pick(srcUrls, (u) => u.custom).map((u) => u.name),
          pick(tgtUrls, (u) => u.custom).map((u) => u.name)
        );
        const builtinUrls = diffCategory(
          pick(srcUrls, (u) => !u.custom).map((u) => u.name),
          pick(tgtUrls, (u) => !u.custom).map((u) => u.name)
        );
        const empty =
          customApps.length + builtinApps.length + customUrls.length + builtinUrls.length === 0;

        const border = isExtra
          ? "border-red-500/20 bg-red-500/[0.06]"
          : highlight
          ? "border-amber-500/20 bg-amber-500/[0.06]"
          : "border-border/40 bg-muted/10";
        const ridTitle = s && tg ? `源规则 ID：${s.name}\n目标规则 ID：${tg.name}` : `规则 ID：${(s ?? tg)!.name}`;

        return (
          <div key={pos} className={`rounded px-3 py-1.5 border text-xs space-y-1 ${border}`}>
            <div className="flex items-center gap-2">
              <span
                className={
                  isExtra
                    ? "text-red-400 line-through decoration-red-400/50"
                    : highlight
                    ? "font-medium text-amber-300/80"
                    : "text-muted-foreground/70"
                }
                title={ridTitle}
              >
                规则 {pos}
              </span>
              {isExtra ? (
                <Badge variant="destructive" className="h-4 px-1 text-[10px]">目标多出</Badge>
              ) : isNew ? (
                <Badge variant="warning" className="h-4 px-1 text-[10px]">新增</Badge>
              ) : changed ? (
                <Badge variant="warning" className="h-4 px-1 text-[10px]">变更</Badge>
              ) : (
                <span className="text-[10px] text-muted-foreground/40">一致</span>
              )}
            </div>
            {empty ? (
              <p className="text-muted-foreground/40">（无应用 / URL 引用）</p>
            ) : (
              <div className="space-y-0.5">
                <CategoryRow label="自定义应用" items={customApps} />
                <CategoryRow label="内置应用" items={builtinApps} />
                <CategoryRow label="自定义URL库" items={customUrls} />
                <CategoryRow label="内置URL库" items={builtinUrls} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 单目标对照卡片 ────────────────────────────────────────────────────────────

function TargetCard({
  t,
  src,
  objectType,
  sourceName,
}: {
  t: SyncDiffResult["targets"][number];
  src: Record<string, unknown>;
  objectType: ObjectType;
  sourceName: string;
}) {
  const [showSameFields, setShowSameFields] = useState(false);

  const diffedFields = useMemo(() => new Set(t.diffs.map((d) => d.field)), [t.diffs]);
  const targetMissing = !t.exists && !t.error;

  // 整理所有需展示的字段，按「变化 > 相同」分组
  const { changedFields, sameFields } = useMemo(() => {
    const all = Object.keys(src).filter((k) => k in FIELD_LABELS || LIST_FIELDS.has(k));
    const changed: string[] = [];
    const same: string[] = [];
    for (const k of all) {
      if (LOW_PRIORITY.has(k)) { same.push(k); continue; }
      if (targetMissing || diffedFields.has(k)) changed.push(k);
      else same.push(k);
    }
    return { changedFields: changed, sameFields: same };
  }, [src, diffedFields, targetMissing]);

  // 策略按规则级实际差异计数；其他对象按字段级 diff 计数。
  const diffCount =
    objectType === "policy"
      ? countPolicyDiffs(
          asRules(src.rules),
          asRules(t.diffs.find((d) => d.field === "rules")?.target),
          targetMissing
        )
      : t.diffs.length;

  // 策略：以规则级实际差异数为准（后端因 rule_id 跨实例不同会误标 changed，但内容可能一致）
  const reallyChanged = objectType === "policy" ? diffCount > 0 : t.changed;
  const badge = t.error ? (
    <Badge variant="destructive">读取错误</Badge>
  ) : targetMissing ? (
    <Badge variant="warning">目标不存在（将新增）</Badge>
  ) : reallyChanged ? (
    <Badge variant="warning">差异 {diffCount} 处</Badge>
  ) : (
    <Badge variant="success">已一致</Badge>
  );

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">
          <span className="text-muted-foreground/70">{sourceName}</span>
          <span className="mx-1.5 text-muted-foreground/50">→</span>
          {t.instance_name}
        </span>
        {badge}
      </div>

      {t.error && <p className="text-xs text-destructive">{t.error}</p>}

      {/* 策略：规则级对比 */}
      {!t.error && objectType === "policy" && (
        <PolicyDiff
          srcRules={asRules(src.rules)}
          tgtRules={asRules(t.diffs.find((d) => d.field === "rules")?.target)}
          targetMissing={targetMissing}
        />
      )}

      {/* 变化字段 */}
      {!t.error && objectType !== "policy" && changedFields.length > 0 && (
        <div className="space-y-1.5">
          {changedFields.map((field) => {
            const srcVal = src[field];
            const diff = t.diffs.find((d) => d.field === field);
            const tgtVal = diff?.target;

            if (LIST_FIELDS.has(field)) {
              return (
                <ListDiff
                  key={field}
                  label={FIELD_LABELS[field] ?? field}
                  srcVal={srcVal}
                  tgtVal={tgtVal}
                  targetMissing={targetMissing}
                />
              );
            }

            const srcFmt = fmtScalar(field, srcVal);
            const tgtFmt = targetMissing ? undefined : fmtScalar(field, tgtVal);

            return (
              <div
                key={field}
                className="grid grid-cols-[90px_1fr_1fr] gap-x-3 items-baseline rounded px-3 py-1.5
                  bg-amber-500/8 border border-amber-500/20 text-xs"
              >
                <span className="text-amber-300/70 shrink-0">{FIELD_LABELS[field] ?? field}</span>
                <span className="text-emerald-400 break-all">{srcFmt || "—"}</span>
                {targetMissing ? (
                  <span className="text-muted-foreground/60 italic">（新建）</span>
                ) : (
                  <span className="text-red-400 break-all">{tgtFmt || "—"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 相同字段 ── 可折叠 */}
      {!t.error && objectType !== "policy" && !targetMissing && sameFields.length > 0 && (
        <div>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors"
            onClick={() => setShowSameFields((v) => !v)}
          >
            {showSameFields ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {sameFields.length} 个字段相同
          </button>
          {showSameFields && (
            <div className="mt-1.5 grid grid-cols-[90px_1fr] gap-x-4 gap-y-1 pl-2 text-xs text-muted-foreground/55">
              {sameFields.map((field) => {
                const v = src[field];
                if (LIST_FIELDS.has(field)) {
                  const entries = parseEntries(v);
                  return (
                    <div key={field} className="contents">
                      <span className="whitespace-nowrap">
                        {FIELD_LABELS[field] ?? field}
                        <span className="text-muted-foreground/40">（{entries.length}）</span>
                      </span>
                      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {entries.length === 0
                          ? "—"
                          : entries.map((e, i) => (
                              <span key={i} className="break-all">{e}</span>
                            ))}
                      </span>
                    </div>
                  );
                }
                return (
                  <div key={field} className="contents">
                    <span className="whitespace-nowrap">{FIELD_LABELS[field] ?? field}</span>
                    <span className="break-all">{fmtScalar(field, v) || "—"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 源快照摘要 ────────────────────────────────────────────────────────────────

function SourceSummary({ data, objectType }: { data: Record<string, unknown>; objectType: ObjectType }) {
  const chips: { label: string; value: string }[] = [];
  if (objectType === "customrule") {
    if (data.direction) chips.push({ label: "方向", value: fmtScalar("direction", data.direction) });
    if (data.protocol) chips.push({ label: "协议", value: fmtScalar("protocol", data.protocol) });
    if (data.port_mode) chips.push({ label: "端口", value: fmtScalar("port_mode", data.port_mode) });
    if (data.ip_mode)   chips.push({ label: "IP",   value: fmtScalar("ip_mode", data.ip_mode) });
    const ips = parseEntries(data.ip_range);
    if (ips.length) chips.push({ label: "IP 条数", value: String(ips.length) });
    const doms = parseEntries(data.domain);
    if (doms.length) chips.push({ label: "域名条数", value: String(doms.length) });
  } else if (objectType === "url") {
    const entries = parseEntries(data.url);
    if (entries.length) chips.push({ label: "URL 条数", value: String(entries.length) });
    if (data.keyword) chips.push({ label: "关键字", value: fmtScalar("keyword", data.keyword) });
  } else if (objectType === "policy") {
    const rules = Array.isArray(data.rules) ? data.rules : [];
    chips.push({ label: "规则数", value: String(rules.length) });
    const refCount = (rules as any[]).reduce(
      (n, r) => n + (Array.isArray(r?.apps) ? r.apps.length : 0) + (Array.isArray(r?.urls) ? r.urls.length : 0),
      0
    );
    if (refCount) chips.push({ label: "引用应用/URL", value: String(refCount) });
  }

  const name = String(data.rulename ?? data.name ?? data.policy_name ?? "");
  const depict = String(data.depict ?? "").trim();

  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">源</span>
        <span className="font-semibold">{name}</span>
        {depict && <span className="text-xs text-muted-foreground truncate max-w-xs">{depict}</span>}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {chips.map((c) => (
            <span key={c.label} className="text-xs text-muted-foreground">
              {c.label}：<span className="text-foreground/70">{c.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 同步结果卡片（含重建报文 + 缺失引用告警） ───────────────────────────────────

function ApplyResultCard({ r }: { r: TargetApplyResult }) {
  const [showPayload, setShowPayload] = useState(false);
  const hasWarnings = r.warnings.length > 0;

  return (
    <div className="rounded-lg border p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium">{r.instance_name}</span>
        <Badge variant={r.dry_run ? "warning" : r.success ? "success" : "destructive"}>
          {r.dry_run ? "dry-run" : r.success ? "成功" : "失败"}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground">{r.message}</div>

      {r.details.length > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs space-y-0.5">
          <div className="text-muted-foreground/70 mb-1">逐步结果：</div>
          {r.details.map((d, i) => {
            const failed = d.includes("失败");
            return (
              <div key={i} className={`flex gap-1.5 ${failed ? "text-red-400" : "text-muted-foreground/80"}`}>
                <span className="select-none">{failed ? "✗" : "•"}</span>
                <span className="break-all">{d}</span>
              </div>
            );
          })}
        </div>
      )}

      {hasWarnings && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs space-y-1">
          <div className="flex items-center gap-1.5 text-amber-300/90">
            <AlertTriangle className="h-3.5 w-3.5" />
            {r.warnings.length} 个内置引用在目标缺失（多因目标应用库版本较旧），无法自动创建，同步时已跳过这些引用：
          </div>
          <div className="flex flex-wrap gap-1 pl-5">
            {r.warnings.map((w) => (
              <Badge key={w} variant="outline" className="text-amber-300/80 border-amber-500/30">
                {w}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {r.payload && (
        <div>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground transition-colors"
            onClick={() => setShowPayload((v) => !v)}
          >
            {showPayload ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {showPayload ? "收起重建报文" : "查看重建报文（含目标 crc）"}
          </button>
          {showPayload && (
            <div className="mt-1.5">
              <JsonView data={r.payload} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 批量同步：单目标结果卡片 ──────────────────────────────────────────────────

function BatchNameList({ label, names, cls }: { label: string; names: string[]; cls: string }) {
  const [open, setOpen] = useState(false);
  if (names.length === 0) return null;
  return (
    <div className="text-xs">
      <button
        className={`flex items-center gap-1 ${cls} hover:opacity-80 transition-opacity`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label} {names.length}
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1 pl-4">
          {names.map((n) => (
            <Badge key={n} variant="outline" className="text-[11px]">{n}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchResultCard({ t }: { t: BatchTargetResult }) {
  const total = t.created.length + t.updated.length + t.deleted.length + t.failed.length;
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{t.instance_name}</span>
        {t.error ? (
          <Badge variant="destructive">读取失败</Badge>
        ) : t.failed.length > 0 ? (
          <Badge variant="warning">{t.failed.length} 项失败</Badge>
        ) : total === 0 ? (
          <Badge variant="secondary">无变化</Badge>
        ) : (
          <Badge variant={t.dry_run ? "warning" : "success"}>{t.dry_run ? "dry-run" : "完成"}</Badge>
        )}
      </div>
      {t.error && <p className="text-xs text-destructive">{t.error}</p>}
      {!t.error && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>新增 <span className="text-emerald-400">{t.created.length}</span></span>
          <span title="目标已存在同名，写入源内容覆盖（未逐项比对内容差异）">
            覆盖 <span className="text-sky-400">{t.updated.length}</span>
          </span>
          <span>删除 <span className="text-red-400">{t.deleted.length}</span></span>
          <span>失败 <span className="text-amber-400">{t.failed.length}</span></span>
        </div>
      )}
      {!t.error && t.updated.length > 0 && (
        <p className="text-[11px] text-muted-foreground/60">
          「覆盖」= 目标已存在同名对象，将写入源内容覆盖（批量不逐项比对内容；要看内容差异请用「单个对象」模式）。
        </p>
      )}
      <div className="space-y-1">
        <BatchNameList label="新增" names={t.created} cls="text-emerald-400" />
        <BatchNameList label="覆盖" names={t.updated} cls="text-sky-400" />
        <BatchNameList label="删除" names={t.deleted} cls="text-red-400" />
        {t.failed.length > 0 && (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] p-2 space-y-0.5">
            {t.failed.map((f) => (
              <div key={f.name} className="text-xs">
                <span className="text-amber-300/90">{f.name}</span>
                <span className="text-muted-foreground"> — {f.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export function SyncPage() {
  const { data: instances = [] } = useQuery({ queryKey: ["instances"], queryFn: () => instanceApi.list() });
  const enabled = instances.filter((i) => i.enabled);

  const [objectType, setObjectType] = useState<ObjectType>("customrule");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [objectName, setObjectName] = useState<string>("");
  const [targets, setTargets] = useState<number[]>([]);
  const [diff, setDiff] = useState<SyncDiffResult | null>(null);
  const [applyResult, setApplyResult] = useState<SyncApplyResult | null>(null);
  // 记录生成当前预览时的配置，配置改变后据此标记预览「已过期」（而非直接清空）
  const [resultKey, setResultKey] = useState<string | null>(null);
  // 真实写入二次确认弹窗：null 关闭，否则携带「是否一键推送全部 + 是否批量」
  const [confirmApply, setConfirmApply] = useState<{ pushAll: boolean; batch: boolean } | null>(null);
  // 同步范围：单个对象 / 整类批量；镜像：删除目标多余对象
  const [scope, setScope] = useState<"single" | "batch">("single");
  const [mirror, setMirror] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchSyncResult | null>(null);

  const sourceName = instances.find((i) => i.id === sourceId)?.name ?? "源";
  const isPolicy = objectType === "policy";
  const isBatch = scope === "batch";

  // 当前配置指纹；与 resultKey 不一致即说明右侧预览已过期
  const currentKey = JSON.stringify({
    scope, objectType, sourceId, objectName, mirror, targets: [...targets].sort(),
  });
  const stale = resultKey != null && resultKey !== currentKey;

  const names = useQuery({
    queryKey: ["sync-names", objectType, sourceId],
    enabled: sourceId != null,
    queryFn: async () => {
      if (objectType === "customrule")
        return (await customRuleApi.list(sourceId!)).map((r) => String(r.rulename));
      if (objectType === "url")
        return (await urlApi.list(sourceId!)).flat.filter((n) => !n.inside).map((n) => n.name);
      return (await policyApi.list(sourceId!)).access_policies.map((p) => String(p.name));
    },
  });

  const targetCandidates = useMemo(
    () => enabled.filter((i) => i.id !== sourceId),
    [enabled, sourceId]
  );

  const diffMut = useMutation({
    mutationFn: () =>
      syncApi.diff({
        object_type: objectType,
        object_name: objectName,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
      }),
    onSuccess: (r) => { setDiff(r); setApplyResult(null); setResultKey(currentKey); },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "差异计算失败"),
  });

  const applyMut = useMutation({
    mutationFn: ({ pushAll, dryRun }: { pushAll: boolean; dryRun: boolean }) =>
      syncApi.apply({
        object_type: objectType,
        object_name: objectName,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
        push_all: pushAll,
        dry_run: dryRun,
      }),
    onSuccess: (r, vars) => {
      setApplyResult(r);
      setResultKey(currentKey);
      setConfirmApply(null);
      if (vars.dryRun) {
        toast.success("已生成同步预览（dry-run）");
      } else {
        const failed = r.results.filter((x) => !x.success).length;
        if (failed === 0) toast.success("同步完成");
        else toast.warning(`同步完成，${failed} 个目标失败`);
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "同步失败"),
  });

  const batchMut = useMutation({
    mutationFn: ({ pushAll, dryRun }: { pushAll: boolean; dryRun: boolean }) =>
      syncApi.batch({
        object_type: objectType,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
        push_all: pushAll,
        mirror,
        dry_run: dryRun,
      }),
    onSuccess: (r, vars) => {
      setBatchResult(r);
      setResultKey(currentKey);
      setConfirmApply(null);
      const failed = r.targets.reduce((n, t) => n + t.failed.length, 0);
      if (vars.dryRun) toast.success("已生成批量同步预览（dry-run）");
      else if (failed === 0) toast.success("批量同步完成");
      else toast.warning(`批量同步完成，${failed} 项失败`);
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "批量同步失败"),
  });

  function toggleTarget(id: number) {
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  const ready = isBatch ? sourceId != null : sourceId != null && objectName !== "";
  const applying = applyMut.isPending || batchMut.isPending;

  return (
    <div className="space-y-5">
      <PageHeader
        title="实例同步"
        description="把单个对象或整类对象从源实例同步到其他实例：单个对象可预览字段级差异；批量可一次同步整类（可选镜像删除目标多余对象）。先预览、确认后再写入。"
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr] lg:items-start">
        {/* 左：配置 */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader><CardTitle className="text-base">同步配置</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* 同步范围：单个对象 / 整类批量 */}
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1">
              {(["single", "batch"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    scope === s ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s === "single" ? "单个对象" : "全部对象（批量）"}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">对象类型</Label>
              <Select value={objectType} onValueChange={(v) => { setObjectType(v as ObjectType); setObjectName(""); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OBJECT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">源实例</Label>
              <Select value={sourceId != null ? String(sourceId) : undefined} onValueChange={(v) => { setSourceId(Number(v)); setObjectName(""); }}>
                <SelectTrigger><SelectValue placeholder="选择源实例" /></SelectTrigger>
                <SelectContent>
                  {enabled.map((i) => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {!isBatch && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  对象名称 {names.isFetching && <Spinner className="ml-1 inline" />}
                </Label>
                <Combobox
                  options={(names.data ?? []).map((n) => ({ value: n, label: n }))}
                  value={objectName}
                  onChange={setObjectName}
                  disabled={sourceId == null}
                  placeholder={sourceId == null ? "请先选择源实例" : "选择要同步的对象"}
                  searchPlaceholder="输入关键字搜索…"
                  emptyText="无匹配对象"
                />
              </div>
            )}

            {isBatch && (
              <div className="text-xs text-muted-foreground">
                将同步源实例的<span className="text-foreground/80">全部{OBJECT_TYPES.find((t) => t.value === objectType)?.label}</span>
                {sourceId != null && names.data && <span>（共 {names.data.length} 个）</span>}到所选目标。
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">目标实例</Label>
              <div className="flex flex-wrap gap-2">
                {targetCandidates.length === 0 && (
                  <span className="text-xs text-muted-foreground">无其他可用实例</span>
                )}
                {targetCandidates.map((i) => (
                  <Badge
                    key={i.id}
                    variant={targets.includes(i.id) ? "default" : "outline"}
                    className="cursor-pointer"
                    onClick={() => toggleTarget(i.id)}
                  >
                    {i.name}
                  </Badge>
                ))}
              </div>
            </div>

            {isBatch && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium text-amber-300/90">镜像模式</Label>
                  <p className="text-[11px] text-muted-foreground">删除目标上「源没有」的{OBJECT_TYPES.find((t) => t.value === objectType)?.label}</p>
                </div>
                <Switch checked={mirror} onCheckedChange={setMirror} />
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              {!isBatch && (
                <Button variant="outline" onClick={() => diffMut.mutate()} disabled={!ready || targets.length === 0 || diffMut.isPending}>
                  {diffMut.isPending ? <Spinner /> : <GitCompareArrows className="h-4 w-4" />}
                  预览差异
                </Button>
              )}
              {isBatch && (
                <Button variant="outline" onClick={() => batchMut.mutate({ pushAll: false, dryRun: true })} disabled={!ready || targets.length === 0 || applying}>
                  {batchMut.isPending ? <Spinner /> : <GitCompareArrows className="h-4 w-4" />}
                  预览批量
                </Button>
              )}
              <Button onClick={() => setConfirmApply({ pushAll: false, batch: isBatch })} disabled={!ready || targets.length === 0 || applying}>
                <ArrowRight className="h-4 w-4" />
                {isBatch ? "批量同步到所选" : "同步到所选目标"}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmApply({ pushAll: true, batch: isBatch })} disabled={!ready || applying}>
                <Rocket className="h-4 w-4" />
                一键推送到全部
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 右：差异 / 结果 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isBatch
                ? batchResult
                  ? batchResult.targets.some((t) => !t.dry_run)
                    ? "批量同步结果"
                    : "批量同步预览（dry-run）"
                  : "批量同步"
                : applyResult
                ? applyResult.results.some((r) => !r.dry_run)
                  ? "同步结果"
                  : "同步预览（dry-run）"
                : "差异预览"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 配置已变更：保留上次预览但标记过期，提示重新预览 */}
            {stale && (diff || applyResult || batchResult) && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs">
                <span className="text-amber-300/90">配置已变更，下方为上一次的预览结果（已过期）。</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0"
                  onClick={() => (isBatch ? batchMut.mutate({ pushAll: false, dryRun: true }) : diffMut.mutate())}
                  disabled={!ready || targets.length === 0 || diffMut.isPending || batchMut.isPending}
                >
                  {diffMut.isPending || batchMut.isPending ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
                  重新预览
                </Button>
              </div>
            )}

            <div className={stale ? "pointer-events-none opacity-40 transition-opacity" : "transition-opacity"}>
              <div className="space-y-3">
                {isBatch ? (
                  batchResult ? (
                    <>
                      <div className="text-xs text-muted-foreground">
                        源共 {batchResult.source_count} 个对象{batchResult.mirror && <span className="text-amber-300/90"> · 镜像模式（删除目标多余）</span>}
                      </div>
                      {batchResult.targets.map((t) => <BatchResultCard key={t.instance_id} t={t} />)}
                    </>
                  ) : (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      配置左侧后点击「预览批量」
                    </div>
                  )
                ) : applyResult ? (
                  applyResult.results.map((r) => <ApplyResultCard key={r.instance_id} r={r} />)
                ) : diff ? (
                  <>
                    <SourceSummary data={diff.source_snapshot as Record<string, unknown>} objectType={objectType} />
                    {diff.targets.map((t) => (
                      <TargetCard
                        key={t.instance_id}
                        t={t}
                        src={diff.source_snapshot as Record<string, unknown>}
                        objectType={objectType}
                        sourceName={sourceName}
                      />
                    ))}
                  </>
                ) : (
                  <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    配置左侧后点击「预览差异」
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 真实写入二次确认 */}
      <Dialog open={confirmApply != null} onOpenChange={(v) => !v && setConfirmApply(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmApply?.batch ? "确认批量同步" : "确认同步"}</DialogTitle>
            <DialogDescription>
              「确认写入」会真实修改下列目标实例的配置，操作不可自动撤销；如仅想查看将提交的内容，请选「仅预览」。
            </DialogDescription>
          </DialogHeader>
          {confirmApply &&
            (() => {
              const effective = confirmApply.pushAll
                ? enabled.filter((i) => i.id !== sourceId)
                : enabled.filter((i) => targets.includes(i.id));
              const typeLabel = OBJECT_TYPES.find((t) => t.value === objectType)?.label;
              return (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <span className="text-muted-foreground">对象类型</span>
                    <span>{typeLabel}</span>
                    <span className="text-muted-foreground">{confirmApply.batch ? "范围" : "对象"}</span>
                    <span className="font-medium">
                      {confirmApply.batch
                        ? `全部${typeLabel}${names.data ? `（${names.data.length} 个）` : ""}`
                        : objectName}
                    </span>
                    <span className="text-muted-foreground">源实例</span>
                    <span>{sourceName}</span>
                    <span className="text-muted-foreground">目标实例</span>
                    <span className="flex flex-wrap gap-1">
                      {effective.length === 0 ? (
                        <span className="text-muted-foreground">无可用目标</span>
                      ) : (
                        effective.map((i) => (
                          <Badge key={i.id} variant="secondary">
                            {i.name}
                          </Badge>
                        ))
                      )}
                    </span>
                  </div>
                  {confirmApply.batch && mirror && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-xs text-red-300/90">
                      已开启<span className="font-medium">镜像模式</span>：目标上「源没有」的{typeLabel}会被<span className="font-medium">删除</span>。请务必先「仅预览」核对删除清单。
                    </div>
                  )}
                  {isPolicy && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300/90">
                      访问权限策略会按目标设备的 crc 重建报文写入：目标缺少的「自定义」应用 / URL 库会自动先建到目标；
                      「内置」对象在目标缺失则无法创建，会跳过这些引用、尽可能同步其余内容（结果会列出跳过项）。建议先「仅预览」核对。
                    </div>
                  )}
                </div>
              );
            })()}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() =>
                (confirmApply!.batch ? batchMut : applyMut).mutate({ pushAll: confirmApply!.pushAll, dryRun: true })
              }
              disabled={applying}
            >
              {applying && <Spinner />}
              仅预览（dry-run）
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                (confirmApply!.batch ? batchMut : applyMut).mutate({ pushAll: confirmApply!.pushAll, dryRun: false })
              }
              disabled={applying}
            >
              {applying ? <Spinner /> : <ArrowRight className="h-4 w-4" />}
              确认写入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
