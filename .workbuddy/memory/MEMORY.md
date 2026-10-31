# 项目长期记忆

## 项目：workbuddy-switch 定制化 Fork

- **本地路径**：`G:/Mine/一些自制小工具/Workbuddy Switch/project/workbuddy-switch-main`
  （2026-10-20 由 `F:/WorkBuddy/2026-10-11-16-28-54/` 整体移来；那边的目录已清空，
  找不到源码时用 `find /f /g /d -maxdepth 7 -name "CreditFloatPage.tsx" -not -path "*/node_modules/*"`）
- **来源**：`changexbc/workbuddy-switch` v0.1.60 源码。**非 git 仓库**（删文件不可恢复）。
- **技术栈**：Tauri 2 + React 19 + Vite 7 + Tailwind 4 + zustand + recharts；核心逻辑 `crates/wb-switch-core`，HTTP/CLI `crates/wb-switch-server`。

### 开发命令

```bash
npm install                     # 依赖
node_modules/.bin/tsc --noEmit  # 类型检查
node_modules/.bin/vitest run    # 前端单测（60 条）
export PATH="$HOME/.cargo/bin:$PATH"
cargo test -p wb-switch-rust --lib   # Rust 单测（44 条）
node_modules/.bin/vite build    # 前端构建
```

### 本机环境约束

- Rust 1.99.0 在 `$HOME/.cargo/bin`，需 `export PATH="$HOME/.cargo/bin:$PATH"`。
- **无 sidecar 依赖**（v0.1.64 起）。`vendor/agent-companion/` 留盘参考，不再编译。
- **⚠️ Node 同步子进程被拦截**：`spawnSync`/`execSync`/`execFileSync` 一律 `EBUSY (-4082)`；异步 `spawn` 正常；Python/bash 不受限。故 `npm run tauri build` 不可用，需 bash 逐步跑；`npm ci` 也会被删批量保护拦。
- **外网直连被拦**（GitHub 502）。GitHub 镜像用 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://ghfast.top/https://github.com`（缓存 `%LOCALAPPDATA%\tauri\NSIS\`）。可用：ghfast.top / gh-proxy.com / ghproxy.net。
- 首次 cold build 极慢（622 依赖），中断可续跑。
- **本机无 perl** → `scripts/bump-version.sh` 不可用，改 `sed -i` 手工升版。

### 出包流水线（v0.1.64 起两条命令）

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://ghfast.top/https://github.com"
node_modules/.bin/vite build
node_modules/.bin/tauri build --bundles nsis --config tauri.local-override.json
```

`tauri.local-override.json`（仓库根）：`{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}` —— `beforeBuildCommand` 必须置空，无 updater 私钥故关 `createUpdaterArtifacts`。
**出包**：`target/release/bundle/nsis/workbuddy-switch_<ver>_x64-setup.exe`。**交付**：复制到 `F:/WorkBuddy/2026-10-11-16-28-54/workbuddy-switch-custom_<ver>_x64-setup.exe`。
**注意 `vite build` 会清空 `dist/`。**

### 项目既有约定

- 「支持工具」开关持久化 `localStorage`，键 `wb-switch.tools.<id>`，同页事件 `wb-switch:tools-changed` 广播（`src/lib/supported-tools.ts`）。
- 跨窗口状态「以后端为准」：前端乐观更新 + 后端事件校准（`src/lib/use-credit-float.ts`）。
- 积分刷新节流下限 30 分钟（`CREDIT_REFRESH_INTERVAL_MS`），防官方 429。
- **新增窗口必须在 `src-tauri/capabilities/default.json` 的 `windows` 放行 label。**
- Token 数量统一走 `src/lib/token-format.ts` 的 `formatTokenCount`（完整千分位，不缩 K/M）。

## 积分概览悬浮窗（credit-float）

### 架构要点（定型，勿改）

- **独立页面入口**：根 `credit-float.html` + `src/credit-float.tsx`；`vite.config.ts` 的 `build.rollupOptions.input` 配双入口；Rust 用 `WebviewUrl::App("credit-float.html")`。
  **不要**共用 `index.html` 靠运行期 label 分流——v0.1.61 真实故障：悬浮窗渲染出整套主界面。`main.tsx` 的 label 分流保留作第二道防线。
- Rust `src-tauri/src/credit_float.rs`：`WINDOW_LABEL="credit-float"`，**440x660**，无边框+透明+置顶；`place_bottom_right()` 按主屏 `work_area`+`scale_factor` 定位右下角（边距 24px），`visible(false)` 建窗→定位→`show()`。无边框窗不显式定位会套用 Windows 层叠位置。
- **整卡可拖**：`useWindowDrag()` 手动 `startDragging()`，命中 `button/a/input/select/textarea/[data-tauri-drag-region]/[data-resize-handle]/[data-no-drag]` 放行。
  **`data-no-drag`**：任何要响应**双击**的元素必须标——`startDragging` 按下即进系统级模态拖动循环，抬不起来，双击永远凑不齐（环形图靠它才能双击）。
- **自由缩放（v0.1.66）**：`decorations(false)` 无系统 resize 边框。最外层铺 8 条透明手柄（四边+四角，`data-resize-handle`），`onMouseDown` 先 `stopPropagation()` 再 `startResizeDragging(direction)`。**capability 必须放行 `core:window:allow-start-resize-dragging`**，否则静默失败。`ResizeDirection` 未从 `@tauri-apps/api/window` 导出，需自抄类型。Rust 侧 MIN 320×240。
- 入口：主窗口底栏 `CreditFloatToggle`、托盘菜单「显示积分概览」（CheckMenuItem）、`get_credit_float_open` 回读、托盘指针行为。开/关均需 `tray::refresh_tray_menu` 同步；`tray::on_window_event` 对 `credit-float` 的 CloseRequested/Destroyed 同步。

### 托盘指针行为（Windows；macOS 一律不启用，门控 `tray_pointer_actions_enabled()`）

- 悬停 `Enter` → 弹**预览态**浮窗；`Leave` → 自动收起；左键单击 → 显式打开；左键双击 → 主界面。
- **只有预览态自动收起**：`HOVER_PREVIEW: AtomicBool`。底部按钮/托盘菜单/单击 = 显式打开（`enter_pinned_mode()`：清标记+代次+1），移开指针不收起；已显式打开时悬停不降级。
- 悬停**不抢焦点**（`show_or_focus(app, false, preview)`，`show()` 只 `SWP_SHOWWINDOW`）。
- **收起判定 = 轮询 + 重置计时**（`on_pointer_left_tray` + `HoverWatch`）：110ms 轮询，指针**连续 350ms 不在窗口范围**才收起。一次性定时器会在「托盘图标→浮窗」路上误收。位置判定用 Rust 读光标（`AppHandle::cursor_position()`=`GetCursorPos`）与窗口矩形（`outer_position`/`outer_size`=`GetWindowRect`），同为虚拟屏幕物理像素可直接比较；不用前端 `mouseleave`（浮窗不抢焦点、从非激活，webview 收鼠标进出无保证）。
- **预览收起只 `hide()` 不销毁**（建窗 WebView2 要几百 ms）。故 **`is_open()` 按「可见性」判定**，不是「窗口对象存在」。
- **Windows 一次双击派发 4 事件：Down → Up → DBLCLK → Up**。`TrayClickArbiter`：单击挂起 `TRAY_CLICK_DOUBLE_WINDOW_MS=400ms`，双击作废挂起项 + 之后 400ms 内单击 `Ignore`。时钟用 `Instant`（`tray_clock_ms()`）。`Enter`/`Leave` 不走仲裁。
- `show_or_focus` **只在不可见→可见**时才 `emit(VISIBILITY_EVENT)` + `refresh_tray_menu`（悬停会反复进来，菜单展示中 `set_menu` 会闪）。
- 托盘回调的 `AppHandle` 用**具体类型**不用泛型（否则 E0308）。

### 刷新时间与跳转（v0.1.67）

- 头部右贴 `HH:MM:SS 刷新`（刷新中「刷新中…」）。取本机手动刷新时刻 `refreshedAt`，无则退回各账号 `credit.updatedAt` 最大值（开窗补齐、30 分钟后台刷新不经过按钮）。
- 双击环形图 → 主窗口积分统计页。Rust `open_credit_stats` 走 `tray::show_main_window` + 广播 `main-navigate`（payload `/credit-stats`，对齐 `App.tsx` 的 `<Route path="/credit-stats">`）；主窗口不存在先写 `PENDING_NAV`，由 `take_pending_nav` 取。前端 `MainNavigationBridge`（必须在 `<Router>` 内）挂载时 take 一次兜「窗口刚重建、事件早于挂载」，收事件后再 take 一次**清空暂存位**。

### 数据口径（`credits.rs`）

官方按「资源包」发积分，每包 `total`/`remaining`/`used`/`expireAt` + `expired`/`expiringSoon`。
- `totalRemaining` = Σ remaining（**含已过期包**）；`expiringSoonRemaining`/`expiredRemaining` 按 flag 汇总。
- 悬浮窗口径：**可用 = Σ 未过期包 remaining**。v0.1.66 起悬浮窗**不再展示**总量/已用/已过期（只做概览，全量明细在主窗口积分统计页）。
- **⚠️ 过期必须按「整天」算（v0.1.69 修的 bug）**：官方 `expireAt` 是**到期日当天 00:00**。用 `expireAt <= now` 会让当天零点后「今天到期」的包整笔消失。统一 `startOfDay()`/`daysUntil()`（今天到期=0），`isExpired` = `startOfDay(expireAt)+DAY_MS <= startOfDay(now)`；`toneOf`/`formatLeft`/紧急判定全部用 `daysUntil`，否则同屏两种口径打架。
- 环形图（**v0.1.70 定型：三档**）：**整圈 = 可用积分**，按紧急度切三段——
  红 `--credit-expiring` = **72 小时内**到期，橙 `--credit-soon` = 72h~7 天，绿 `--credit-safe` = 更久。
  环心是可用积分数字（20~23px，按位数收字号）。
  **只分这三档，不要按每笔积分包分段**（20+ 笔会挤成 1~2px 碎色块）。
  配色在 `src/index.css`，浅深各一套；**不要**用 `--data-series-*`。
  浅色：红 `oklch(0.585 0.215 22)`≈#DF273C、橙 `oklch(0.685 0.172 46)`≈#ED712B；
  橙必须是**高彩度 hue 46 的真橙**，避开用户否掉的浊琥珀 `oklch(0.735 0.137 70)`≈#E09839；
  红要够深（珊瑚红 #EA3E40 与橙在细环上分不清，v0.1.70 已调深）。
- 账号卡片三行：环心数字 + 账号名 + 到期提示。**提示（v0.1.70 起）**：
  ① 7 天内无到期 → 灰字「7 天内没有到期的积分」；
  ② **72 小时内** → 红字合计 + 逐笔（`2,200 · 基础版资源包 · 10-23 到期 · 3 天后`），
     只有一笔时给一行「MM-DD 到期 · N 天后」；列表也是 >1 笔才出现；
  ③ **72h~7 天** → 橙字合计 + 最近到期日 + 「另有 N 个到期日」；
  ②③ 可同时出现（上红下橙）。判档仍用 `daysUntil`（整天口径）：
  官方 `expireAt` 是当天 00:00，`days ≤ 3` ≡ 72 小时内、`days ≤ 7` ≡ 168 小时内。
  明细行 **flex 三段**（金额/包名/到期日）：包名 `flex-1 truncate` 让位，金额与到期日 `shrink-0 whitespace-nowrap` 永远完整。**无展开、无明细按钮**。

### 「会话悬浮窗」(Agent Companion) 已于 2026-10-12 全部删除

已移除 Rust 侧 `companion` 模块/依赖/命令/托盘菜单/capability/externalBin、前端 `CompanionFooter`/`CompanionCard`/`api.ts` 封装/多个 lib 与组件、`scripts/prepare-*companion*.mjs`。**保留** `vendor/agent-companion/` 源码（未编译，非 git 不可恢复）。

### 本机调试铁律

- **首选：真实 Chromium + 假 IPC 验证前端产物**（不需要跑 Tauri）：
  ```bash
  python -m http.server 8099 --directory dist   # 需绝对路径 python
  CHROME_PATH="%LOCALAPPDATA%/ms-playwright/chromium-1243/chrome-win64/chrome.exe" node float-verify.mjs
  ```
  `float-verify.mjs` 用 `playwright-core`（在 `C:\Users\X\.workbuddy\binaries\node\workspace\node_modules\`，ESM 不吃 `NODE_PATH`，需 `file:///...` 绝对导入）打开 `credit-float.html`，`addInitScript` 注入 `window.__TAURI_INTERNALS__`（`metadata.currentWindow.label` + `invoke` 按命令名返回假数据）。`isWebui()` 判 `!("__TAURI_INTERNALS__" in window)`，注入后即视为桌面宿主。
- **GDI 截图（BitBlt/PrintWindow）截不到 WebView2，全黑**——别用截图验证。
- WebView2 CDP 极不稳定（`/json/list` target 时有时无）。
- 备选 **Rust 落盘探针**：临时 `#[tauri::command]` 用 `std::fs` 写固定文件。探针命令要放 `commands.rs` 等子模块（放 `lib.rs` 根部会与 `generate_handler!` 宏冲突 E0255）。
- **应用错误日志**：`~/.wb-switch/error.log`（`AppErrorBoundary` 落盘）。排查「界面不对」先看它——无条目说明没崩，是渲染内容不对。
