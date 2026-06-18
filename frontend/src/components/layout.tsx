import {
  Boxes,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Globe,
  Moon,
  RefreshCw,
  Server,
  ShieldCheck,
  Sun,
  Workflow,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { InstanceSwitcher } from "@/components/instance-switcher";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";

const navItems = [
  { to: "/customrules", label: "自定义应用", icon: Boxes },
  { to: "/urls", label: "自定义 URL", icon: Globe },
  { to: "/policies", label: "访问权限策略", icon: ShieldCheck },
  { to: "/validation", label: "数据校验", icon: Workflow },
  { to: "/sync", label: "实例同步", icon: RefreshCw },
  { to: "/audit", label: "操作日志", icon: ClipboardList },
  { to: "/instances", label: "实例管理", icon: Server },
];

export function AppLayout() {
  const { theme, toggleTheme, sidebarCollapsed, toggleSidebar, sidebarWidth, setSidebarWidth } =
    useAppStore();
  const draggingRef = useRef(false);

  // 拖拽侧边栏右边缘调整宽度
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) setSidebarWidth(e.clientX);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setSidebarWidth]);

  const width = sidebarCollapsed ? 64 : sidebarWidth;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 侧边栏 */}
      <aside
        className="relative flex shrink-0 flex-col glass-soft border-r border-white/10 transition-[width] duration-150"
        style={{ width }}
      >
        <div className={cn("flex h-16 items-center gap-3 px-4", sidebarCollapsed && "justify-center px-0")}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-[0_4px_16px_-6px_hsl(263_80%_55%/0.6)]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          {!sidebarCollapsed && (
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">深信服 AC</div>
              <div className="text-[11px] text-muted-foreground">统一管理平台</div>
            </div>
          )}
        </div>

        <nav className="flex-1 space-y-1 px-2 py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={sidebarCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                  sidebarCollapsed && "justify-center px-0",
                  isActive
                    ? "bg-white/[0.06] text-foreground"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "absolute left-0 top-1/2 h-5 -translate-y-1/2 rounded-r-full bg-primary transition-all",
                      isActive ? "w-0.5 opacity-100" : "w-0 opacity-0"
                    )}
                  />
                  <item.icon
                    className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      isActive && "text-primary"
                    )}
                  />
                  {!sidebarCollapsed && item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2.5">
          {!sidebarCollapsed && <span className="text-[11px] text-muted-foreground">v0.1.0</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleSidebar} title="折叠/展开">
            {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        {/* 拖拽手柄：跨越右边缘的较宽抓取区（z-30 确保任何页面都能抓到），中间一条细线在悬停时高亮 */}
        {!sidebarCollapsed && (
          <div
            onMouseDown={() => {
              draggingRef.current = true;
              document.body.style.userSelect = "none";
              document.body.style.cursor = "col-resize";
            }}
            className="group absolute -right-1 top-0 z-30 h-full w-2 cursor-col-resize"
            title="拖拽调整宽度"
          >
            <span className="pointer-events-none absolute right-1 top-0 h-full w-px bg-transparent transition-colors group-hover:bg-primary/50" />
          </div>
        )}
      </aside>

      {/* 主区 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 glass-soft px-6">
          <InstanceSwitcher />
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题" className="rounded-full">
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <div className="ring-gradient flex items-center gap-2 rounded-full px-3 py-1.5 text-sm">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[11px] font-semibold text-white">
                A
              </div>
              系统管理员
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
