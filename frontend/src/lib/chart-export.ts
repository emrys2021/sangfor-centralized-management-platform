/**
 * 把 ECharts 图表导出为「自包含、可离线、矢量、可交互」的单文件 HTML。
 *
 * 为什么是 HTML 而不是静态 SVG：用户要在导出件里保留「悬停高亮当前分支」
 * （桑基图 ``emphasis.focus:'trajectory'``）的交互——静态 SVG 做不到。这里在导出件中
 * 用 ECharts 的 **SVG 渲染器**重绘同一份 option，于是同时拿到：
 *   - 矢量输出 → 浏览器里 Ctrl/⌘+滚轮无极缩放、放大不失真；
 *   - 完整交互 → 悬停高亮分支、提示框照常（本页桑基图的 tooltip 文本已预存在
 *     ``data._tip``，formatter 只读 ``p.*``、自包含，``toString()`` 后可独立运行）；
 *   - 离线可用 → 把 echarts 运行时按需内联进 HTML（点导出时才懒加载，避免撑大主包）。
 */

/**
 * 将含函数的 option 序列化为「可执行的 JS 对象字面量字符串」。
 * 普通 ``JSON.stringify`` 会丢掉 formatter 等函数，这里把函数替换为占位符再回填其源码。
 * 仅适用于**自包含**的函数（不依赖外层闭包变量）——本页桑基图满足此前提。
 */
function serializeOption(option: unknown): string {
  const fns: string[] = [];
  const json = JSON.stringify(option, (_key, value) => {
    if (typeof value === "function") {
      fns.push(value.toString());
      return `__FN_${fns.length - 1}__`;
    }
    return value;
  });
  return json.replace(/"__FN_(\d+)__"/g, (_m, i) => fns[Number(i)]);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "chart";
}

function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间发起下载再回收，避免个别浏览器中断。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导出图表为自包含 HTML 文件（矢量、可缩放、保留悬停高亮）。
 *
 * @param option     传给 ECharts 的 option（与页面在用的同一份）。
 * @param title      文件标题 / 文件名。
 * @param height     画布高度（px）；桑基图较高，传入页面上当前的高度以完整呈现。
 * @param background HTML 背景色，默认深色以匹配浅色标签。
 */
export async function exportChartHtml(opts: {
  option: unknown;
  title: string;
  height: number;
  background?: string;
}): Promise<void> {
  // 按需懒加载 echarts 运行时源码（单独 chunk，不进主包）。
  const mod = (await import("echarts/dist/echarts.min.js?raw")) as { default: string };
  const echartsSource = mod.default;
  const optionStr = serializeOption(opts.option);
  const bg = opts.background ?? "#0b0b12";
  const safeTitle = escapeHtml(opts.title);
  const height = Math.max(360, Math.round(opts.height));

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  html, body { margin: 0; background: ${bg}; color: #e2e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  #toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center;
    padding: 8px 14px; background: rgba(11,11,18,.85); backdrop-filter: blur(6px);
    border-bottom: 1px solid rgba(255,255,255,.08); font-size: 12px; }
  #toolbar strong { font-size: 13px; }
  #toolbar .hint { color: #94a3b8; }
  #chart { width: 100%; height: ${height}px; }
</style>
</head>
<body>
<div id="toolbar">
  <strong>${safeTitle}</strong>
  <span class="hint">悬停高亮分支 · Ctrl/⌘ + 滚轮 无极缩放（矢量 SVG，放大不失真）</span>
</div>
<div id="chart"></div>
<script>${echartsSource}</script>
<script>
  var option = ${optionStr};
  var chart = echarts.init(document.getElementById('chart'), null, { renderer: 'svg' });
  chart.setOption(option);
  window.addEventListener('resize', function () { chart.resize(); });
</script>
</body>
</html>`;

  downloadBlob(html, `${sanitizeFilename(opts.title)}.html`, "text/html;charset=utf-8");
}
