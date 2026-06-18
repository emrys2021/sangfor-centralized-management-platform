export interface Instance {
  id: number;
  name: string;
  description: string;
  protocol: string;
  host: string;
  web_port: number;
  api_port: number;
  web_user: string;
  enabled: boolean;
  has_web_password: boolean;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
}

export interface InstanceInput {
  name: string;
  description?: string;
  protocol?: string;
  host: string;
  web_port?: number;
  api_port?: number;
  web_user?: string;
  web_password?: string;
  api_key?: string;
  enabled?: boolean;
}

export interface ConnectionTestResult {
  web_ok: boolean;
  api_ok: boolean;
  detail: Record<string, unknown>;
  message: string;
}

/** 实例连接健康状态（切换器状态指示）。 */
export interface InstanceHealth {
  instance_id: number;
  /** ok 可连接 / error 连接失败 / disabled 已禁用 / unconfigured 未配置凭据 */
  status: "ok" | "error" | "disabled" | "unconfigured";
  message: string;
}

export interface CustomRule {
  rulename: string;
  appname: string;
  depict: string;
  apptype: string;
  status: boolean;
  creator?: string;
  [key: string]: unknown;
}

export interface CustomRuleForm {
  status: boolean;
  rulename: string;
  depict: string;
  apptype: string;
  appname: string;
  direction: "both" | "lan2wan" | "wan2lan";
  protocol: string;
  protocol_num: string;
  port_mode: "all" | "specified";
  port_range: string;
  ip_mode: "all" | "specified";
  ip_range: string;
  domain: string;
}

export interface CustomRuleDetail {
  summary: CustomRule;
  detail: Record<string, unknown>;
  form: CustomRuleForm;
  ip_range: string;
  ip_list: string[];
  port_range: string;
  port_list: string[];
}

export interface UrlNode {
  id: string | number;
  name: string;
  depict: string;
  inside: unknown;
  leaf: unknown;
  parent_id: string | number | null;
  parent_name: string;
  level: number;
  full_path: string;
  children?: UrlNode[];
}

export interface UrlGroups {
  tree: UrlNode[];
  flat: UrlNode[];
}

/** 某 URL 库的可查看 / 可编辑详情。 */
export interface UrlGroupContent {
  name: string;
  urls: string[];
  url_text: string;
  depict: string;
  keyword: string;
}

/** 新增 / 编辑自定义 URL 库的表单字段（对应设备 data 的 name/depict/url/keyword）。 */
export interface UrlGroupForm {
  name: string;
  depict: string;
  url: string;
  keyword: string;
}

export interface PolicyInfo {
  name: string;
  type: string;
  order?: number | string;
  inorder?: number | string;
  combine?: string;
  depict?: string;
  founder?: string;
  expire?: string;
  status?: boolean;
  /** 适用用户（use_info.local，逗号分隔的用户/IP/组织） */
  applies_to?: string;
  /** 适用位置（use_info.location） */
  location?: string;
  /** 适用目标区域（use_info.target_area） */
  target_area?: string;
  [key: string]: unknown;
}

export interface PolicyList {
  access_policies: PolicyInfo[];
  ssl_decrypt_policies: PolicyInfo[];
}

export interface AppRef {
  path: string;
  custom: boolean;
}

export interface UrlRef {
  name: string;
  custom: boolean;
}

export type RuleAction = "allow" | "deny" | "unknown";

/** 规则引用的一个应用 / URL 对象（与设备 apps.apps[] 元素对应，可往返编辑）。 */
export interface PolicyAppRef {
  path: string;
  type: string;
  crc: string;
  extra: string;
  custom: boolean;
  kind: "app" | "url";
}

export interface PolicyRule {
  index: number;
  name: string;
  /** 设备侧规则标识（modify 往返按它匹配回原规则）。 */
  rule_id: string;
  time: string;
  action: RuleAction;
  action_raw: unknown;
  /** 动作布尔值：允许=true / 禁止=false（编辑器开关用）。 */
  action_bool: boolean;
  apps: AppRef[];
  urls: UrlRef[];
  /** 可往返编辑的精确引用（含 crc）。 */
  refs: PolicyAppRef[];
  raw: Record<string, unknown>;
}

export interface PolicyDetail {
  policy_name: string;
  rules: PolicyRule[];
  /** 是否启用应用控制（application.include）。 */
  application_include: boolean;
  /** 启用该策略（enable）。 */
  enable: boolean;
  /** 描述信息（depict）。 */
  depict: string;
  appctrl: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** 「选择适用应用」应用目录树节点（acnetpolicy listAppTree）。 */
export interface AppTreeNode {
  crc: string;
  name: string;
  /** "catagory"（分类）| "app"（应用叶子） */
  type: string;
  /** 引用 path，如 "Web流媒体/全部"；选中此节点即用它作为 ref.path。 */
  value?: string;
  leaf?: boolean;
  appPathRoot?: boolean;
  /** 所属标签 id 列表，对应顶层 tags 的筛选。 */
  tags?: string[];
  keywords?: string[];
  extra?: string;
  children?: AppTreeNode[];
}

export interface AppTreeTag {
  id: string;
  name: string;
  description?: string;
}

export interface AppTree {
  tags: AppTreeTag[];
  data: AppTreeNode[];
}

/** 新建访问权限策略请求体。 */
export interface PolicyCreateInput {
  name: string;
  depict: string;
  enable: boolean;
  /** 是否启用应用控制（application.include） */
  include: boolean;
  rules: Array<{
    action: boolean;
    refs: Array<{ path: string; type: string; crc: string; extra: string }>;
  }>;
}

/** 策略「应用控制」编辑请求体。 */
export interface PolicyApplicationUpdate {
  rules: Array<{
    name: string;
    action: boolean;
    refs: Array<{ path: string; type: string; crc: string; extra: string }>;
  }>;
  include?: boolean | null;
  /** 启用该策略 / 描述信息（编辑顶部字段） */
  enable?: boolean | null;
  depict?: string | null;
}

export interface WriteResult {
  dry_run: boolean;
  success: boolean;
  message: string;
  payload: Record<string, unknown> | null;
  result: unknown;
}

export type ObjectType = "customrule" | "url" | "policy";

export interface FieldDiff {
  field: string;
  source: unknown;
  target: unknown;
}

export interface TargetDiff {
  instance_id: number;
  instance_name: string;
  exists: boolean;
  changed: boolean;
  diffs: FieldDiff[];
  error: string;
}

export interface SyncDiffResult {
  object_type: ObjectType;
  object_name: string;
  source_instance_id: number;
  source_snapshot: Record<string, unknown> | null;
  targets: TargetDiff[];
}

export interface TargetApplyResult {
  instance_id: number;
  instance_name: string;
  success: boolean;
  dry_run: boolean;
  message: string;
  payload: Record<string, unknown> | null;
  /** 跨实例策略同步：目标缺失的被引用路径（需先同步对应自定义应用 / URL 库）。 */
  warnings: string[];
}

export interface SyncApplyResult {
  object_type: ObjectType;
  object_name: string;
  source_instance_id: number;
  results: TargetApplyResult[];
}

export interface OverlapAppRef {
  name: string;
  direction: string;
  protocol: string;
  protocol_num: string;
  port: string;
}

export interface ResourceOverlap {
  value: string;
  type: "ip" | "domain";
  count: number;
  apps: OverlapAppRef[];
  conflict: boolean;
}

export interface AppSummary {
  name: string;
  direction: string;
  protocol: string;
  port: string;
  ip_count: number;
  domain_count: number;
  ips: string[];
  domains: string[];
}

/** 策略→应用/URL 连线的动作（首条命中规则为准）：放行/拒绝/未知。 */
export type PolicyLinkAction = "allow" | "deny" | "unknown";

export interface PolicyLink {
  policy: string;
  app: string;
  action: PolicyLinkAction;
}

export interface UrlSummary {
  name: string;
  url_count: number;
  urls: string[];
}

export interface PolicyUrlLink {
  policy: string;
  url: string;
  rules?: Array<{
    index?: number | null;
    name: string;
  }>;
  action: PolicyLinkAction;
}

export interface CustomRuleAnalysis {
  total_apps: number;
  analyzed_apps: number;
  ip_overlaps: ResourceOverlap[];
  domain_overlaps: ResourceOverlap[];
  apps: AppSummary[];
  urls: UrlSummary[];
  policies: string[];
  policy_links: PolicyLink[];
  policy_url_links: PolicyUrlLink[];
  policy_count: number;
  url_count: number;
  errors: string[];
  /** 本次结果是否来自服务端缓存 */
  cached?: boolean;
  /** 缓存已存在的秒数（cached 为 true 时有意义） */
  cache_age_seconds?: number | null;
}

export interface AuditLog {
  id: number;
  created_at: string;
  actor: string;
  instance_id: number | null;
  instance_name: string;
  object_type: string;
  object_name: string;
  action: string;
  success: boolean;
  message: string;
  before: string;
  after: string;
}

export interface PageResult<T> {
  total: number;
  items: T[];
}
