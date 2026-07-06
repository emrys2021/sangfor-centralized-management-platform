import type { EChartsReactProps } from "echarts-for-react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import { GraphChart, SankeyChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

// 按需注册：本项目只用 桑基图 / 关系图（force）+ tooltip + Canvas 渲染器。
// 相比 `import ReactECharts from "echarts-for-react"`（全量引入整个 echarts，构建产物 ~1MB），
// 模块化注册能把 validation 页的 echarts chunk 减掉一半以上。
// 新图表类型/组件（如 legend、dataZoom）需在此处补注册，否则运行时报「series/component 未注册」。
echarts.use([SankeyChart, GraphChart, TooltipComponent, CanvasRenderer]);

/** 轻量 ECharts 组件：与 `echarts-for-react` 默认导出同 props（echarts 实例已内置）。 */
export function EChartsLite(props: Omit<EChartsReactProps, "echarts">) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
