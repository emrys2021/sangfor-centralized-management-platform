import { useQuery } from "@tanstack/react-query";

import { instanceApi } from "@/lib/api";
import { useAppStore } from "@/stores/app";

/** 返回当前选中实例的 id 与对象；未选择时 id 为 null。 */
export function useCurrentInstance() {
  const currentInstanceId = useAppStore((s) => s.currentInstanceId);
  const { data: instances = [] } = useQuery({
    queryKey: ["instances"],
    queryFn: () => instanceApi.list(),
  });
  const instance = instances.find((i) => i.id === currentInstanceId) ?? null;
  return { instanceId: currentInstanceId, instance };
}
