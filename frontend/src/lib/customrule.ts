// 自定义应用相关的共享枚举与标签映射（表单、详情、数据校验复用）

export const DIRECTIONS = [
  { value: "both", label: "LAN<->WAN" },
  { value: "lan2wan", label: "LAN->WAN" },
  { value: "wan2lan", label: "WAN->LAN" },
] as const;

export const DIRECTION_LABEL: Record<string, string> = {
  both: "LAN<->WAN",
  lan2wan: "LAN->WAN",
  wan2lan: "WAN->LAN",
};

// 值为报文中的 protocol 数字（据抓包 TCP=0），UDP/ICMP 标签为推测，可按需调整。
export const PROTOCOL_OPTIONS = [
  { value: "0", label: "TCP" },
  { value: "1", label: "UDP" },
  { value: "2", label: "ICMP" },
];

const PROTOCOL_LABEL: Record<string, string> = Object.fromEntries(
  PROTOCOL_OPTIONS.map((o) => [o.value, o.label])
);

export function protocolLabel(value: string | number): string {
  const key = String(value);
  return PROTOCOL_LABEL[key] ?? `协议(${key})`;
}

export function directionLabel(value: string): string {
  return DIRECTION_LABEL[value] ?? value;
}
