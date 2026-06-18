import type { AppTreeNode, PolicyAppRef } from "./types";

/** 以 path + crc 作为引用唯一键（同名不同 crc 视为不同引用）。 */
export function refKey(r: { path: string; crc: string }): string {
  return `${r.path} ${r.crc}`;
}

/** 路径任一段以「自定义」开头即视为自定义对象（与后端 is_custom 一致）。 */
export function isCustomPath(path: string): boolean {
  return path
    .split(/[/\\>＞]/)
    .some((seg) => seg.trim().startsWith("自定义"));
}

/** 引用类别 → 徽标文案与配色（自定义应用 / 内置应用 / 自定义URL / 内置URL）。 */
export function kindMeta(ref: { kind: string; custom: boolean }): { label: string; cls: string } {
  if (ref.kind === "url") {
    return ref.custom
      ? { label: "自定义URL", cls: "border-cyan-400/30 bg-cyan-500/10 text-cyan-300" }
      : { label: "内置URL", cls: "border-teal-400/30 bg-teal-500/10 text-teal-300" };
  }
  return ref.custom
    ? { label: "自定义应用", cls: "border-violet-400/30 bg-violet-500/10 text-violet-300" }
    : { label: "内置应用", cls: "border-white/15 bg-white/5 text-muted-foreground" };
}

/**
 * 应用树节点 → 规则引用。``value`` 即引用 path；crc/type 原样取设备值。
 * 「访问网站」分支标记 extra="url"（与真实 modify 报文一致），其余按节点自带 extra。
 */
export function nodeToRef(node: AppTreeNode): PolicyAppRef {
  const path = node.value || node.name;
  const firstSeg = path.split("/")[0]?.trim();
  const extra = node.extra || (firstSeg === "访问网站" ? "url" : "");
  return {
    path,
    type: node.type || "",
    crc: node.crc != null ? String(node.crc) : "",
    extra,
    custom: isCustomPath(path),
    kind: extra === "url" ? "url" : "app",
  };
}
