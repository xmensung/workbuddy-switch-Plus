import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// GitHub Pages serves only the public demo from the repository subpath.
// Normal WebUI and Tauri builds intentionally keep Vite's root base.
// @ts-expect-error process is a nodejs global
const base = process.env.VITE_PAGES_DEMO === "1" ? "/workbuddy-switch/" : "/";

// https://vite.dev/config/
export default defineConfig(async () => ({
  base,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // 两个页面入口，两个原生窗口：
  //   index.html       → 主窗口（App，含路由 / 侧边栏）
  //   credit-float.html → 积分悬浮窗（只渲染 CreditFloatPage）
  // 悬浮窗用独立入口而不是共用 index.html 靠 label 分流，避免「运行期判定不成立时
  // 悬浮窗里冒出整个主界面」这一类不可控故障（详见 credit-float.html 的注释）。
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        creditFloat: path.resolve(__dirname, "credit-float.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
