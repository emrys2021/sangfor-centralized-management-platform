import axios from "axios";

import type {
  AppTree,
  AuditLog,
  ConnectionTestResult,
  CustomRule,
  CustomRuleAnalysis,
  CustomRuleDetail,
  Instance,
  InstanceHealth,
  InstanceInput,
  ObjectType,
  PageResult,
  PolicyApplicationUpdate,
  PolicyCreateInput,
  PolicyDetail,
  BatchCompareResult,
  BatchSyncResult,
  PolicyList,
  PolicyUsageResult,
  SearchResult,
  SyncApplyResult,
  SyncDiffResult,
  UrlGroupContent,
  UrlGroupForm,
  UrlGroups,
  WriteResult,
} from "./types";

export const http = axios.create({ baseURL: "/api", timeout: 60000 });

// 若构建时配置了 VITE_API_TOKEN，则所有请求附带 X-API-Token 头（需与后端 SANGFOR_API_TOKEN 一致）。
const API_TOKEN = import.meta.env.VITE_API_TOKEN as string | undefined;
if (API_TOKEN) http.defaults.headers.common["X-API-Token"] = API_TOKEN;

// ---- 实例 ----
export const instanceApi = {
  list: (onlyEnabled = false) =>
    http.get<Instance[]>("/instances", { params: { only_enabled: onlyEnabled } }).then((r) => r.data),
  get: (id: number) => http.get<Instance>(`/instances/${id}`).then((r) => r.data),
  create: (data: InstanceInput) => http.post<Instance>("/instances", data).then((r) => r.data),
  update: (id: number, data: Partial<InstanceInput>) =>
    http.put<Instance>(`/instances/${id}`, data).then((r) => r.data),
  remove: (id: number) => http.delete(`/instances/${id}`).then((r) => r.data),
  test: (id: number) =>
    http.post<ConnectionTestResult>(`/instances/${id}/test`).then((r) => r.data),
  // 轻量健康检查（复用会话池，不登出重连）：切换器状态指示用
  health: (id: number) =>
    http.get<InstanceHealth>(`/instances/${id}/health`).then((r) => r.data),
};

// ---- 功能 1：自定义应用 / 规则 ----
export const customRuleApi = {
  list: (instanceId: number) =>
    http.get<CustomRule[]>(`/instances/${instanceId}/customrules`).then((r) => r.data),
  get: (instanceId: number, name: string) =>
    http
      .get<CustomRuleDetail>(`/instances/${instanceId}/customrules/${encodeURIComponent(name)}`)
      .then((r) => r.data),
  analysis: (instanceId: number, refresh = false) =>
    http
      // 逐个拉取所有应用详情，耗时较长，单独放宽超时到 5 分钟。
      // refresh=true 绕过服务端缓存强制重算（「重新分析」按钮）。
      .get<CustomRuleAnalysis>(`/instances/${instanceId}/customrules/analysis`, {
        timeout: 300000,
        params: { refresh },
      })
      .then((r) => r.data),
  create: (instanceId: number, payload: Record<string, unknown>, dryRun = true) =>
    http
      .post<WriteResult>(`/instances/${instanceId}/customrules`, payload, { params: { dry_run: dryRun } })
      .then((r) => r.data),
  update: (instanceId: number, name: string, payload: Record<string, unknown>, dryRun = true) =>
    http
      .put<WriteResult>(`/instances/${instanceId}/customrules/${encodeURIComponent(name)}`, payload, {
        params: { dry_run: dryRun },
      })
      .then((r) => r.data),
  remove: (instanceId: number, name: string, dryRun = true) =>
    http
      .delete<WriteResult>(`/instances/${instanceId}/customrules/${encodeURIComponent(name)}`, {
        params: { dry_run: dryRun },
      })
      .then((r) => r.data),
};

// ---- 功能 2：自定义 URL 库 ----
export const urlApi = {
  list: (instanceId: number) =>
    http.get<UrlGroups>(`/instances/${instanceId}/urls`).then((r) => r.data),
  content: (instanceId: number, name: string) =>
    http
      .get<UrlGroupContent>(`/instances/${instanceId}/urls/${encodeURIComponent(name)}`)
      .then((r) => r.data),
  create: (instanceId: number, form: UrlGroupForm, dryRun = true) =>
    http
      .post<WriteResult>(`/instances/${instanceId}/urls`, form, { params: { dry_run: dryRun } })
      .then((r) => r.data),
  update: (instanceId: number, name: string, form: UrlGroupForm, dryRun = true) =>
    http
      .put<WriteResult>(`/instances/${instanceId}/urls/${encodeURIComponent(name)}`, form, {
        params: { dry_run: dryRun },
      })
      .then((r) => r.data),
  remove: (instanceId: number, name: string, dryRun = true) =>
    http
      .delete<WriteResult>(`/instances/${instanceId}/urls/${encodeURIComponent(name)}`, {
        params: { dry_run: dryRun },
      })
      .then((r) => r.data),
};

// ---- 功能 3：访问权限策略 ----
export const policyApi = {
  list: (instanceId: number) =>
    http.get<PolicyList>(`/instances/${instanceId}/policies`).then((r) => r.data),
  get: (instanceId: number, name: string) =>
    http
      .get<PolicyDetail>(`/instances/${instanceId}/policies/${encodeURIComponent(name)}`)
      .then((r) => r.data),
  // 「选择适用应用」应用目录树（规则编辑时挑选应用/URL，含各节点 crc）。
  appTree: (instanceId: number) =>
    http.get<AppTree>(`/instances/${instanceId}/policies/app-tree`).then((r) => r.data),
  // 策略引用校验：每条策略被多少用户引用、标出无人引用的。遍历组织树较慢，放宽超时。
  usage: (instanceId: number, refresh = false) =>
    http
      .get<PolicyUsageResult>(`/instances/${instanceId}/policies/usage`, {
        timeout: 300000,
        params: { refresh },
      })
      .then((r) => r.data),
  // 新建访问权限策略（opr=add）。dry_run 时仅返回报文预览。
  create: (instanceId: number, body: PolicyCreateInput, dryRun = true) =>
    http
      .post<WriteResult>(`/instances/${instanceId}/policies`, body, { params: { dry_run: dryRun } })
      .then((r) => r.data),
  // 上移 / 下移一条策略（调整顺序）。默认真实写入（dry_run=false）。
  move: (instanceId: number, name: string, direction: "up" | "down", dryRun = false) =>
    http
      .post<WriteResult>(`/instances/${instanceId}/policies/${encodeURIComponent(name)}/move`, null, {
        params: { direction, dry_run: dryRun },
      })
      .then((r) => r.data),
  // 批量启用 / 禁用策略。默认真实写入（dry_run=false）。
  setStatus: (instanceId: number, names: string[], enabled: boolean, dryRun = false) =>
    http
      .post<WriteResult>(
        `/instances/${instanceId}/policies/status`,
        { names, enabled },
        { params: { dry_run: dryRun } }
      )
      .then((r) => r.data),
  // 删除访问权限策略（opr=delete，已据真实抓包确认）。默认真实写入（dry_run=false）。
  remove: (instanceId: number, name: string, dryRun = false) =>
    http
      .delete<WriteResult>(`/instances/${instanceId}/policies/${encodeURIComponent(name)}`, {
        params: { dry_run: dryRun },
      })
      .then((r) => r.data),
  // 编辑策略中各规则引用的应用/URL（动作、引用增删）；dry_run 时仅返回报文预览。
  updateApplication: (
    instanceId: number,
    name: string,
    body: PolicyApplicationUpdate,
    dryRun = true
  ) =>
    http
      .put<WriteResult>(
        `/instances/${instanceId}/policies/${encodeURIComponent(name)}/application`,
        body,
        { params: { dry_run: dryRun } }
      )
      .then((r) => r.data),
};

// ---- 功能 5：同步 ----
export const syncApi = {
  // 单对象差异预览：策略要逐目标拉快照，慢设备/多目标可能超过默认 60s，与 batch/compare 一致放宽超时。
  diff: (body: {
    object_type: ObjectType;
    object_name: string;
    source_instance_id: number;
    target_instance_ids: number[];
  }) => http.post<SyncDiffResult>("/sync/diff", body, { timeout: 300000 }).then((r) => r.data),
  // 单对象同步：策略同步逐目标拉应用树、自动建引用、写入（目标间串行），可能超过默认 60s；
  // 若前端先超时而后端仍在继续写，用户会误判失败而重试造成重复写，故放宽超时。
  apply: (body: {
    object_type: ObjectType;
    object_name: string;
    source_instance_id: number;
    target_instance_ids: number[];
    push_all: boolean;
    dry_run: boolean;
    allow_degrade?: boolean;
  }) => http.post<SyncApplyResult>("/sync/apply", body, { timeout: 300000 }).then((r) => r.data),
  // 批量同步整类对象（或 object_names 给定的已选子集）；mirror=true 时删除目标多余对象
  // （与子集互斥，仅支持「全部对象」）。建索引/逐条写较慢，放宽超时。
  batch: (body: {
    object_type: ObjectType;
    source_instance_id: number;
    target_instance_ids: number[];
    push_all: boolean;
    mirror: boolean;
    dry_run: boolean;
    allow_degrade?: boolean;
    object_names?: string[];
  }) => http.post<BatchSyncResult>("/sync/batch", body, { timeout: 300000 }).then((r) => r.data),
  // 只读对比：names_only=true 只比名单（仅源/仅目标/两边都有，秒级）；否则比内容
  // （仅源/仅目标/一致/不一致，逐对象拉快照较慢，放宽超时）。object_names 给定时只对比
  // 这个已选子集，跳过全量索引缓存、按名字直拉，选得越少越快。
  compare: (body: {
    object_type: ObjectType;
    source_instance_id: number;
    target_instance_ids: number[];
    names_only?: boolean;
    force?: boolean;
    object_names?: string[];
  }) => http.post<BatchCompareResult>("/sync/compare", body, { timeout: 300000 }).then((r) => r.data),
};

// ---- 全局搜索 ----
export const searchApi = {
  // 按域名 / IP 反查引用它的自定义应用与 URL 库。首次/refresh 建索引较慢，放宽超时。
  query: (instanceId: number, q: string, refresh = false) =>
    http
      .get<SearchResult>(`/instances/${instanceId}/search`, {
        timeout: 300000,
        params: { q, refresh },
      })
      .then((r) => r.data),
};

// ---- 审计 ----
export const auditApi = {
  list: (params: {
    instance_id?: number;
    object_type?: string;
    action?: string;
    actor?: string;
    search?: string;
    page?: number;
    page_size?: number;
  }) => http.get<PageResult<AuditLog>>("/audit-logs", { params }).then((r) => r.data),
};
