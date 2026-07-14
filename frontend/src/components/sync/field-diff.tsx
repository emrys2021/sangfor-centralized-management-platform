// 对象字段级 diff 的元数据与基础小组件：字段中文名/取值格式化、行级列表 diff（ListDiff）、
// 引用条目着色（CategoryRow）与标量差异行（ScalarLine），供字段级 diff、策略 diff 与快照视图复用。
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import type { RefState } from "@/components/sync/policy-rules";
import type { FieldDiff } from "@/lib/types";

// ── 字段元数据 ────────────────────────────────────────────────────────────────

export const FIELD_LABELS: Record<string, string> = {
  rulename: "名称", depict: "描述", status: "状态", enable: "启用",
  direction: "方向", protocol: "协议", protocol_num: "协议号",
  port_mode: "端口模式", port_range: "端口范围",
  ip_mode: "IP 模式", ip_range: "IP 范围", domain: "域名",
  apptype: "应用类型", appname: "应用名",
  name: "名称", url: "URL 列表", keyword: "关键字",
};

// 内容为多行条目的字段，做行级别 diff
export const LIST_FIELDS = new Set(["ip_range", "domain", "url"]);

// 「合并两端」能并集的列表字段（自定义应用 ip_range/domain、URL 库 url/keyword）。
// 合并只并这些字段——若两端差异不含其一（如仅启用状态/描述不同），合并帮不上，故不显示按钮。
const MERGEABLE_FIELDS = new Set(["ip_range", "domain", "url", "keyword"]);

/** 差异里是否有可合并的列表字段（决定是否显示「合并两端」）。 */
export function hasMergeableDiff(diffs: FieldDiff[]): boolean {
  return diffs.some((d) => MERGEABLE_FIELDS.has(d.field));
}
// 高优先级「主体」字段：功能配置（方向/协议/端口/IP/域名，及 URL 库的 URL 列表），差异突出显示。
// 其余字段（描述/状态/应用类型/应用名/协议号/关键字…）的差异也显示，但弱化、不抢主体。
export const HIGH_PRIORITY = new Set([
  "direction", "protocol", "port_mode", "port_range", "ip_mode", "ip_range", "domain", "url",
]);

const DIRECTION_MAP: Record<string, string> = { both: "双向", upload: "上行", download: "下行" };
const PROTOCOL_MAP: Record<string, string> = { "0": "全部", "6": "TCP", "17": "UDP", "1": "ICMP" };
const PORT_MODE_MAP: Record<string, string> = { all: "所有端口", specified: "指定端口" };
const IP_MODE_MAP: Record<string, string> = { all: "所有 IP", specified: "指定 IP" };

export function fmtScalar(field: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "启用" : "禁用";
  const s = String(value).trim();
  if (field === "direction") return DIRECTION_MAP[s] ?? s;
  if (field === "protocol") return PROTOCOL_MAP[s] ?? s;
  if (field === "port_mode") return PORT_MODE_MAP[s] ?? s;
  if (field === "ip_mode") return IP_MODE_MAP[s] ?? s;
  return s;
}

export function parseEntries(val: unknown): string[] {
  return String(val ?? "").split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
}

// ── 行级别列表 diff ───────────────────────────────────────────────────────────

export function ListDiff({
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


export const REF_STATE_CLS: Record<RefState, string> = {
  added: "text-emerald-400",
  removed: "text-red-400 line-through decoration-red-400/50",
  same: "text-muted-foreground/60",
};

// 一类引用（如「自定义应用」）：列出条目，按状态着色。showCount=false 时不显示数量（用于「动作」行）。
export function CategoryRow({
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
export function ScalarLine({ label, s, t, changed }: { label: string; s: string; t?: string; changed: boolean }) {
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
