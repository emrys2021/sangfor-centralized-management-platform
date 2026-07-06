// 访问权限策略「规则级对比」的纯逻辑：规范化解析、加权序列对齐（Needleman-Wunsch 式 DP）、
// 差异计数与引用集合 diff。不含 JSX，供双栏 diff 组件、快照视图与结果卡片复用。
import type { FieldDiff } from "@/lib/types";

// ── 策略规则级对比 ────────────────────────────────────────────────────────────

export type AppRef = { path: string; custom: boolean };
export type PolicyRule = { name: string; action: string; apps: AppRef[] };
export type NetRule = { dip: string; service: string; action: unknown; time: string };

export function asRules(val: unknown): PolicyRule[] {
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

export function asNetRules(val: unknown): NetRule[] {
  if (!Array.isArray(val)) return [];
  return val.map((r: any) => ({
    dip: String(r?.dip ?? ""),
    service: String(r?.service ?? ""),
    action: r?.action,
    time: String(r?.time ?? ""),
  }));
}

// 动作：应用规则 allow/deny，端口规则 1/0 或布尔 → 放行 / 拒绝
export function actionText(a: unknown): string {
  if (a === "allow" || a === true || a === 1) return "放行";
  if (a === "deny" || a === false || a === 0) return "拒绝";
  return String(a ?? "未知");
}
// 「访问网站/库名/能力」这类应用路径本质是 URL 库引用（可能是自定义库也可能是内置库，
// 库名本身无法可靠判断内置/自定义，故不再区分），展示时从「应用」里拆出来单独归入「URL库」，
// 显示完整路径；不用后端 urls 字段（裁剪成裸库名、且会和这里的完整路径重复显示同一条引用）。
export function isUrlRef(path: string): boolean {
  return path.startsWith("访问网站/");
}
export function netRuleText(r: NetRule): string {
  const t = r.time && r.time !== "全天" ? ` · ${r.time}` : "";
  return `${r.dip} · ${r.service} · ${actionText(r.action)}${t}`;
}

// 取某字段的目标值：diffs 里有该字段=不同、取 target；没有=两边相同、回退用源值。
export function targetVal(diffs: FieldDiff[], field: string, fallback: unknown): unknown {
  const d = diffs.find((x) => x.field === field);
  return d ? d.target : fallback;
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
// 规则一致 = 动作相同 且 引用应用/URL 相同（URL 库引用即「访问网站/…」路径，含在 apps 里，
// 已是完整路径，不需要再单独比对后端裁剪成裸库名的 urls 字段——与展示层保持一致）。
export function ruleEq(s: PolicyRule, t: PolicyRule): boolean {
  return s.action === t.action && sameKeys(s.apps.map((a) => a.path), t.apps.map((a) => a.path));
}

// 两条规则的引用集合相似度（Jaccard：共同引用数 / 并集），用于把「其实是同一条规则的改动版」
// 正确配对，而非按顺序硬配。都无引用时按动作定；动作相同加极小权重，仅用于相近时打破平局。
function ruleSim(a: PolicyRule, b: PolicyRule): number {
  const sa = new Set(a.apps.map((x) => x.path));
  const sb = new Set(b.apps.map((x) => x.path));
  if (sa.size === 0 && sb.size === 0) return a.action === b.action ? 1 : 0.5;
  let inter = 0;
  for (const p of sa) if (sb.has(p)) inter++;
  const union = sa.size + sb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  return jaccard + (a.action === b.action ? 0.001 : 0);
}

// 对齐后的一行：一致/变更两侧都有(s+tg)、纯新增只有 s、目标多出只有 tg；带原始位置(1-based)。
export type RuleAlign = { s?: PolicyRule; tg?: PolicyRule; sPos?: number; tPos?: number };

// 用「加权序列对齐」（Needleman-Wunsch 式 DP）对齐两组规则：以引用相似度为匹配得分，在**保持两侧
// 顺序**的前提下最大化对齐总分——完全相同=一致、相似=变更（高亮增删的引用/动作）、无共同引用=纯
// 新增/目标多出。对齐结果**非交叉、两侧顺序单调**，可直接用于双栏（side-by-side）空行占位布局；
// 既解决「多插一条后续全错位」，也不会把改动版规则错配到不相干的一条。效果类似 BeyondCompare。
export function alignRules(src: PolicyRule[], tgt: PolicyRule[]): RuleAlign[] {
  const n = src.length;
  const m = tgt.length;
  // dp[i][j] = 源前 i 条、目标前 j 条对齐的最大总相似度；choice 记回溯方向：0=配对 / 1=源独有 / 2=目标独有
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const choice: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) choice[i][0] = 1;
  for (let j = 1; j <= m; j++) choice[0][j] = 2;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const sim = ruleSim(src[i - 1], tgt[j - 1]);
      // 只有有共同引用（sim>0）才允许配对；否则宁可各自独有（-Infinity 禁止配对）
      const matchScore = sim > 0 ? dp[i - 1][j - 1] + sim : -Infinity;
      const up = dp[i - 1][j]; // 源第 i 条独有
      const left = dp[i][j - 1]; // 目标第 j 条独有
      if (matchScore !== -Infinity && matchScore >= up && matchScore >= left) {
        dp[i][j] = matchScore;
        choice[i][j] = 0;
      } else if (up >= left) {
        dp[i][j] = up;
        choice[i][j] = 1;
      } else {
        dp[i][j] = left;
        choice[i][j] = 2;
      }
    }
  // 回溯（从 n,m 到 0,0），再反转成从上到下的顺序序列（两侧序号各自单调递增，可直接用于双栏）
  const rev: RuleAlign[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const c = i > 0 && j > 0 ? choice[i][j] : i > 0 ? 1 : 2;
    if (c === 0) {
      rev.push({ s: src[i - 1], tg: tgt[j - 1], sPos: i, tPos: j });
      i--;
      j--;
    } else if (c === 1) {
      rev.push({ s: src[i - 1], sPos: i });
      i--;
    } else {
      rev.push({ tg: tgt[j - 1], tPos: j });
      j--;
    }
  }
  rev.reverse();
  return rev;
}

// 统计策略实际差异处数：规则级（新增/变更/目标多出，含动作差异）+ 段/策略级标量（启用、各段开关、
// 端口规则、代理配置）。用于「差异 N 处」徽标。
export function countPolicyDiffs(src: Record<string, unknown>, diffs: FieldDiff[], targetMissing: boolean): number {
  if (targetMissing) return asRules(src.rules).length + 1; // 目标整体缺失：整条策略将新增
  const srcRules = asRules(src.rules);
  const tgtRules = asRules(targetVal(diffs, "rules", src.rules));
  let n = 0;
  // 与展示层一致：LCS 对齐后，一致的行不计，新增/目标多出/变更各计一处
  for (const row of alignRules(srcRules, tgtRules)) {
    if (!row.s || !row.tg || !ruleEq(row.s, row.tg)) n++;
  }
  for (const f of ["enable", "application_include", "network_include", "network_rules", "proxy_include", "proxy"]) {
    if (diffs.some((d) => d.field === f)) n++;
  }
  return n;
}

export type RefState = "added" | "removed" | "same";

// 把某一类引用的源/目标列表合并为带状态的条目：源有目标无=added、目标有源无=removed、共有=same
export function diffCategory(src: string[], tgt: string[]): { value: string; state: RefState }[] {
  const srcSet = new Set(src);
  const tgtSet = new Set(tgt);
  const items: { value: string; state: RefState }[] = [];
  src.forEach((v) => items.push({ value: v, state: tgtSet.has(v) ? "same" : "added" }));
  tgt.forEach((v) => {
    if (!srcSet.has(v)) items.push({ value: v, state: "removed" });
  });
  return items;
}
