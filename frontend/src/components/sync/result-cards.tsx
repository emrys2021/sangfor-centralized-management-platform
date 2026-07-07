// 右侧结果区的三种卡片：单对象同步结果（ApplyResultCard，含重建报文+缺失引用告警）、
// 批量同步逐目标结果（BatchResultCard）、全量对比分类结果（CompareResultCard，可勾选后暂存应用）。
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { JsonView } from "@/components/common";
import { ObjectDiffBody } from "@/components/sync/object-diff";
import { SnapshotView } from "@/components/sync/snapshot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  BatchTargetResult,
  CompareItem,
  CompareStatus,
  CompareTargetResult,
  ObjectType,
  TargetApplyResult,
} from "@/lib/types";

// ── 同步结果卡片（含重建报文 + 缺失引用告警） ───────────────────────────────────

export function ApplyResultCard({ r }: { r: TargetApplyResult }) {
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

export function BatchResultCard({ t, objectType }: { t: BatchTargetResult; objectType: ObjectType }) {
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

// 可勾选并暂存后同步/删除的对比结果卡片：
// - 推送类（仅源有=新增、不一致=覆盖、一致=无意义覆盖、仅名单的两边都有=覆盖）勾选后走「同步选中」；
// - 删除类（仅目标有=源没有、目标多出）勾选后走「删除选中」（破坏性，与镜像同一套安全闸）。
// error 行不可选（无法可靠判定/操作）。
const PUSH_STATUSES = new Set<CompareStatus>(["source_only", "different", "identical", "both"]);
const isSelectable = (s: CompareStatus) => PUSH_STATUSES.has(s) || s === "target_only";

// 单个对象行：可选（勾选框）+ 可展开明细（不一致→字段/规则 diff；仅源/仅目标→只读快照）。
function CompareItemRow({
  item,
  objectType,
  checked,
  onToggle,
}: {
  item: CompareItem;
  objectType: ObjectType;
  checked: boolean;
  onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable =
    (item.status === "different" && !!item.source_snapshot) ||
    (item.status === "source_only" && !!item.source_snapshot) ||
    (item.status === "target_only" && !!item.target_snapshot);
  const selectable = isSelectable(item.status) && !!onToggle;
  return (
    <div className="rounded border border-border/40">
      <div className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs">
        {selectable ? (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className={`h-3.5 w-3.5 shrink-0 ${item.status === "target_only" ? "accent-red-500" : "accent-primary"}`}
            title={item.status === "target_only" ? "勾选后可删除（源上没有）" : "勾选后可同步到目标"}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <button
          className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-foreground disabled:cursor-default"
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
      </div>
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

// 一个分类分组（如「内容不一致」）：可折叠；可选组带「全选」勾选框（半选态用 indeterminate）。
function CompareGroup({
  status,
  items,
  objectType,
  defaultOpen,
  selectedNames,
  onToggleItem,
  onToggleGroup,
}: {
  status: CompareStatus;
  items: CompareItem[];
  objectType: ObjectType;
  defaultOpen: boolean;
  selectedNames?: Set<string>;
  onToggleItem?: (name: string) => void;
  onToggleGroup?: (names: string[], select: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const meta = COMPARE_META[status];
  const selectable = isSelectable(status) && !!onToggleGroup;
  const selCount = selectedNames ? items.filter((i) => selectedNames.has(i.name)).length : 0;
  const allSel = selCount === items.length;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {selectable ? (
          <input
            type="checkbox"
            checked={allSel}
            ref={(el) => el && (el.indeterminate = selCount > 0 && !allSel)}
            onChange={() => onToggleGroup!(items.map((i) => i.name), !allSel)}
            className={`h-3.5 w-3.5 shrink-0 ${status === "target_only" ? "accent-red-500" : "accent-primary"}`}
            title={status === "target_only" ? "全选本组以删除" : "全选本组以同步"}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <button
          className="flex items-center gap-1 text-xs font-medium hover:opacity-80 transition-opacity"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className={meta.cls}>{meta.label}</span>
          <span className="text-muted-foreground/50">{items.length}</span>
          {selectable && selCount > 0 && <span className="text-muted-foreground/40">· 选中 {selCount}</span>}
        </button>
      </div>
      {open && (
        <div className="space-y-1 pl-1">
          {items.map((it) => (
            <CompareItemRow
              key={it.name}
              item={it}
              objectType={objectType}
              checked={!!selectedNames?.has(it.name)}
              onToggle={onToggleItem ? () => onToggleItem(it.name) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CompareResultCard({
  t,
  objectType,
  namesOnly,
  onSync,
  onDelete,
  busy = false,
}: {
  t: CompareTargetResult;
  objectType: ObjectType;
  namesOnly: boolean;
  // 勾选后「同步选中/删除选中」的回调；不传则卡片为纯只读（无勾选框）。
  onSync?: (instanceId: number, instanceName: string, names: string[]) => void;
  onDelete?: (instanceId: number, instanceName: string, names: string[]) => void;
  busy?: boolean;
}) {
  // 仅名单：源/目标/都有三桶；内容：不一致/仅源/仅目标/一致四桶。
  const groups: CompareStatus[] = namesOnly
    ? ["source_only", "target_only", "error", "both"]
    : ["different", "source_only", "target_only", "error", "identical"];
  const byStatus = (s: CompareStatus) => t.items.filter((i) => i.status === s);
  const hasNameDiff = t.source_only + t.target_only > 0;
  const selectable = !!onSync || !!onDelete;

  // 勾选态。默认预选「仅源有（将新增）+ 不一致（将覆盖）」，其余（一致/仅目标有/两边都有）留空。
  // items 变化（新一次对比）时按签名重置——避免旧选中残留到新数据。
  const sig = useMemo(() => t.items.map((i) => `${i.name}:${i.status}`).join("|"), [t.items]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const init = new Set<string>();
    for (const it of t.items) if (it.status === "source_only" || it.status === "different") init.add(it.name);
    setSelected(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const toggleItem = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  const toggleGroup = (names: string[], select: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      names.forEach((x) => (select ? n.add(x) : n.delete(x)));
      return n;
    });

  const pushNames = t.items.filter((i) => selected.has(i.name) && PUSH_STATUSES.has(i.status)).map((i) => i.name);
  const delNames = t.items.filter((i) => selected.has(i.name) && i.status === "target_only").map((i) => i.name);

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
                selectedNames={selectable ? selected : undefined}
                onToggleItem={selectable ? toggleItem : undefined}
                onToggleGroup={selectable ? toggleGroup : undefined}
              />
            ))}
          </div>

          {/* 暂存应用条：勾选后「同步选中」（推送=新增/覆盖）/「删除选中」（破坏性） */}
          {selectable && (pushNames.length > 0 || delNames.length > 0) && (
            <div className="sticky bottom-0 -mx-3 -mb-3 flex flex-wrap items-center gap-2 border-t bg-card/95 px-3 py-2 backdrop-blur">
              {onSync && pushNames.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => onSync(t.instance_id, t.instance_name, pushNames)}>
                  <ArrowRight className="h-3.5 w-3.5" /> 同步选中 {pushNames.length} 项
                </Button>
              )}
              {onDelete && delNames.length > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => onDelete(t.instance_id, t.instance_name, delNames)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除选中 {delNames.length} 项
                </Button>
              )}
              <span className="text-[11px] text-muted-foreground/60">→ {t.instance_name}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

