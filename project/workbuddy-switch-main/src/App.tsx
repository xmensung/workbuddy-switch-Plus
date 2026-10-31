import { useEffect, useState } from "react";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { BrowserRouter, HashRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { ArrowUp, Link2, Loader2, MessagesSquare, Settings, Sparkles, User } from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import AccountsPage from "@/pages/AccountsPage";
import SessionsPage from "@/pages/SessionsPage";
import CreditStatsPage from "@/pages/CreditStatsPage";
import TokenStatsPage from "@/pages/TokenStatsPage";
import SettingsPage from "@/pages/SettingsPage";
import { StatusDot, AppIconMark } from "@/components/product-marks";
import { UpdateInstallDialog } from "@/components/update-install-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { demoModeEnabled, pagesDemoHostingEnabled } from "@/lib/demo-mode";
import { useSessionsNavEnabled } from "@/lib/nav-prefs";
import { useCreditAutoRefresh } from "@/lib/use-credit-auto-refresh";
import { useCreditFloat } from "@/lib/use-credit-float";
import { useRotateDeferredNotice } from "@/lib/use-rotate-deferred-notice";
import { useUpdateState } from "@/lib/use-update-state";
import { useWorkbuddyStatusRefresh } from "@/lib/use-workbuddy-status-refresh";
import { useAccountsStore } from "@/stores/accounts";

/**
 * 积分概览悬浮窗入口：底部栏的常驻按钮，「会话悬浮窗」移除后由它接管这个位置。
 *
 * 开 / 关都走原生窗口（见 `src-tauri/src/credit_float.rs`）。状态以后端为准，
 * 图标着色表示开态——窗口可能被用户用系统方式关掉，前端只做乐观更新会失真。
 */
function CreditFloatToggle() {
  const { open, busy, toggle } = useCreditFloat();

  async function onToggle() {
    try {
      await toggle();
    } catch (cause) {
      toast.error("积分概览悬浮窗切换失败", { description: api.asError(cause) });
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 shrink-0 gap-1.5 px-2 text-[13px] font-normal",
        open && "bg-foreground/[0.06] text-foreground",
      )}
      aria-label={open ? "关闭积分概览悬浮窗" : "打开积分概览悬浮窗"}
      aria-pressed={Boolean(open)}
      disabled={open === null || busy}
      onClick={() => void onToggle()}
    >
      <Sparkles
        className={cn(
          "size-3.5",
          open ? "text-[var(--data-series-violet)]" : "text-sidebar-foreground/60",
        )}
        aria-hidden="true"
      />
      积分概览
    </Button>
  );
}

function UpdateCenter({ running }: { running: boolean | undefined }) {
  const version = useAccountsStore((s) => s.status?.version);
  const snapshot = useUpdateState();
  const [dialogOpen, setDialogOpen] = useState(false);
  // 积分概览悬浮窗依赖原生窗口，只有桌面正式版可用（WebUI / 演示模式不显示入口）。
  const showCreditFloat = api.isDesktop() && !demoModeEnabled;

  // 阶段由 Rust 更新服务经 `update-state` 推送（托盘同源），前端不再轮询检查。
  // 已知目标版本时，检查中 / 失败也要保留入口，与托盘「升级到 vX / 点击重试」对齐。
  const hasKnownTarget = Boolean(snapshot.latest);
  const hasUpdate =
    snapshot.phase === "available" ||
    snapshot.phase === "downloading" ||
    snapshot.phase === "readyToRestart" ||
    (hasKnownTarget && (snapshot.phase === "error" || snapshot.phase === "checking"));
  const updateHint =
    snapshot.phase === "downloading"
      ? snapshot.percent === null
        ? "正在下载更新…"
        : `正在下载更新 ${snapshot.percent}%`
      : snapshot.phase === "readyToRestart"
        ? "重启以完成升级"
        : snapshot.phase === "error"
          ? "更新失败，点击重试"
          : snapshot.phase === "checking"
            ? "正在检查…"
            : "更新";

  return (
    <>
      <section className="mt-auto border-t border-sidebar-border px-2 pt-3 text-xs">
        <div className="flex items-center justify-between gap-2 text-[13px] text-sidebar-foreground">
          {showCreditFloat ? (
            <CreditFloatToggle />
          ) : (
            <>
              <StatusDot on={Boolean(running)} />
              <span className="min-w-0 flex-1 truncate">WorkBuddy</span>
            </>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {showCreditFloat && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center">
                    <StatusDot on={Boolean(running)} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {running ? "WorkBuddy 正在运行" : "WorkBuddy 未运行"}
                </TooltipContent>
              </Tooltip>
            )}
            <span className="text-sidebar-foreground/50">v{version || "?"}</span>
            {hasUpdate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    className="size-5 rounded-full p-0"
                    aria-label={updateHint}
                    onClick={() => setDialogOpen(true)}
                  >
                    {snapshot.phase === "downloading" || snapshot.phase === "checking" ? (
                      <Loader2 className="size-3 animate-spin" strokeWidth={2.5} aria-hidden="true" />
                    ) : (
                      <ArrowUp className="size-3" strokeWidth={2.5} aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{updateHint}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </section>
      <UpdateInstallDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

function Layout() {
  const running = useAccountsStore((s) => s.status?.running);
  const hasUnifiedTitleBar =
    api.isDesktop() && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  const sessionsNavEnabled = useSessionsNavEnabled();
  useCreditAutoRefresh();
  useWorkbuddyStatusRefresh();
  useRotateDeferredNotice();

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-background">
      {hasUnifiedTitleBar ? (
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-50 h-8"
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={cn(
          "flex min-h-0 w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4",
          hasUnifiedTitleBar ? "pt-20" : "pt-4",
        )}
      >
        <div className="flex items-center gap-2.5 px-1 pb-5">
          <AppIconMark size={36} className="drop-shadow-sm" />
          <div className="min-w-0">
            <div
              className="truncate text-[15px] leading-5 tracking-[-0.02em] text-sidebar-foreground/90"
              style={{
                fontFamily: '"Bricolage Grotesque Variable", "SF Pro Display", ui-sans-serif, sans-serif',
                fontWeight: 640,
              }}
            >
              WorkBuddy Switch
            </div>
            {demoModeEnabled && (
              <Badge variant="secondary" className="mt-1 h-5 border-0 px-1.5 text-[10px] text-sidebar-foreground/60 shadow-none">
                演示模式
              </Badge>
            )}
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5" aria-label="主导航">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <User className="size-4" />
            账号管理
          </NavLink>
          {sessionsNavEnabled && (
            <NavLink
              to="/sessions"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                  isActive
                    ? "bg-foreground/[0.06] font-medium text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                )
              }
            >
              <Link2 className="size-4" />
              关联会话
            </NavLink>
          )}
          <NavLink to="/token-stats" className={({ isActive }) => cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors", isActive ? "bg-foreground/[0.06] font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground")}><MessagesSquare className="size-4" />Token 统计</NavLink>
          <NavLink
            to="/credit-stats"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <Sparkles className="size-4" />
            积分统计
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <Settings className="size-4" />
            设置
          </NavLink>
        </nav>
        {api.isWebui() && !demoModeEnabled ? null : <UpdateCenter running={running} />}
      </aside>
      <main
        className={cn(
          "min-w-0 flex-1 overflow-y-auto bg-background overscroll-contain",
          hasUnifiedTitleBar && "pt-16 [&>div]:pt-4",
        )}
      >
        <Outlet />
      </main>
    </div>
  );
}

/** Rust 侧 `credit_float::NAVIGATE_EVENT` 的事件名。 */
const MAIN_NAVIGATE_EVENT = "main-navigate";

/**
 * 主窗口导航桥：把 Rust 侧的跳转意图落到 react-router 上。
 *
 * 悬浮窗双击环形图时，Rust 会打开主界面并广播 `main-navigate`。两条通路都要覆盖：
 * - 主窗口已经在跑 → 靠事件；
 * - 主窗口刚被轻量模式重建 → 前端还没挂载，事件必然丢失，因此挂载时再取一次后端
 *   暂存的跳转目标（`take_pending_nav`）。
 *
 * 收到事件后顺手把暂存位清掉：事件已经送达，留着它会让下一次重建的窗口莫名其妙
 * 又跳到积分统计页。
 */
function MainNavigationBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!api.isDesktop()) return;
    let alive = true;

    void api
      .takePendingNav()
      .then((route) => {
        if (alive && route) navigate(route);
      })
      .catch(() => {
        /* 非 Tauri 宿主没有这条通路。 */
      });

    const stop = listen<string>(MAIN_NAVIGATE_EVENT, (event) => {
      void api.takePendingNav().catch(() => undefined);
      if (event.payload) navigate(event.payload);
    }).catch(() => undefined);

    return () => {
      alive = false;
      void stop.then((unlisten) => unlisten?.());
    };
  }, [navigate]);

  return null;
}

export default function App() {
  const Router = pagesDemoHostingEnabled ? HashRouter : BrowserRouter;

  return (
    <TooltipProvider delayDuration={250}>
      <Router>
        <MainNavigationBridge />
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<AccountsPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/credit-stats" element={<CreditStatsPage />} />
            <Route path="/token-stats" element={<TokenStatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster />
      </Router>
    </TooltipProvider>
  );
}
