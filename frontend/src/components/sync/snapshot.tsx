// 规范化快照的只读展示：源摘要条（SourceSummary）与全量对比里「仅源有/仅目标有」的
// 内容明细（SnapshotView，策略含应用/端口/代理三段的单边展示）。
import { CategoryRow, fmtScalar, parseEntries } from "@/components/sync/field-diff";
import { actionText, asNetRules, asRules, isUrlRef, netRuleText } from "@/components/sync/policy-rules";
import type { ObjectType } from "@/lib/types";

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

export function SourceSummary({ data, objectType }: { data: Record<string, unknown>; objectType: ObjectType }) {
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

export function SnapshotView({ data, objectType }: { data: Record<string, unknown>; objectType: ObjectType }) {
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

