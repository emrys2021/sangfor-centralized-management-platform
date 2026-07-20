import { useQueries, useQuery } from "@tanstack/react-query";
import { Boxes, Globe, RefreshCw, Search as SearchIcon, Server, ShieldCheck, Tag } from "lucide-react";
import { useEffect, useState } from "react";

import { CenteredSpinner, EmptyState, PageHeader, Spinner } from "@/components/common";
import { NoInstance } from "@/components/no-instance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCurrentInstance } from "@/hooks/use-current-instance";
import { instanceApi, searchApi } from "@/lib/api";
import type { SearchHit, SearchNameHit, SearchResult } from "@/lib/types";

/** 缓存已存在时长 → 文案。 */
function formatCacheAge(seconds?: number | null): string {
  if (seconds == null) return "";
  if (seconds < 5) return " · 刚刚";
  if (seconds < 60) return ` · ${seconds}秒前`;
  return ` · ${Math.floor(seconds / 60)}分钟前`;
}

// 高亮命中条目里与查询相关的片段（简单包含高亮，纯展示）
function HitChip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary/90">
      {text}
    </span>
  );
}

/** 名称命中区：按对象类型分组列出「名字里含查询词」的自定义应用 / URL 库 / 访问权限策略。 */
function NameHitGroup({ hits }: { hits: SearchNameHit[] }) {
  if (hits.length === 0) return null;
  const groups: { title: string; icon: typeof Boxes; accent: string;
    filter: (h: SearchNameHit) => boolean }[] = [
    { title: "自定义应用", icon: Boxes, accent: "text-violet-400",
      filter: (h) => h.kind === "customrule" },
    { title: "自定义 URL 库", icon: Globe, accent: "text-cyan-400",
      filter: (h) => h.kind === "url" && !h.builtin },
    { title: "内置 URL 库", icon: Globe, accent: "text-teal-400",
      filter: (h) => h.kind === "url" && h.builtin },
    { title: "访问权限策略", icon: ShieldCheck, accent: "text-amber-400",
      filter: (h) => h.kind === "policy" },
  ];
  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Tag className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">名称匹配</span>
        <Badge variant="secondary">{hits.length}</Badge>
        <span className="text-xs text-muted-foreground">对象名称里含查询词</span>
      </div>
      <div className="space-y-3">
        {groups.map((g, i) => {
          const list = hits.filter(g.filter);
          if (list.length === 0) return null;
          return (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <g.icon className={`h-3.5 w-3.5 ${g.accent}`} />
                {g.title}
                <span className="text-muted-foreground/50">{list.length}</span>
              </div>
              <div className="space-y-1 pl-5">
                {list.map((h) => (
                  <div key={`${h.kind}-${h.name}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="break-all font-medium">{h.name}</span>
                    {h.depict && <span className="text-xs text-muted-foreground">— {h.depict}</span>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HitGroup({
  title,
  icon: Icon,
  hits,
  accent,
}: {
  title: string;
  icon: typeof Boxes;
  hits: SearchHit[];
  accent: string;
}) {
  if (hits.length === 0) return null;
  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${accent}`} />
        <span className="text-sm font-semibold">{title}</span>
        <Badge variant="secondary">{hits.length}</Badge>
      </div>
      <div className="space-y-2">
        {hits.map((h) => (
          <div key={h.name} className="grid grid-cols-[200px_1fr] items-start gap-3 rounded-md border p-2.5">
            <span className="break-all text-sm font-medium" title={h.name}>
              {h.name}
            </span>
            <div className="flex flex-wrap gap-1">
              {h.matches.map((m) => (
                <HitChip key={m} text={m} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 单个实例的搜索结果卡片。
 *
 * 多实例搜索时**每个实例一个独立请求 / 一张卡片**：谁先返回先展示，某台设备慢或读取失败
 * 都不影响其余实例的结果（索引也按实例各自 TTL 缓存）。
 */
function InstanceResult({
  name,
  query,
  data,
  loading,
  error,
}: {
  name: string;
  query: string;
  data?: SearchResult;
  loading: boolean;
  error?: unknown;
}) {
  const hits = data?.total_hits ?? 0;
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{name}</span>
        {loading ? (
          <Badge variant="outline">
            <Spinner className="mr-1" />
            检索中
          </Badge>
        ) : error ? (
          <Badge variant="destructive">读取失败</Badge>
        ) : hits > 0 ? (
          <Badge variant="secondary">{hits} 处命中</Badge>
        ) : (
          <Badge variant="outline">无匹配</Badge>
        )}
        {data && (
          <span className="text-xs text-muted-foreground">
            已索引 {data.indexed_apps} 应用 / {data.indexed_url_groups} URL 库 / {data.indexed_policies} 策略
            {data.cached && <span className="text-muted-foreground/70">（缓存{formatCacheAge(data.cache_age_seconds)}）</span>}
          </span>
        )}
        {data && data.errors.length > 0 && (
          <span className="text-xs text-amber-400/80" title={data.errors.join("\n")}>
            {data.errors.length} 个对象读取失败（已跳过）
          </span>
        )}
      </div>

      {loading && !data ? (
        <CenteredSpinner label="正在建立搜索索引（逐条读取应用与 URL 库）…" />
      ) : error ? (
        <p className="text-xs text-destructive">
          {(error as any)?.response?.data?.detail ?? String((error as any)?.message ?? error)}
        </p>
      ) : hits === 0 ? (
        <p className="text-xs text-muted-foreground">没有匹配「{query}」的对象。</p>
      ) : (
        <div className="space-y-3">
          {/* 名称匹配放前面：用户按名字搜时最想先看到它 */}
          <NameHitGroup hits={data?.name_hits ?? []} />
          <HitGroup title="自定义应用" icon={Boxes} hits={data?.apps ?? []} accent="text-violet-400" />
          <HitGroup title="自定义 URL 库" icon={Globe} hits={data?.custom_urls ?? []} accent="text-cyan-400" />
          <HitGroup title="内置 URL 库（含额外添加的条目）" icon={Globe} hits={data?.builtin_urls ?? []} accent="text-teal-400" />
        </div>
      )}
    </Card>
  );
}

export function SearchPage() {
  const { instanceId } = useCurrentInstance();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  // 搜索范围：要搜哪些实例。默认=当前实例；切换顶部实例时重置回它（可再点「全部实例」扩大）。
  const [scope, setScope] = useState<number[]>([]);

  const { data: instances = [] } = useQuery({ queryKey: ["instances"], queryFn: () => instanceApi.list() });
  const enabled = instances.filter((i) => i.enabled);

  useEffect(() => {
    if (instanceId != null) setScope([instanceId]);
  }, [instanceId]);

  // 输入防抖：停止输入 350ms 后再查（命中索引缓存时很快；首建会有 loading）
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 350);
    return () => clearTimeout(t);
  }, [input]);

  // 每个实例一个独立查询：并行发出、各自返回，慢设备不阻塞其余（见 InstanceResult）
  const results = useQueries({
    queries: scope.map((id) => ({
      queryKey: ["search", id, query],
      queryFn: () => searchApi.query(id, query),
      enabled: query.length > 0,
      placeholderData: (prev: SearchResult | undefined) => prev,
    })),
  });

  async function rebuildIndex() {
    if (scope.length === 0) return;
    setRebuilding(true);
    try {
      // 各实例并行重建，单个失败不影响其余
      await Promise.allSettled(scope.map((id) => searchApi.query(id, query || "_", true)));
      await Promise.allSettled(results.map((r) => r.refetch()));
    } finally {
      setRebuilding(false);
    }
  }

  function toggleInstance(id: number) {
    setScope((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  if (instanceId == null) return <NoInstance />;

  const building = rebuilding || results.some((r) => r.isFetching);
  const anyData = results.some((r) => r.data);
  const totalHits = results.reduce((n, r) => n + (r.data?.total_hits ?? 0), 0);
  const multi = scope.length > 1;

  return (
    <div className="space-y-5">
      <PageHeader
        title="全局搜索"
        description="输入域名 / IP 反查哪些自定义应用、URL 库配置了它（智能识别通配符、子域、网段）；也可直接输入名称关键字，查同名的自定义应用、URL 库与访问权限策略。可一次搜多个实例。"
      />

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-9"
              placeholder="域名/IP 如 www.deepin.org、10.20.1.0/24；名称如 钉钉、白名单"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            onClick={rebuildIndex}
            disabled={building || scope.length === 0}
            title="重新逐条拉取设备、重建所选实例的搜索索引"
          >
            {building ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            重建索引
          </Button>
        </div>

        {/* 搜索范围：默认当前实例；可多选或一键全部。范围越大首次建索引越慢（每台都要逐条拉取）。 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">搜索范围</span>
          {enabled.map((i) => (
            <Badge
              key={i.id}
              variant={scope.includes(i.id) ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => toggleInstance(i.id)}
            >
              {i.name}
            </Badge>
          ))}
          <button
            type="button"
            className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setScope(enabled.map((i) => i.id))}
          >
            全部实例
          </button>
          <button
            type="button"
            className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setScope(instanceId != null ? [instanceId] : [])}
          >
            仅当前
          </button>
          {multi && (
            <span className="text-[11px] text-muted-foreground/60">
              多实例并行检索，各自独立返回；未建索引的实例首次较慢。
            </span>
          )}
        </div>
      </Card>

      {scope.length === 0 ? (
        <EmptyState title="请先选择搜索范围" hint="至少勾选一个实例。" />
      ) : !query ? (
        <EmptyState
          title="输入域名 / IP 或名称关键字开始搜索"
          hint="首次搜索会逐条拉取设备建立索引，稍候片刻；之后命中缓存秒回。"
        />
      ) : !anyData && building ? (
        <Card>
          <CenteredSpinner label="正在建立搜索索引（逐条读取应用与 URL 库）…" />
        </Card>
      ) : (
        <div className="space-y-4">
          {multi && anyData && !building && totalHits === 0 && (
            <EmptyState
              title={`所选 ${scope.length} 个实例都没有匹配「${query}」的对象`}
              hint="按内容搜请输入域名 / IP；按名称搜请输入名字里的关键字。也可点「重建索引」确保索引是最新的。"
            />
          )}
          {scope.map((id, idx) => {
            const r = results[idx];
            return (
              <InstanceResult
                key={id}
                name={instances.find((i) => i.id === id)?.name ?? `#${id}`}
                query={query}
                data={r?.data}
                loading={!!r?.isFetching}
                error={r?.error ?? undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
