import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";

import { router } from "./router";
import { useAppStore } from "./stores/app";

import "./index.css";

// 初始化主题
const initialTheme = useAppStore.getState().theme;
document.documentElement.classList.toggle("dark", initialTheme === "dark");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster richColors position="top-right" theme={initialTheme} />
    </QueryClientProvider>
  </React.StrictMode>
);
