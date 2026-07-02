import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, GitCompareArrows, RefreshCw, Rocket, Scale } from "lucide-react";
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
  BatchCompareResult,
  BatchSyncResult,
  BatchTargetResult,
  CompareItem,
  CompareStatus,
  CompareTargetResult,
  FieldDiff,
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

// 对象选择框里的特殊项：选它表示「整类全部对象」（对比/同步 的批量子选项）。
// 用不可能与真实对象名冲突的哨兵值。
const ALL_OBJECTS = "__ALL_OBJECTS__";

// sync-names 按 [对象类型, 实例id] 缓存；策略同步可能顺带在目标自动建/改自定义应用或 URL 库
// 引用（见 policy_sync 的自动建引用），故失效时三种类型都覆盖，不只当次同步的 objectType。
const ALL_OBJECT_TYPES: ObjectType[] = ["customrule", "url", "policy"];

/** 真实同步写入后失效目标实例的相关前端缓存。
 *
 * 全局 staleTime=30s/5min（见 main.tsx、app-picker.tsx 的应用树）后，切到目标实例页面短时间内
 * 会直接读旧缓存——同步刚写完立刻去目标实例核对结果、或打开策略编辑器选应用是常见操作，必须
 * 主动失效，否则会看到「同步成功但页面/应用树没变」的假象。TanStack Query 默认按前缀匹配，故
 * 这里只传各 query 的前几段 key 即可覆盖其带详情名的变体（如 ["policy", id] 一并失效
 * ["policy", id, name]）。
 */
function invalidateTargetInstanceQueries(qc: ReturnType<typeof useQueryClient>, instanceId: number) {
  qc.invalidateQueries({ queryKey: ["policies", instanceId] });
  qc.invalidateQueries({ queryKey: ["policy", instanceId] });
  qc.invalidateQueries({ queryKey: ["app-tree", instanceId] });
  qc.invalidateQueries({ queryKey: ["customrules", instanceId] });
  qc.invalidateQueries({ queryKey: ["customrule", instanceId] });
  qc.invalidateQueries({ queryKey: ["urls", instanceId] });
  qc.invalidateQueries({ queryKey: ["url-content", instanceId] });
  qc.invalidateQueries({ queryKey: ["cr-analysis", instanceId] });
  qc.invalidateQueries({ queryKey: ["policy-usage", instanceId] });
  qc.invalidateQueries({ queryKey: ["search", instanceId] });
  for (const ot of ALL_OBJECT_TYPES) qc.invalidateQueries({ queryKey: ["sync-names", ot, instanceId] });
}

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
// 高优先级「主体」字段：功能配置（方向/协议/端口/IP/域名，及 URL 库的 URL 列表），差异突出显示。
// 其余字段（描述/状态/应用类型/应用名/协议号/关键字…）的差异也显示，但弱化、不抢主体。
const HIGH_PRIORITY = new Set([
  "direction", "protocol", "port_mode", "port_range", "ip_mode", "ip_range", "domain", "url",
]);

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
type PolicyRule = { name: string; action: string; apps: AppRef[] };
type NetRule = { dip: string; service: string; action: unknown; time: string };

function asRules(val: unknown): PolicyRule[] {
  if (!Array.isArray(val)) return [];
  return val.map((r: any) => ({
    name: String(r?.name ?? ""),
    action: String(r?.action ?? ""),
    // 兼容旧结构（字符串数组）与新结构（{path/name, custom}）
    apps: Array.isArray(r?.apps)
      ? r.apps.map((a: any) =>
          typeof a === "string" ? { path: a, custom: false } : { path: String(a?.path ?? ""), custom: !!a?.custom }
        )
      : [],
  }));
}

function asNetRules(val: unknown): NetRule[] {
  if (!Array.isArray(val)) return [];
  return val.map((r: any) => ({
    dip: String(r?.dip ?? ""),
    service: String(r?.service ?? ""),
    action: r?.action,
    time: String(r?.time ?? ""),
  }));
}

// 动作：应用规则 allow/deny，端口规则 1/0 或布尔 → 放行 / 拒绝
function actionText(a: unknown): string {
  if (a === "allow" || a === true || a === 1) return "放行";
  if (a === "deny" || a === false || a === 0) return "拒绝";
  return String(a ?? "未知");
}
// 「访问网站/库名/能力」这类应用路径本质是 URL 库引用（可能是自定义库也可能是内置库，
// 库名本身无法可靠判断内置/自定义，故不再区分），展示时从「应用」里拆出来单独归入「URL库」，
// 显示完整路径；不用后端 urls 字段（裁剪成裸库名、且会和这里的完整路径重复显示同一条引用）。
function isUrlRef(path: string): boolean {
  return path.startsWith("访问网站/");
}
function netRuleText(r: NetRule): string {
  const t = r.time && r.time !== "全天" ? ` · ${r.time}` : "";
  return `${r.dip} · ${r.service} · ${actionText(r.action)}${t}`;
}

// 取某字段的目标值：diffs 里有该字段=不同、取 target；没有=两边相同、回退用源值。
function targetVal(diffs: FieldDiff[], field: string, fallback: unknown): unknown {
  const d = diffs.find((x) => x.field === field);
  return d ? d.target : fallback;
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
// 规则一致 = 动作相同 且 引用应用/URL 相同（URL 库引用即「访问网站/…」路径，含在 apps 里，
// 已是完整路径，不需要再单独比对后端裁剪成裸库名的 urls 字段——与展示层保持一致）。
function ruleEq(s: PolicyRule, t: PolicyRule): boolean {
  return s.action === t.action && sameKeys(s.apps.map((a) => a.path), t.apps.map((a) => a.path));
}

// 统计策略实际差异处数：规则级（新增/变更/目标多出，含动作差异）+ 段/策略级标量（启用、各段开关、
// 端口规则、代理配置）。用于「差异 N 处」徽标。
function countPolicyDiffs(src: Record<string, unknown>, diffs: FieldDiff[], targetMissing: boolean): number {
  if (targetMissing) return asRules(src.rules).length + 1; // 目标整体缺失：整条策略将新增
  const srcRules = asRules(src.rules);
  const tgtRules = asRules(targetVal(diffs, "rules", src.rules));
  let n = 0;
  const max = Math.max(srcRules.length, tgtRules.length);
  for (let i = 0; i < max; i++) {
    const s = srcRules[i];
    const tg = tgtRules[i];
    if (!s && tg) n++;
    else if (s && !tg) n++;
    else if (s && tg && !ruleEq(s, tg)) n++;
  }
  for (const f of ["enable", "application_include", "network_include", "network_rules", "proxy_include", "proxy"]) {
    if (diffs.some((d) => d.field === f)) n++;
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

// 一类引用（如「自定义应用」）：列出条目，按状态着色。showCount=false 时不显示数量（用于「动作」行）。
function CategoryRow({
  label,
  items,
  showCount = true,
}: {
  label: string;
  items: { value: string; state: RefState }[];
  showCount?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 text-xs">
      <span className="text-muted-foreground/50 whitespace-nowrap">
        {label}
        {showCount && <span className="text-muted-foreground/30">（{items.length}）</span>}
      </span>
      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
        {items.map((it, i) => (
          <span key={i} className={`break-all ${REF_STATE_CLS[it.state]}`}>{it.value}</span>
        ))}
      </span>
    </div>
  );
}

// 一行标量差异（启用/段开关/代理项）：相同弱化、不同高亮 源→目标。
function ScalarLine({ label, s, t, changed }: { label: string; s: string; t?: string; changed: boolean }) {
  return (
    <div className="grid grid-cols-[76px_1fr_1fr] gap-x-3 items-baseline text-xs">
      <span className={changed ? "text-amber-300/70" : "text-muted-foreground/50"}>{label}</span>
      <span className={changed ? "text-emerald-400" : "text-muted-foreground/60"}>{s}</span>
      {t === undefined ? (
        <span className="text-muted-foreground/50 italic">（新建）</span>
      ) : (
        <span className={changed ? "text-red-400" : "text-muted-foreground/60"}>{t}</span>
      )}
    </div>
  );
}

/**
 * 策略差异：**只覆盖 应用控制 / 端口控制 / 代理控制 三段 + 启用状态**（其余段——Web 关键字/
 * 文件类型过滤、邮件、QQ、SaaS 等——不参与对比、不在此显示）。应用/端口规则按位置对位、
 * 忽略跨实例 rule_id；段开关为关时不比该段规则。
 */
function PolicyDiff({ src, diffs, targetMissing }: { src: Record<string, unknown>; diffs: FieldDiff[]; targetMissing: boolean }) {
  const srcRules = asRules(src.rules);
  const tgtRules = targetMissing ? [] : asRules(targetVal(diffs, "rules", src.rules));

  const srcEnable = src.enable !== false;
  const tgtEnable = targetMissing ? undefined : targetVal(diffs, "enable", src.enable) !== false;
  const srcAppInc = !!src.application_include;
  const tgtAppInc = targetMissing ? false : !!targetVal(diffs, "application_include", src.application_include);
  const srcNetInc = !!src.network_include;
  const tgtNetInc = targetMissing ? false : !!targetVal(diffs, "network_include", src.network_include);
  const srcProxyInc = !!src.proxy_include;
  const tgtProxyInc = targetMissing ? false : !!targetVal(diffs, "proxy_include", src.proxy_include);

  // 策略级 / 段开关差异（只列不同的）
  const scalarLines: { label: string; s: string; t?: string; changed: boolean }[] = [];
  const onoff = (v: boolean) => (v ? "启用" : "关闭");
  if (targetMissing || srcEnable !== tgtEnable)
    scalarLines.push({ label: "策略启用", s: srcEnable ? "启用" : "禁用", t: targetMissing ? undefined : tgtEnable ? "启用" : "禁用", changed: true });
  if (targetMissing || srcAppInc !== tgtAppInc)
    scalarLines.push({ label: "应用控制", s: onoff(srcAppInc), t: targetMissing ? undefined : onoff(tgtAppInc), changed: true });
  if (targetMissing || srcNetInc !== tgtNetInc)
    scalarLines.push({ label: "端口控制", s: onoff(srcNetInc), t: targetMissing ? undefined : onoff(tgtNetInc), changed: true });
  if (targetMissing || srcProxyInc !== tgtProxyInc)
    scalarLines.push({ label: "代理控制", s: onoff(srcProxyInc), t: targetMissing ? undefined : onoff(tgtProxyInc), changed: true });

  // 端口控制规则（源/目标文本化后做行级增删）
  const showNet = srcNetInc || tgtNetInc;
  const netItems = showNet
    ? diffCategory(asNetRules(src.network_rules).map(netRuleText), targetMissing ? [] : asNetRules(targetVal(diffs, "network_rules", src.network_rules)).map(netRuleText))
    : [];

  // 代理控制配置（http/sock/errorproto 开关）
  const showProxy = srcProxyInc || tgtProxyInc;
  const srcProxy = (src.proxy ?? {}) as Record<string, unknown>;
  const tgtProxy = (targetMissing ? {} : (targetVal(diffs, "proxy", src.proxy) ?? {})) as Record<string, unknown>;
  const proxyLabels: Record<string, string> = { http: "HTTP 代理", sock: "SOCKS 代理", errorproto: "非标准协议" };
  const proxyLines = Object.entries(proxyLabels)
    .map(([k, label]) => {
      const sv = !!srcProxy[k];
      const tv = !!tgtProxy[k];
      return { label, s: onoff(sv), t: targetMissing ? undefined : onoff(tv), changed: targetMissing || sv !== tv };
    })
    .filter((l) => l.changed);

  const showAppRules = srcAppInc || tgtAppInc;
  const max = Math.max(srcRules.length, tgtRules.length);
  const rows = Array.from({ length: max }, (_, i) => ({ s: srcRules[i], tg: tgtRules[i], pos: i + 1 }));

  return (
    <div className="space-y-2">
      {/* 策略级 / 段开关差异 */}
      {scalarLines.length > 0 && (
        <div className="space-y-0.5 rounded border border-amber-500/20 bg-amber-500/[0.06] px-3 py-1.5">
          {scalarLines.map((l) => (
            <ScalarLine key={l.label} {...l} />
          ))}
        </div>
      )}

      {/* 应用控制：规则逐条对位（含动作） */}
      {showAppRules && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground/60">应用控制</div>
          <div className="space-y-1.5">
            {rows.map(({ s, tg, pos }) => {
        const isExtra = !s && !!tg; // 目标多出（将删除）
        const isNew = !!s && (targetMissing || !tg);
        const effTg = targetMissing ? undefined : tg; // 目标整体不存在时不参与比对（全部按新增）
        const changed = !!s && !!effTg && !ruleEq(s, effTg);
        const highlight = isNew || isExtra || changed;

        const srcApps = s?.apps ?? [];
        const tgtApps = effTg?.apps ?? [];
        const pick = <T,>(arr: T[], f: (x: T) => boolean) => arr.filter(f);
        const customApps = diffCategory(
          pick(srcApps, (a) => a.custom && !isUrlRef(a.path)).map((a) => a.path),
          pick(tgtApps, (a) => a.custom && !isUrlRef(a.path)).map((a) => a.path)
        );
        const builtinApps = diffCategory(
          pick(srcApps, (a) => !a.custom && !isUrlRef(a.path)).map((a) => a.path),
          pick(tgtApps, (a) => !a.custom && !isUrlRef(a.path)).map((a) => a.path)
        );
        const urlRefs = diffCategory(
          pick(srcApps, (a) => isUrlRef(a.path)).map((a) => a.path),
          pick(tgtApps, (a) => isUrlRef(a.path)).map((a) => a.path)
        );
        const empty = customApps.length + builtinApps.length + urlRefs.length === 0;
        // 动作也用引用条目同一套 diff 着色：源动作=绿(将加到目标)、目标旧动作=红删除线(将删)、一致=灰
        const actionItems = diffCategory(
          s ? [actionText(s.action)] : [],
          effTg ? [actionText(effTg.action)] : []
        );

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
            <div className="space-y-0.5">
              {/* 动作下沉为一行，与引用条目用同一套 diff 着色（源绿/目标红删除线/一致灰） */}
              <CategoryRow label="动作" items={actionItems} showCount={false} />
              {empty ? (
                <p className="text-muted-foreground/40 text-xs">（无应用 / URL 引用）</p>
              ) : (
                <>
                  <CategoryRow label="自定义应用" items={customApps} />
                  <CategoryRow label="内置应用" items={builtinApps} />
                  <CategoryRow label="URL库" items={urlRefs} />
                </>
              )}
            </div>
          </div>
        );
            })}
          </div>
        </div>
      )}

      {/* 端口控制：规则行级增删（源/目标文本化） */}
      {showNet && netItems.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground/60">端口控制</div>
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {netItems.map((it, i) => (
              <span key={i} className={`break-all ${REF_STATE_CLS[it.state]}`}>
                {it.value}
              </span>
            ))}
          </span>
        </div>
      )}

      {/* 代理控制：http/sock/errorproto 开关差异 */}
      {showProxy && proxyLines.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground/60">代理控制</div>
          <div className="space-y-0.5">
            {proxyLines.map((l) => (
              <ScalarLine key={l.label} {...l} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 对象内容差异主体（策略规则级 / 其他字段级），TargetCard 与全量对比复用 ─────────────

function ObjectDiffBody({
  objectType,
  src,
  diffs,
  targetMissing,
}: {
  objectType: ObjectType;
  src: Record<string, unknown>;
  diffs: FieldDiff[];
  targetMissing: boolean;
}) {
  const [showSameFields, setShowSameFields] = useState(false);
  const diffedFields = useMemo(() => new Set(diffs.map((d) => d.field)), [diffs]);

  // 整理字段：变化的按「主体（高优先级）/ 次要」分开，其余归「相同」。
  const { mainChanged, minorChanged, sameFields } = useMemo(() => {
    const all = Object.keys(src).filter((k) => k in FIELD_LABELS || LIST_FIELDS.has(k));
    const main: string[] = [];
    const minor: string[] = [];
    const same: string[] = [];
    for (const k of all) {
      if (targetMissing || diffedFields.has(k)) (HIGH_PRIORITY.has(k) ? main : minor).push(k);
      else same.push(k);
    }
    return { mainChanged: main, minorChanged: minor, sameFields: same };
  }, [src, diffedFields, targetMissing]);

  // 策略：应用/端口/代理三段 + 启用状态对比（后端已按内容判定，rule_id 差异不计）
  if (objectType === "policy") {
    return <PolicyDiff src={src} diffs={diffs} targetMissing={targetMissing} />;
  }

  return (
    // 自带统一竖向间距，避免在不同父容器（TargetCard / 对比展开行）里「变化」与「相同」块间距不一致
    <div className="space-y-2">
      {/* 主体变化：高优先级功能字段（方向/协议/端口/IP/域名/URL 列表），突出显示 */}
      {mainChanged.length > 0 && (
        <div className="space-y-1.5">
          {mainChanged.map((field) => {
            const srcVal = src[field];
            const diff = diffs.find((d) => d.field === field);
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

      {/* 次要变化：其余字段的差异也显示，但弱化（暗底 + 淡色），不抢主体 */}
      {minorChanged.length > 0 && (
        <div className="space-y-0.5 rounded border border-border/30 bg-muted/[0.06] px-3 py-1.5">
          {minorChanged.map((field) => {
            const tgtVal = diffs.find((d) => d.field === field)?.target;
            return (
              <div key={field} className="grid grid-cols-[90px_1fr_1fr] gap-x-3 items-baseline text-xs">
                <span className="text-muted-foreground/50 shrink-0">{FIELD_LABELS[field] ?? field}</span>
                <span className="text-emerald-400/60 break-all">{fmtScalar(field, src[field]) || "—"}</span>
                {targetMissing ? (
                  <span className="text-muted-foreground/40 italic">（新建）</span>
                ) : (
                  <span className="text-red-400/60 break-all">{fmtScalar(field, tgtVal) || "—"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 相同字段 ── 可折叠 */}
      {!targetMissing && sameFields.length > 0 && (
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
  const targetMissing = !t.exists && !t.error;

  // 策略按「规则级 + 段/启用级」实际差异计数；其他对象按字段级 diff 计数。
  const diffCount = objectType === "policy" ? countPolicyDiffs(src, t.diffs, targetMissing) : t.diffs.length;

  // 策略：以规则级实际差异数为准（后端因 rule_id 跨实例不同会误标 changed，但内容可能一致）
  const reallyChanged = objectType === "policy" ? diffCount > 0 : t.changed;
  const badge = t.error ? (
    <Badge variant="destructive">读取错误</Badge>
  ) : targetMissing ? (
    <Badge variant="warning">目标不存在（将新增）</Badge>
  ) : reallyChanged ? (
    <Badge variant="warning">差异 {diffCount} 处</Badge>
  ) : (
    // 策略仅比核心控制段，不等于整条完全一致——文案讲清范围
    <Badge variant="success">{objectType === "policy" ? "核心段一致" : "已一致"}</Badge>
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
      {!t.error && (
        <ObjectDiffBody objectType={objectType} src={src} diffs={t.diffs} targetMissing={targetMissing} />
      )}
    </div>
  );
}

// ── 源快照摘要 ────────────────────────────────────────────────────────────────

// 从规范化快照提取一组摘要 chip（方向/协议/条数/规则数…），源摘要与全量对比只读视图共用。
function snapshotChips(data: Record<string, unknown>, objectType: ObjectType): { label: string; value: string }[] {
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
    // 策略覆盖三段：应用控制 / 端口控制 / 代理控制，各段以 include 开关门控（关=不生效、不计），
    // 否则只配了端口控制的策略会误显示为「规则数 0」、看不到实际内容。
    chips.push({ label: "启用", value: data.enable === false ? "否" : "是" });
    const rules = Array.isArray(data.rules) ? data.rules : [];
    const netRules = Array.isArray(data.network_rules) ? data.network_rules : [];
    if (data.application_include && rules.length)
      chips.push({ label: "应用控制", value: `${rules.length} 条规则` });
    if (data.network_include && netRules.length)
      chips.push({ label: "端口控制", value: `${netRules.length} 条规则` });
    const proxy = (data.proxy ?? {}) as Record<string, unknown>;
    if (data.proxy_include && (proxy.http || proxy.sock || proxy.errorproto))
      chips.push({ label: "代理控制", value: "启用" });
  }
  return chips;
}

function snapshotName(data: Record<string, unknown>): string {
  return String(data.rulename ?? data.name ?? data.policy_name ?? "");
}

function SourceSummary({ data, objectType }: { data: Record<string, unknown>; objectType: ObjectType }) {
  const chips = snapshotChips(data, objectType);
  const name = snapshotName(data);
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

// ── 只读快照视图（全量对比中「仅源有 / 仅目标有」的内容明细） ─────────────────────

function SnapshotView({ data, objectType }: { data: Record<string, unknown>; objectType: ObjectType }) {
  const chips = snapshotChips(data, objectType);
  const depict = String(data.depict ?? "").trim();
  // 列表型内容（URL 条目 / IP / 域名）逐条列出，中性色只读展示
  const lists: { label: string; entries: string[] }[] = [];
  if (objectType === "url") lists.push({ label: "URL 列表", entries: parseEntries(data.url) });
  if (objectType === "customrule") {
    const ips = parseEntries(data.ip_range);
    const doms = parseEntries(data.domain);
    if (ips.length) lists.push({ label: "IP 范围", entries: ips });
    if (doms.length) lists.push({ label: "域名", entries: doms });
  }
  // 策略三段（与 PolicyDiff 一致，只读单边展示、中性色）：应用控制 / 端口控制 / 代理控制，
  // 各段以 include 开关门控——否则只配端口控制的策略会看不到内容。
  const rules = objectType === "policy" ? asRules(data.rules) : [];
  const netRules = objectType === "policy" ? asNetRules(data.network_rules) : [];
  const proxy = (data.proxy ?? {}) as Record<string, unknown>;
  const proxyItems =
    objectType === "policy" && data.proxy_include
      ? ([proxy.http && "HTTP 代理", proxy.sock && "SOCKS 代理", proxy.errorproto && "非标准协议"].filter(
          Boolean
        ) as string[])
      : [];
  const showApp = objectType === "policy" && !!data.application_include && rules.length > 0;
  const showNet = objectType === "policy" && !!data.network_include && netRules.length > 0;

  return (
    <div className="space-y-1.5 text-xs">
      {depict && <p className="text-muted-foreground/70">{depict}</p>}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {chips.map((c) => (
            <span key={c.label} className="text-muted-foreground/70">
              {c.label}：<span className="text-foreground/70">{c.value}</span>
            </span>
          ))}
        </div>
      )}
      {lists.map((l) => (
        <div key={l.label} className="grid grid-cols-[70px_1fr] gap-2">
          <span className="text-muted-foreground/50 whitespace-nowrap">
            {l.label}
            <span className="text-muted-foreground/30">（{l.entries.length}）</span>
          </span>
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-muted-foreground/70">
            {l.entries.map((e, i) => (
              <span key={i} className="break-all">{e}</span>
            ))}
          </span>
        </div>
      ))}
      {showApp && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground/60">应用控制</div>
          {rules.map((r, i) => {
            const apps = r.apps.map((a) => a.path).filter((p) => !isUrlRef(p));
            const urls = r.apps.map((a) => a.path).filter(isUrlRef);
            return (
              <div key={i} className="rounded border border-border/40 bg-muted/10 px-2 py-1 space-y-0.5">
                <div className="text-muted-foreground/60">规则 {i + 1} · {actionText(r.action)}</div>
                {apps.length > 0 && (
                  <CategoryRow label="应用" items={apps.map((v) => ({ value: v, state: "same" as const }))} />
                )}
                {urls.length > 0 && (
                  <CategoryRow label="URL 库" items={urls.map((v) => ({ value: v, state: "same" as const }))} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {showNet && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground/60">端口控制</div>
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground/70">
            {netRules.map((r, i) => (
              <span key={i} className="break-all">{netRuleText(r)}</span>
            ))}
          </span>
        </div>
      )}
      {proxyItems.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground/60">代理控制</div>
          <span className="text-muted-foreground/70">{proxyItems.join("、")}</span>
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
        {r.refused ? (
          <Badge variant="warning">已拒绝写策略</Badge>
        ) : r.dry_run ? (
          <Badge variant="warning">{r.degraded ? "dry-run · 降级" : "dry-run"}</Badge>
        ) : !r.success ? (
          <Badge variant="destructive">失败</Badge>
        ) : r.degraded ? (
          <Badge variant="warning">降级同步</Badge>
        ) : (
          <Badge variant="success">成功</Badge>
        )}
      </div>
      <div className={`text-xs ${r.refused || r.degraded ? "text-amber-300/90" : "text-muted-foreground"}`}>{r.message}</div>

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
            {r.warnings.length} 个引用在目标无法解析（内置对象缺失，或自定义引用创建失败）
            {r.refused
              ? "，因此已拒绝写入策略（策略未写入）："
              : "，同步时已跳过这些引用（策略与源不等价）："}
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

function BatchResultCard({ t, objectType }: { t: BatchTargetResult; objectType: ObjectType }) {
  const total = t.created.length + t.updated.length + t.deleted.length + t.failed.length;
  // 保护性跳过（如镜像删除时策略在用不删），单独列出让用户知道哪些对象被留下及原因
  const skipped = t.details.filter((d) => d.action === "skip");
  // 策略镜像删除的 dry-run 只列候选名单、不做引用校验（真实执行才校验，遍历组织树较慢）；
  // BatchTargetResult.deleted 只是名称数组，不带 details 里的候选说明，故单独提示一行。
  const showPolicyDryRunDeleteNote = objectType === "policy" && t.dry_run && t.deleted.length > 0;
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{t.instance_name}</span>
        {t.error ? (
          <Badge variant="destructive">读取失败</Badge>
        ) : t.failed.length > 0 ? (
          <Badge variant="warning">{t.failed.length} 项失败</Badge>
        ) : total === 0 && skipped.length > 0 ? (
          // 全部是保护性跳过（如镜像删除时策略在用）而没有其它变更时，不能说「无变化」——
          // 目标其实有多余对象，只是为安全没删，容易被误读成「目标已和源一致」
          <Badge variant="secondary">已跳过 {skipped.length} 项</Badge>
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
          {skipped.length > 0 && (
            <span title="保护性跳过：如镜像删除时策略仍被用户引用，不删除">
              跳过 <span className="text-sky-300">{skipped.length}</span>
            </span>
          )}
        </div>
      )}
      {!t.error && t.updated.length > 0 && (
        <p className="text-[11px] text-muted-foreground/60">
          「覆盖」= 目标已存在同名对象，将写入源内容覆盖（批量不逐项比对内容；要看内容差异请用「单个对象」模式）。
        </p>
      )}
      {!t.error && showPolicyDryRunDeleteNote && (
        <p className="text-[11px] text-amber-400/80">
          「删除」为候选名单，预览不做引用校验；真实执行时若策略仍被引用会改为跳过、不会真正删除。
        </p>
      )}
      <div className="space-y-1">
        <BatchNameList label="新增" names={t.created} cls="text-emerald-400" />
        <BatchNameList label="覆盖" names={t.updated} cls="text-sky-400" />
        <BatchNameList label="删除" names={t.deleted} cls="text-red-400" />
        {skipped.length > 0 && (
          <div className="rounded-md border border-sky-500/25 bg-sky-500/[0.06] p-2 space-y-0.5">
            {skipped.map((d) => (
              <div key={d.name} className="text-xs">
                <span className="text-sky-300/90">{d.name}</span>
                <span className="text-muted-foreground"> — {d.message}</span>
              </div>
            ))}
          </div>
        )}
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

// ── 全量对比：结果渲染（只读） ────────────────────────────────────────────────

const COMPARE_META: Record<CompareStatus, { label: string; cls: string }> = {
  different: { label: "内容不一致", cls: "text-amber-400" },
  source_only: { label: "仅源有", cls: "text-emerald-400" },
  target_only: { label: "仅目标有", cls: "text-sky-400" },
  both: { label: "两边都有", cls: "text-muted-foreground/70" },
  error: { label: "读取失败", cls: "text-red-400" },
  identical: { label: "内容一致", cls: "text-muted-foreground/60" },
};

// 单个对象行：可展开明细（不一致→字段/规则 diff；仅源/仅目标→只读快照）。
function CompareItemRow({ item, objectType }: { item: CompareItem; objectType: ObjectType }) {
  const [open, setOpen] = useState(false);
  const expandable =
    (item.status === "different" && !!item.source_snapshot) ||
    (item.status === "source_only" && !!item.source_snapshot) ||
    (item.status === "target_only" && !!item.target_snapshot);
  return (
    <div className="rounded border border-border/40">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/20 transition-colors disabled:cursor-default disabled:hover:bg-transparent"
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
      >
        {expandable ? (
          open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`break-all ${item.status === "identical" ? "text-muted-foreground/70" : "font-medium"}`}>
          {item.name}
        </span>
        {item.status === "error" && item.error && <span className="text-red-400/80">— {item.error}</span>}
      </button>
      {open && expandable && (
        <div className="border-t border-border/40 px-2.5 py-2">
          {item.status === "different" && item.source_snapshot ? (
            <ObjectDiffBody
              objectType={objectType}
              src={item.source_snapshot}
              diffs={item.diffs}
              targetMissing={false}
            />
          ) : item.status === "source_only" && item.source_snapshot ? (
            <SnapshotView data={item.source_snapshot} objectType={objectType} />
          ) : item.status === "target_only" && item.target_snapshot ? (
            <SnapshotView data={item.target_snapshot} objectType={objectType} />
          ) : null}
        </div>
      )}
    </div>
  );
}

// 一个分类分组（如「内容不一致」）：可折叠，列出该类下所有对象行。
function CompareGroup({
  status,
  items,
  objectType,
  defaultOpen,
}: {
  status: CompareStatus;
  items: CompareItem[];
  objectType: ObjectType;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const meta = COMPARE_META[status];
  return (
    <div className="space-y-1">
      <button
        className="flex items-center gap-1 text-xs font-medium hover:opacity-80 transition-opacity"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className={meta.cls}>{meta.label}</span>
        <span className="text-muted-foreground/50">{items.length}</span>
      </button>
      {open && (
        <div className="space-y-1 pl-1">
          {items.map((it) => (
            <CompareItemRow key={it.name} item={it} objectType={objectType} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompareResultCard({
  t,
  objectType,
  namesOnly,
}: {
  t: CompareTargetResult;
  objectType: ObjectType;
  namesOnly: boolean;
}) {
  // 仅名单：源/目标/都有三桶；内容：不一致/仅源/仅目标/一致四桶。
  const groups: CompareStatus[] = namesOnly
    ? ["source_only", "target_only", "error", "both"]
    : ["different", "source_only", "target_only", "error", "identical"];
  const byStatus = (s: CompareStatus) => t.items.filter((i) => i.status === s);
  const hasNameDiff = t.source_only + t.target_only > 0;
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{t.instance_name}</span>
        {t.error ? (
          <Badge variant="destructive">读取失败</Badge>
        ) : namesOnly ? (
          hasNameDiff ? <Badge variant="warning">名单有差异</Badge> : <Badge variant="success">名单一致</Badge>
        ) : t.different + t.error_count > 0 ? (
          <Badge variant="warning">{t.different} 处不一致</Badge>
        ) : hasNameDiff ? (
          <Badge variant="warning">名单有差异</Badge>
        ) : (
          <Badge variant="success">{objectType === "policy" && !namesOnly ? "核心段一致" : "完全一致"}</Badge>
        )}
      </div>
      {t.error && <p className="text-xs text-destructive">{t.error}</p>}
      {!t.error && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {namesOnly ? (
              <>
                <span>仅源有 <span className="text-emerald-400">{t.source_only}</span></span>
                <span>仅目标有 <span className="text-sky-400">{t.target_only}</span></span>
                <span>两边都有 <span className="text-muted-foreground/70">{t.both}</span></span>
              </>
            ) : (
              <>
                <span>不一致 <span className="text-amber-400">{t.different}</span></span>
                <span>仅源有 <span className="text-emerald-400">{t.source_only}</span></span>
                <span>仅目标有 <span className="text-sky-400">{t.target_only}</span></span>
                <span>一致 <span className="text-muted-foreground/70">{t.identical}</span></span>
              </>
            )}
            {t.error_count > 0 && <span>失败 <span className="text-red-400">{t.error_count}</span></span>}
          </div>
          {objectType === "policy" && !namesOnly && (
            <p className="text-[11px] text-muted-foreground/60">
              * 策略的「一致/不一致」仅就 <span className="text-muted-foreground/80">应用控制 / 端口控制 / 代理控制 + 启用状态</span> 判定，不含其余段（Web 过滤/邮件/QQ/SaaS 等）。
            </p>
          )}
          <div className="space-y-1.5">
            {groups.map((s) => (
              <CompareGroup
                key={s}
                status={s}
                items={byStatus(s)}
                objectType={objectType}
                defaultOpen={s !== "identical" && s !== "both"}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export function SyncPage() {
  const qc = useQueryClient();
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
  // 意图：对比（只读，理解差异）/ 同步（写入，推送变更）——读写分离，写入口只在「同步」下出现
  const [mode, setMode] = useState<"compare" | "sync">("compare");
  // 镜像：删除目标多余对象（仅同步 + 全部对象）
  const [mirror, setMirror] = useState(false);
  // 策略同步：允许写入「降级（丢弃了目标缺失引用、与源不等价）」的策略；默认关（后端会拒绝降级写入）
  const [allowDegrade, setAllowDegrade] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchSyncResult | null>(null);
  const [compareResult, setCompareResult] = useState<BatchCompareResult | null>(null);

  const sourceName = instances.find((i) => i.id === sourceId)?.name ?? "源";
  const isPolicy = objectType === "policy";
  // 范围（单个/全部）是对象选择框里的子选项：选「全部对象」哨兵即整类批量
  const isBatch = objectName === ALL_OBJECTS;
  const isCompare = mode === "compare";

  // 当前配置指纹；与 resultKey 不一致即说明右侧结果已过期
  const currentKey = JSON.stringify({
    mode, objectType, sourceId, objectName, mirror, targets: [...targets].sort(),
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
    onSuccess: (r) => { setDiff(r); setApplyResult(null); setCompareResult(null); setResultKey(currentKey); },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "差异计算失败"),
  });

  // 只读对比（batch 模式）。namesOnly=true 只比名单（秒级）；false 比内容（四分类，较慢）。
  const compareMut = useMutation({
    mutationFn: ({ namesOnly, force }: { namesOnly: boolean; force?: boolean }) =>
      syncApi.compare({
        object_type: objectType,
        source_instance_id: sourceId!,
        target_instance_ids: targets,
        names_only: namesOnly,
        force: force ?? false,
      }),
    onSuccess: (r) => { setCompareResult(r); setBatchResult(null); setResultKey(currentKey); },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "对比失败"),
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
        allow_degrade: allowDegrade,
      }),
    onSuccess: (r, vars) => {
      setApplyResult(r);
      setCompareResult(null);
      setResultKey(currentKey);
      setConfirmApply(null);
      if (vars.dryRun) {
        toast.success("已生成同步预览（dry-run）");
      } else {
        // 真实写入：失效所有目标实例的相关缓存，避免切到目标页面 30 秒内仍看到旧数据
        for (const x of r.results) invalidateTargetInstanceQueries(qc, x.instance_id);
        const failed = r.results.filter((x) => !x.success).length;
        const degraded = r.results.filter((x) => x.degraded && x.success).length;
        if (failed > 0) toast.warning(`同步完成，${failed} 个目标失败/被拒绝`);
        else if (degraded > 0) toast.warning(`同步完成，${degraded} 个为降级写入（与源不等价）`);
        else toast.success("同步完成");
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
        allow_degrade: allowDegrade,
      }),
    onSuccess: (r, vars) => {
      setBatchResult(r);
      setCompareResult(null);
      setResultKey(currentKey);
      setConfirmApply(null);
      const failed = r.targets.reduce((n, t) => n + t.failed.length, 0);
      if (vars.dryRun) {
        toast.success("已生成批量同步预览（dry-run）");
      } else {
        // 真实写入：失效所有目标实例的相关缓存，避免切到目标页面 30 秒内仍看到旧数据
        for (const t of r.targets) invalidateTargetInstanceQueries(qc, t.instance_id);
        if (failed === 0) toast.success("批量同步完成");
        else toast.warning(`批量同步完成，${failed} 项失败`);
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "批量同步失败"),
  });

  function toggleTarget(id: number) {
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  const ready = sourceId != null && objectName !== "";
  const applying = applyMut.isPending || batchMut.isPending;
  const comparing = compareMut.isPending;
  // 当前意图 + 范围对应的结果：对比→字段差异 / 全量对比；同步→单对象写 / 批量写
  const activeResult = isCompare ? (isBatch ? compareResult : diff) : isBatch ? batchResult : applyResult;

  return (
    <div className="space-y-5">
      <PageHeader
        title="实例对比与同步"
        description="先「对比」理解两实例的差异（只读，不写设备），再「同步」把源推送到目标。两种意图分开：对比页只有对比按钮，写入口只在同步页出现。"
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr] lg:items-start">
        {/* 左：配置 */}
        <Card className="lg:sticky lg:top-4">
          <CardHeader><CardTitle className="text-base">配置</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* 意图：对比（只读）/ 同步（写入） */}
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1">
              {(["compare", "sync"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    mode === m
                      ? m === "sync"
                        ? "bg-background text-amber-500 shadow-sm"
                        : "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "compare" ? "对比（只读）" : "同步（写入）"}
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
              {isPolicy && (
                <p className="text-[11px] text-muted-foreground/70">
                  策略仅对比 <span className="text-foreground/70">应用控制 / 端口控制 / 代理控制</span> 三段及启用状态；
                  其余段（Web 关键字/文件类型过滤、邮件、QQ、SaaS 等）不参与对比，也不在差异里显示。
                </p>
              )}
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

            {/* 范围作为对象选择框的子选项：首项「全部对象」= 整类批量，其余为具体对象 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {isCompare ? "对比范围" : "同步范围"} {names.isFetching && <Spinner className="ml-1 inline" />}
              </Label>
              <Combobox
                options={[
                  { value: ALL_OBJECTS, label: `全部对象（${names.data?.length ?? 0} 个）` },
                  ...(names.data ?? []).map((n) => ({ value: n, label: n })),
                ]}
                value={objectName}
                onChange={setObjectName}
                disabled={sourceId == null}
                placeholder={sourceId == null ? "请先选择源实例" : "选择「全部对象」或某个具体对象"}
                searchPlaceholder="输入关键字搜索…"
                emptyText="无匹配对象"
              />
              {isBatch && (
                <p className="text-[11px] text-muted-foreground">
                  {isCompare ? "将对比源与目标的" : "将把源的"}
                  <span className="text-foreground/70">全部{OBJECT_TYPES.find((t) => t.value === objectType)?.label}</span>
                  {isCompare ? "（名单 + 内容）。" : "写入所选目标。"}
                </p>
              )}
            </div>

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

            {isBatch && !isCompare && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium text-amber-300/90">镜像模式</Label>
                  <p className="text-[11px] text-muted-foreground">删除目标上「源没有」的{OBJECT_TYPES.find((t) => t.value === objectType)?.label}</p>
                </div>
                <Switch checked={mirror} onCheckedChange={setMirror} />
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              {isCompare ? (
                // 对比（只读）：无写按钮。单对象→字段级差异；全部对象→「只对比名称」/「对比名称和内容」二选一。
                isBatch ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => compareMut.mutate({ namesOnly: true })}
                      disabled={!ready || targets.length === 0 || comparing}
                      title="只比对象名单：仅源有 / 仅目标有 / 两边都有（不拉详情，秒级）"
                    >
                      {comparing && compareMut.variables?.namesOnly === true ? <Spinner /> : <Scale className="h-4 w-4" />}
                      只对比名称
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => compareMut.mutate({ namesOnly: false })}
                      disabled={!ready || targets.length === 0 || comparing}
                      title="比名单 + 内容：仅源有 / 仅目标有 / 一致 / 不一致（逐对象拉详情，较慢）"
                    >
                      {comparing && compareMut.variables?.namesOnly === false ? <Spinner /> : <GitCompareArrows className="h-4 w-4" />}
                      对比名称和内容
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => diffMut.mutate()}
                    disabled={!ready || targets.length === 0 || diffMut.isPending}
                    title="比源与目标该对象的字段级差异，不写设备"
                  >
                    {diffMut.isPending ? <Spinner /> : <Scale className="h-4 w-4" />}
                    开始对比
                  </Button>
                )
              ) : (
                // 同步（写入）：先「同步预览」看将执行什么（dry-run），再确认写入。
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      isBatch
                        ? batchMut.mutate({ pushAll: false, dryRun: true })
                        : applyMut.mutate({ pushAll: false, dryRun: true })
                    }
                    disabled={!ready || targets.length === 0 || applying}
                    title="dry-run：只算并展示将执行的写操作（新增/覆盖/删除），不改设备"
                  >
                    {applying ? <Spinner /> : <GitCompareArrows className="h-4 w-4" />}
                    同步预览
                  </Button>
                  <Button onClick={() => setConfirmApply({ pushAll: false, batch: isBatch })} disabled={!ready || targets.length === 0 || applying}>
                    <ArrowRight className="h-4 w-4" />
                    {isBatch ? "批量同步到所选" : "同步到所选目标"}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmApply({ pushAll: true, batch: isBatch })} disabled={!ready || applying}>
                    <Rocket className="h-4 w-4" />
                    一键推送到全部
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 右：对比 / 同步 结果 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isCompare
                ? isBatch
                  ? "全部对象对比（只读）"
                  : "单个对象对比（只读）"
                : isBatch
                ? batchResult
                  ? batchResult.targets.some((t) => !t.dry_run)
                    ? "批量同步结果"
                    : "批量同步预览（dry-run）"
                  : "批量同步"
                : applyResult
                ? applyResult.results.some((r) => !r.dry_run)
                  ? "同步结果"
                  : "同步预览（dry-run）"
                : "同步"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* 配置已变更：保留上次结果但标记过期，提示重新执行 */}
            {stale && activeResult && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs">
                <span className="text-amber-300/90">配置已变更，下方为上一次的结果（已过期）。</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0"
                  onClick={() =>
                    isCompare
                      ? isBatch
                        ? compareMut.mutate({ namesOnly: compareResult?.names_only ?? false })
                        : diffMut.mutate()
                      : isBatch
                      ? batchMut.mutate({ pushAll: false, dryRun: true })
                      : applyMut.mutate({ pushAll: false, dryRun: true })
                  }
                  disabled={!ready || targets.length === 0 || diffMut.isPending || applying || comparing}
                >
                  {diffMut.isPending || applying || comparing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {isCompare ? "重新对比" : "重新预览"}
                </Button>
              </div>
            )}

            <div className={stale ? "pointer-events-none opacity-40 transition-opacity" : "transition-opacity"}>
              <div className="space-y-3">
                {isCompare ? (
                  isBatch ? (
                    compareResult ? (
                      <>
                        <div className="text-xs text-muted-foreground">
                          源共 {compareResult.source_count} 个对象 ·{" "}
                          {compareResult.names_only
                            ? "只对比名称（仅比对象名单，未拉内容）"
                            : "对比名称和内容（逐对象，只读不写设备）"}
                          {!compareResult.names_only && compareResult.source_cached && (
                            <span className="text-amber-500/80" title="源快照来自缓存；写操作后或缓存过期会自动重取">
                              {" "}· 源快照缓存{
                                compareResult.source_cache_age_seconds < 60
                                  ? "刚刚"
                                  : `${Math.floor(compareResult.source_cache_age_seconds / 60)}分钟前`
                              }
                            </span>
                          )}
                        </div>
                        {compareResult.targets.map((t) => (
                          <CompareResultCard
                            key={t.instance_id}
                            t={t}
                            objectType={objectType}
                            namesOnly={compareResult.names_only}
                          />
                        ))}
                      </>
                    ) : (
                      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                        配置左侧后点击「只对比名称」或「对比名称和内容」
                      </div>
                    )
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
                      配置左侧后点击「开始对比」
                    </div>
                  )
                ) : isBatch ? (
                  batchResult ? (
                    <>
                      <div className="text-xs text-muted-foreground">
                        源共 {batchResult.source_count} 个对象{batchResult.mirror && <span className="text-amber-300/90"> · 镜像模式（删除目标多余）</span>}
                      </div>
                      {batchResult.targets.map((t) => (
                        <BatchResultCard key={t.instance_id} t={t} objectType={batchResult.object_type} />
                      ))}
                    </>
                  ) : (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      配置左侧后点击「同步预览」，或直接「批量同步 / 一键推送」（会先弹确认）
                    </div>
                  )
                ) : applyResult ? (
                  applyResult.results.map((r) => <ApplyResultCard key={r.instance_id} r={r} />)
                ) : (
                  <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                    配置左侧后点击「同步预览」，或直接「同步 / 一键推送」（会先弹确认）
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
                    <div className="space-y-2">
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-300/90">
                        访问权限策略会按目标设备的 crc 重建报文写入：目标缺少的「自定义」应用 / URL 库会自动先建到目标；
                        但若目标有<span className="font-medium">无法解析的引用</span>（内置对象缺失、或自定义引用创建失败），丢掉它会写出与源<span className="font-medium">不等价（降级）</span>的策略（如拒绝规则少挡了对象=安全缺口）。此时<span className="font-medium">默认拒绝写入策略</span>（已建的自定义对象会保留在目标）。建议先「仅预览」核对。
                      </div>
                      <label className="flex items-start gap-2 rounded-md border border-rose-500/25 bg-rose-500/[0.05] px-3 py-2 text-xs text-rose-300/90">
                        <input
                          type="checkbox"
                          checked={allowDegrade}
                          onChange={(e) => setAllowDegrade(e.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-rose-500"
                        />
                        <span>
                          <span className="font-medium">允许降级同步</span>：目标有无法解析的引用（内置缺失或自定义引用创建失败）时，仍写入丢弃了这些引用的
                          <span className="font-medium">不等价版本</span>（不勾则遇到此情况会被拒绝、不写策略）。
                        </span>
                      </label>
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
