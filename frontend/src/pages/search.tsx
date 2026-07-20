import { useQuery } from "@tanstack/react-query";
import { Boxes, Globe, RefreshCw, Search as SearchIcon, ShieldCheck, Tag } from "lucide-react";
import { useEffect, useState } from "react";

import { CenteredSpinner, EmptyState, PageHeader, Spinner } from "@/components/common";
import { NoInstance } from "@/components/no-instance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCurrentInstance } from "@/hooks/use-current-instance";
import { searchApi } from "@/lib/api";
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
    <Card className="p-4 space-y-3">
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
    </Card>
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
    <Card className="p-4 space-y-3">
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
    </Card>
  );
}

export function SearchPage() {
  const { instanceId } = useCurrentInstance();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [rebuilding, setRebuilding] = useState(false);

  // 输入防抖：停止输入 350ms 后再查（命中索引缓存时很快；首建会有 loading）
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 350);
    return () => clearTimeout(t);
  }, [input]);

  const result = useQuery<SearchResult>({
    queryKey: ["search", instanceId, query],
    queryFn: () => searchApi.query(instanceId!, query),
    enabled: instanceId != null && query.length > 0,
    placeholderData: (prev) => prev,
  });

  async function rebuildIndex() {
    if (instanceId == null) return;
    setRebuilding(true);
    try {
      await searchApi.query(instanceId, query || "_", true); // refresh=true 强制重建索引
      await result.refetch();
    } finally {
      setRebuilding(false);
    }
  }

  if (instanceId == null) return <NoInstance />;

  const data = result.data;
  const building = result.isFetching || rebuilding;

  return (
    <div className="space-y-5">
      <PageHeader
        title="全局搜索"
        description="输入域名 / IP 反查哪些自定义应用、URL 库配置了它（智能识别通配符、子域、网段）；也可直接输入名称关键字，查同名的自定义应用、URL 库与访问权限策略。"
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
          <Button variant="outline" onClick={rebuildIndex} disabled={building} title="重新逐条拉取设备、重建搜索索引">
            {building ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            重建索引
          </Button>
        </div>
        {data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              已索引 <span className="text-foreground/80">{data.indexed_apps}</span> 个应用、
              <span className="text-foreground/80">{data.indexed_url_groups}</span> 个 URL 库、
              <span className="text-foreground/80">{data.indexed_policies}</span> 条策略
              {data.cached && <span className="text-muted-foreground/70">（缓存{formatCacheAge(data.cache_age_seconds)}）</span>}
            </span>
            {query && (
              // 只描述「按内容」那一路的判定类型；名称匹配是子串包含，与此无关
              <span>
                内容匹配按：<Badge variant="outline">{data.query_type === "ip" ? "IP / 网段" : "域名"}</Badge>
              </span>
            )}
            {data.errors.length > 0 && (
              <span className="text-amber-400/80" title={data.errors.join("\n")}>
                {data.errors.length} 个对象读取失败（已跳过）
              </span>
            )}
          </div>
        )}
      </Card>

      {!query ? (
        <EmptyState title="输入域名 / IP 或名称关键字开始搜索" hint="首次搜索会逐条拉取设备建立索引，稍候片刻；之后命中缓存秒回。" />
      ) : building && !data ? (
        <Card>
          <CenteredSpinner label="正在建立搜索索引（逐条读取应用与 URL 库）…" />
        </Card>
      ) : data && data.total_hits === 0 ? (
        <EmptyState
          title={`没有匹配「${query}」的对象`}
          hint="按内容搜请输入域名 / IP；按名称搜请输入名字里的关键字。也可点「重建索引」确保索引是最新的。"
        />
      ) : (
        <div className="space-y-4">
          {/* 名称匹配放前面：用户按名字搜时最想先看到它 */}
          <NameHitGroup hits={data?.name_hits ?? []} />
          <HitGroup title="自定义应用" icon={Boxes} hits={data?.apps ?? []} accent="text-violet-400" />
          <HitGroup title="自定义 URL 库" icon={Globe} hits={data?.custom_urls ?? []} accent="text-cyan-400" />
          <HitGroup title="内置 URL 库（含额外添加的条目）" icon={Globe} hits={data?.builtin_urls ?? []} accent="text-teal-400" />
        </div>
      )}
    </div>
  );
}
