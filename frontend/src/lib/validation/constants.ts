/** 数据校验可视化：配色、键分隔符与视图类型常量。 */

export const POLICY_COLOR = "#34d399";
export const APP_COLOR = "#8b5cf6";
export const URL_LIBRARY_COLOR = "#2dd4bf";
export const URL_ITEM_COLOR = "#fbbf24";
export const AGGREGATED_URL_COLOR = "#a3e635";
export const IP_COLOR = "#22d3ee";
export const AGGREGATED_IP_COLOR = "#f0abfc";
export const DOMAIN_COLOR = "#f59e0b";
export const AGGREGATED_DOMAIN_COLOR = "#fde047";
export const CONFLICT_COLOR = "#f43f5e";
// 策略→应用/URL 连线按动作着色（首条命中规则为准）：放行(绿)/拒绝(红)/未知(灰)
export const ACTION_ALLOW_COLOR = "#34d399";
export const ACTION_DENY_COLOR = "#ef4444";
export const ACTION_UNKNOWN_COLOR = "#94a3b8";
export const KEY_SEPARATOR = "\u001f";
export const FIXED_SANKEY_NODE_VALUE = 1;

export type ValidationView = "app-sankey" | "url-sankey" | "graph";
export type AppSankeyPrimary = "policy" | "app";
export type UrlSankeyPrimary = "policy" | "url";
