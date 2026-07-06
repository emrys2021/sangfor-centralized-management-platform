// 访问权限策略的双栏 side-by-side diff（左源右目标，加权序列对齐、一致行折叠、
// 本侧独有引用高亮），覆盖 应用控制/端口控制/代理控制 三段 + 启用状态。
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { REF_STATE_CLS, ScalarLine } from "@/components/sync/field-diff";
import {
  actionText,
  alignRules,
  asNetRules,
  asRules,
  diffCategory,
  isUrlRef,
  netRuleText,
  ruleEq,
  targetVal,
} from "@/components/sync/policy-rules";
import type { PolicyRule, RuleAlign } from "@/components/sync/policy-rules";
import { Badge } from "@/components/ui/badge";
import type { FieldDiff } from "@/lib/types";

// 连续「一致」规则超过此条数则折叠（少则直接显示），避免长策略里一屏全是没差异的规则。
const SAME_COLLAPSE_THRESHOLD = 6;

// 段标题（应用控制 / 端口控制 / 代理控制）：左侧强调色细竖条 + 半粗，强化段落感。
function SectionTitle({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground/75">
      <span className="h-3 w-0.5 rounded-full bg-primary/70" />
      {children}
    </div>
  );
}

// 双栏对齐中的一侧规则：高亮「本侧独有」的引用/动作（源侧绿、目标侧红删除线），共有灰显；
// rule 为空时渲染占位（对侧独有行，本侧留白）。other 为对侧规则，用于判断哪些引用是本侧独有。
function RuleSide({
  rule,
  other,
  side,
  posLabel,
  badge,
}: {
  rule?: PolicyRule;
  other?: PolicyRule;
  side: "src" | "tgt";
  posLabel: string;
  badge?: JSX.Element;
}) {
  const ownCls = side === "src" ? "text-emerald-400" : "text-red-400 line-through decoration-red-400/50";
  const dimCls = "text-muted-foreground/60";
  if (!rule) {
    return <div className="px-2.5 py-1.5 text-[11px] italic text-muted-foreground/35">—（无对应规则）</div>;
  }
  const otherSet = new Set((other?.apps ?? []).map((a) => a.path));
  const actionDiff = !other || other.action !== rule.action;
  const cats: { label: string; items: string[] }[] = [
    { label: "自定义应用", items: rule.apps.filter((a) => a.custom && !isUrlRef(a.path)).map((a) => a.path) },
    { label: "内置应用", items: rule.apps.filter((a) => !a.custom && !isUrlRef(a.path)).map((a) => a.path) },
    { label: "URL库", items: rule.apps.filter((a) => isUrlRef(a.path)).map((a) => a.path) },
  ];
  const empty = cats.every((c) => c.items.length === 0);
  return (
    <div className="space-y-1 px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted-foreground/70">{posLabel}</span>
        <span className={actionDiff ? ownCls : dimCls}>{actionText(rule.action)}</span>
        {badge}
      </div>
      {empty ? (
        <p className="text-muted-foreground/40">（无应用 / URL 引用）</p>
      ) : (
        cats.map(
          (c) =>
            c.items.length > 0 && (
              <div key={c.label} className="grid grid-cols-[62px_1fr] gap-1.5">
                <span className="whitespace-nowrap text-muted-foreground/50">
                  {c.label}
                  <span className="text-muted-foreground/30">（{c.items.length}）</span>
                </span>
                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {c.items.map((p, i) => (
                    <span key={i} className={`break-all ${otherSet.has(p) ? dimCls : ownCls}`}>
                      {p}
                    </span>
                  ))}
                </span>
              </div>
            )
        )
      )}
    </div>
  );
}

// 双栏对齐的一行：整行一个卡片（左侧状态色条 + 差异行极淡底色，行与行界限清晰）；
// 内部左源右目标，中缝一条竖线分隔；一侧独有的对面留白占位；徽标标一致/变更/新增/目标多出。
function RuleAlignRow({ row }: { row: RuleAlign }) {
  const { s, tg, sPos, tPos } = row;
  const changed = !!s && !!tg && !ruleEq(s, tg);
  const kind = !s ? "extra" : !tg ? "new" : changed ? "changed" : "same";
  // 差异行底色（一致行不加底色，弱化）；曾用左侧色条做二次强调，但 2px 细线下
  // 红/绿在深色背景中观感明显弱于 amber，粗细不均反而显乱，改为只靠底色区分。
  // 新增行不用绿色：绿色（emerald-400）在行内专指「本侧独有引用」这一更细粒度的差异，
  // 整行级别的「新增」与「变更」共用 amber，靠徽标文字区分，避免颜色语义打架。
  const tint = {
    extra: "bg-red-500/10",
    new: "bg-amber-500/10",
    changed: "bg-amber-500/10",
    same: "",
  }[kind];
  const badge =
    kind === "extra" ? (
      <Badge variant="destructive" className="h-4 px-1 text-[10px]">目标多出</Badge>
    ) : kind === "new" ? (
      <Badge variant="warning" className="h-4 px-1 text-[10px]">新增</Badge>
    ) : kind === "changed" ? (
      <Badge variant="warning" className="h-4 px-1 text-[10px]">变更</Badge>
    ) : (
      <span className="text-[10px] text-muted-foreground/40">一致</span>
    );
  // 整行 grid 两列，差异行底色；中缝一条竖线（行紧贴→贯通到底）；
  // 徽标跟随「有内容的主侧」（目标多出→目标侧，其余→源侧），不横跨、不打断中缝。
  return (
    <div className={`grid grid-cols-2 ${tint}`}>
      <div className="border-r border-border/60">
        <RuleSide
          rule={s}
          other={tg}
          side="src"
          posLabel={s ? `源规则 ${sPos}` : ""}
          badge={kind !== "extra" ? badge : undefined}
        />
      </div>
      <RuleSide
        rule={tg}
        other={s}
        side="tgt"
        posLabel={tg ? `目标规则 ${tPos}` : ""}
        badge={kind === "extra" ? badge : undefined}
      />
    </div>
  );
}

// 一组连续的「一致」规则：超过阈值折叠成一条可展开的提示，少则直接逐行显示。
function SameGroup({ rows }: { rows: RuleAlign[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length <= SAME_COLLAPSE_THRESHOLD) {
    return (
      <div className="divide-y divide-border/90">
        {rows.map((r, i) => (
          <RuleAlignRow key={i} row={r} />
        ))}
      </div>
    );
  }
  return (
    <div className="divide-y divide-border/90">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 bg-muted/10 px-2.5 py-1 text-[11px] text-muted-foreground/55 transition-colors hover:bg-muted/20"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? "收起" : "展开"} {rows.length} 条一致规则
      </button>
      {open &&
        rows.map((r, i) => (
          <RuleAlignRow key={i} row={r} />
        ))}
    </div>
  );
}

/**
 * 策略差异：**只覆盖 应用控制 / 端口控制 / 代理控制 三段 + 启用状态**（其余段——Web 关键字/
 * 文件类型过滤、邮件、QQ、SaaS 等——不参与对比、不在此显示）。应用控制规则用双栏 side-by-side
 * 展示（内容对齐、一致行可折叠）；忽略跨实例 rule_id；段开关为关时不比该段规则。
 */
export function PolicyDiff({ src, diffs, targetMissing }: { src: Record<string, unknown>; diffs: FieldDiff[]; targetMissing: boolean }) {
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
  // 加权序列对齐（见 alignRules）：非交叉、两侧顺序单调，供下面的双栏 side-by-side 使用
  const rows = alignRules(srcRules, tgtRules);

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

      {/* 应用控制：双栏 side-by-side（左源右目标，内容对齐、连续一致行可折叠） */}
      {showAppRules && (
        <div className="space-y-1.5">
          <SectionTitle>应用控制</SectionTitle>
          <div className="overflow-hidden rounded-md border border-border/50">
            {/* 列头：与下方中缝对齐（源栏 border-r 贯通） */}
            <div className="grid grid-cols-2 border-b border-border/50 bg-muted/20 text-[11px] font-semibold text-muted-foreground/65">
              <span className="border-r border-border/60 px-2.5 py-1">源</span>
              <span className="px-2.5 py-1">目标</span>
            </div>
            {/* 行流：紧贴排列，divide-y 分隔行、border-r 中缝一条贯通到底。
                连续同类差异行（背景同色）会把浅色分割线"吃掉"，故用较高不透明度，
                主题 --border 本身是暗灰色，不会显得刺眼。 */}
            <div className="divide-y divide-border/90">
              {(() => {
                // 连续的「一致」行归一组（可折叠），其余逐行双栏展示，保持两侧顺序
                const isSame = (r: RuleAlign) => !!r.s && !!r.tg && ruleEq(r.s, r.tg);
                const groups: { same: boolean; rows: RuleAlign[] }[] = [];
                for (const r of rows) {
                  const same = isSame(r);
                  const last = groups[groups.length - 1];
                  if (last && last.same === same) last.rows.push(r);
                  else groups.push({ same, rows: [r] });
                }
                return groups.map((g, gi) =>
                  g.same ? (
                    <SameGroup key={gi} rows={g.rows} />
                  ) : (
                    g.rows.map((r, i) => <RuleAlignRow key={`${gi}-${i}`} row={r} />)
                  )
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 端口控制：规则行级增删（源/目标文本化） */}
      {showNet && netItems.length > 0 && (
        <div className="space-y-1">
          <SectionTitle>端口控制</SectionTitle>
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
          <SectionTitle>代理控制</SectionTitle>
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

