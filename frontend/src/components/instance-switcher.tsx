import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { useEffect, useState } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { instanceApi } from "@/lib/api";
import type { Instance } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";

/** 状态圆点：ok 绿 / error 红 / disabled 灰 / unconfigured 黄 / 加载中 脉冲。 */
function HealthDot({ instance, enabled }: { instance: Instance; enabled: boolean }) {
  // 已禁用 / 未配置凭据无需联网探测，直接据本地信息着色
  const local: "disabled" | "unconfigured" | null = !instance.enabled
    ? "disabled"
    : !instance.has_web_password
      ? "unconfigured"
      : null;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["instance-health", instance.id],
    queryFn: () => instanceApi.health(instance.id),
    enabled: enabled && local == null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const status = local ?? (isError ? "error" : data?.status);
  const title =
    status === "ok"
      ? "连接正常"
      : status === "error"
        ? `连接失败${data?.message ? `：${data.message}` : ""}`
        : status === "disabled"
          ? "已禁用"
          : status === "unconfigured"
            ? "未配置 Web 密码"
            : "检测中…";

  const color =
    status === "ok"
      ? "bg-emerald-500"
      : status === "error"
        ? "bg-red-500"
        : status === "unconfigured"
          ? "bg-amber-500"
          : status === "disabled"
            ? "bg-muted-foreground/40"
            : "bg-muted-foreground/40";

  return (
    <span
      title={title}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        color,
        (isLoading || (!status && local == null)) && "animate-pulse"
      )}
    />
  );
}

export function InstanceSwitcher() {
  const { currentInstanceId, setCurrentInstanceId } = useAppStore();
  const [open, setOpen] = useState(false);
  const { data: instances = [] } = useQuery({
    queryKey: ["instances"],
    queryFn: () => instanceApi.list(),
  });

  // 默认选中第一个启用实例
  useEffect(() => {
    if (currentInstanceId == null && instances.length > 0) {
      const firstEnabled = instances.find((i) => i.enabled) ?? instances[0];
      setCurrentInstanceId(firstEnabled.id);
    }
  }, [instances, currentInstanceId, setCurrentInstanceId]);

  const current = instances.find((i) => i.id === currentInstanceId);

  return (
    <div className="flex items-center gap-2">
      <Server className="h-4 w-4 text-muted-foreground" />
      <Select
        value={currentInstanceId != null ? String(currentInstanceId) : undefined}
        onValueChange={(v) => setCurrentInstanceId(Number(v))}
        open={open}
        onOpenChange={setOpen}
      >
        <SelectTrigger className="h-8 w-[220px]">
          {/* 用 div 包裹（非 span），避免 SelectTrigger 的 [&>span]:line-clamp-1 破坏 flex 布局；
              直接渲染当前实例名而非 SelectValue，名称用 truncate 处理溢出 */}
          <div className="flex min-w-0 items-center gap-2">
            {current ? (
              <>
                {/* 当前实例状态：始终探测，便于提前发现正在使用的实例连接异常 */}
                <HealthDot instance={current} enabled />
                <span className="truncate">{current.name}</span>
              </>
            ) : (
              <span className="text-muted-foreground">选择实例</span>
            )}
          </div>
        </SelectTrigger>
        <SelectContent>
          {instances.map((inst) => (
            <SelectItem key={inst.id} value={String(inst.id)} disabled={!inst.enabled}>
              <span className="flex items-center gap-2">
                {/* 下拉打开时才探测各实例，避免无谓的登录请求 */}
                <HealthDot instance={inst} enabled={open} />
                {inst.name}
                {!inst.enabled && "（已禁用）"}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
