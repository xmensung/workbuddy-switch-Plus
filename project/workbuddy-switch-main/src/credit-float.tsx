import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "./index.css";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { applyTheme, getThemePreference, watchSystemTheme } from "./lib/theme";
import CreditFloatPage from "./pages/CreditFloatPage";

/**
 * 积分悬浮窗的独立入口（对应根目录 `credit-float.html`）。
 *
 * 与主窗口入口（`main.tsx`）刻意分开：悬浮窗不需要路由、不需要侧边栏、不需要
 * 通知存档与全局错误上报（它没有 Toaster），因此这里只做三件事——把主题定下来、
 * 挂一层错误边界、渲染环形图页面。
 *
 * 由此，悬浮窗里渲染什么都不再依赖运行期的窗口 label 判定：这份 bundle 里根本
 * 没有主界面，最坏情况也只会看到错误边界给出的可读错误页，而不是一个套着整站
 * 界面的小窗。
 */
const stopWatchingSystemTheme = watchSystemTheme();
if (import.meta.hot) import.meta.hot.dispose(stopWatchingSystemTheme);
applyTheme(getThemePreference());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <CreditFloatPage />
    </AppErrorBoundary>
  </React.StrictMode>,
);
