import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  /** 当前选中的实例 ID（功能 1-3 的数据均针对该实例） */
  currentInstanceId: number | null;
  setCurrentInstanceId: (id: number | null) => void;

  theme: "dark" | "light";
  toggleTheme: () => void;

  /** 左侧导航栏折叠（图标模式）与宽度（可拖拽调整） */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentInstanceId: null,
      setCurrentInstanceId: (id) => set({ currentInstanceId: id }),
      theme: "dark",
      toggleTheme: () =>
        set((s) => {
          const next = s.theme === "dark" ? "light" : "dark";
          document.documentElement.classList.toggle("dark", next === "dark");
          return { theme: next };
        }),

      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      sidebarWidth: 256,
      setSidebarWidth: (w) => set({ sidebarWidth: Math.min(420, Math.max(200, w)) }),
    }),
    { name: "sangfor-ac-app" }
  )
);
