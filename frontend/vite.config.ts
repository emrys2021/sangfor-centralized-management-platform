import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // 体积较大的第三方库单独分块，改善浏览器缓存命中、并把 echarts 留在懒加载链路上
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // 内联的 ?raw 原始资源（离线导出用的 echarts.min）留在各自引用的懒加载块，
          // 不并入下面的 echarts 模块块，避免单块过大触发告警。
          if (id.includes("?raw")) return;
          if (id.includes("echarts") || id.includes("zrender")) return "echarts";
          if (id.includes("@radix-ui")) return "radix";
          if (id.includes("@tanstack")) return "tanstack";
          return "vendor";
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // 5173 在部分 Windows 上落入 WinNAT 动态保留端口段（随重启/Docker/WSL 变化）会报
    // EACCES（端口空着但被系统保留、非进程占用），固定到空闲的 5050 规避
    host: "127.0.0.1",
    port: 5050,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        // 数据校验等接口耗时较长，放宽代理超时到 5 分钟
        timeout: 300000,
        proxyTimeout: 300000,
      },
    },
  },
});
