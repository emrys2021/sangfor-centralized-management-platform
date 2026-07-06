// 对象内容差异主体（策略走规则级 PolicyDiff、其余对象走字段级主体/次要/相同分层）
// 与单目标对照卡片（TargetCard，单对象对比的逐目标结果）。
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import {
  FIELD_LABELS,
  HIGH_PRIORITY,
  LIST_FIELDS,
  ListDiff,
  fmtScalar,
  parseEntries,
} from "@/components/sync/field-diff";
import { PolicyDiff } from "@/components/sync/policy-diff";
import { countPolicyDiffs } from "@/components/sync/policy-rules";
import { Badge } from "@/components/ui/badge";
import type { FieldDiff, ObjectType, SyncDiffResult } from "@/lib/types";

// ── 对象内容差异主体（策略规则级 / 其他字段级），TargetCard 与全量对比复用 ─────────────

export function ObjectDiffBody({
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

export function TargetCard({
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

