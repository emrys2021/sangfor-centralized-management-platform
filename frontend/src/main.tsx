import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";

import { ConfirmProvider } from "./components/confirm-dialog";
import { router } from "./router";
import { useAppStore } from "./stores/app";

import "./index.css";

// 初始化主题
const initialTheme = useAppStore.getState().theme;
document.documentElement.classList.toggle("dark", initialTheme === "dark");

const queryClient = new QueryClient({
  // staleTime 30s：切换页面再回来时 30 秒内直接用缓存、不重复拉设备；
  // 写操作已通过 invalidateQueries 主动刷新对应列表，不受此影响。
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
      <Toaster richColors position="top-right" theme={initialTheme} />
    </QueryClientProvider>
  </React.StrictMode>
);
