import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 积分悬浮窗的窗口 label。
 *
 * 必须与 Rust 侧 `src-tauri/src/credit_float.rs` 的 `WINDOW_LABEL` 一致；
 * capabilities 也需要放行同名窗口（`capabilities/default.json`）。
 */
export const CREDIT_FLOAT_LABEL = "credit-float";

/**
 * 当前 webview 是不是积分悬浮窗。
 *
 * 判定以**窗口 label** 为准：Tauri 在页面脚本之前注入窗口元数据，读取是同步的，
 * 也不受 URL 编码影响（`WebviewUrl::App` 走资源路径解析，路径里带 `#` / `?`
 * 会被当成文件名）。额外认一次 URL hash，只为开发时能直接在浏览器里访问该视图。
 */
export function isCreditFloatWindow(): boolean {
  try {
    if (getCurrentWindow().label === CREDIT_FLOAT_LABEL) return true;
  } catch {
    /* 非 Tauri 宿主（WebUI / 纯浏览器）没有「当前窗口」概念。 */
  }
  if (typeof window === "undefined") return false;
  return window.location.hash.replace(/^#\/?/, "") === CREDIT_FLOAT_LABEL;
}
