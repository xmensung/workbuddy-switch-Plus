//! 积分概览悬浮窗：一个独立的、无边框、置顶的小窗口，用环形图展示每个账号的
//! 积分总量、可用量与各批积分的到期日。
//!
//! 窗口内容来自**独立的前端入口** `credit-float.html`（构建产物与主窗口的
//! `index.html` 并列）——悬浮窗不共用主界面文档，因此不可能被渲染成整套应用。
//! 刻意不把标记写进 URL —— `WebviewUrl::App` 走的是资源路径解析，
//! 路径里带 `#` / `?` 会被当成文件名而不是 URL 片段。
//!
//! 入口有五处：主窗口底部栏按钮、托盘菜单项、托盘的指针行为（悬停预览 / 单击打开，
//! 双击打开主界面，见 `tray::on_tray_icon_event`）、鼠标离开托盘图标时的自动收起，
//! 以及 `get_credit_float_open` 的状态回读（前端据此对齐开关状态）。
//!
//! 「悬停预览」与「显式打开」是两种不同的窗口来源，收起规则也不同：只有预览态
//! 会在指针离开后自动收起（`on_pointer_left_tray`），底部按钮 / 托盘菜单 / 单击
//! 托盘图标都是显式打开，移开指针不该把它们关掉。

#[cfg(any(desktop, test))]
use std::time::{Duration, Instant};
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::AppHandle;

/// 悬浮窗 label —— capabilities 需要同步放行（见 `capabilities/default.json`）。
pub const WINDOW_LABEL: &str = "credit-float";

/// 悬浮窗加载的页面入口（相对 `frontendDist` 根）。
const WINDOW_ENTRY: &str = "credit-float.html";

/// 悬浮窗可见性变化事件：主窗口据此同步底部按钮的开关状态。
pub const VISIBILITY_EVENT: &str = "credit-float-visibility";

/// 主窗口的积分统计页路由，必须与 `src/App.tsx` 的
/// `<Route path="/credit-stats">` 一致。
pub const CREDIT_STATS_ROUTE: &str = "/credit-stats";

/// 主窗口导航事件：悬浮窗双击环形图 → 主界面切到积分统计页。
pub const NAVIGATE_EVENT: &str = "main-navigate";

const WINDOW_TITLE: &str = "积分概览";
/// 默认尺寸。
///
/// 给得比「够用」宽裕：环 116px + 右侧金额用 22px 大字，再算上每账号最多三行
/// 到期时间线，360×480 那一档会把内容压成密不透风的小字阵（用户反馈「太小、
/// 看不清」），所以直接放大到一屏能舒服地放下三个账号。
const DEFAULT_WIDTH: f64 = 440.0;
const DEFAULT_HEIGHT: f64 = 660.0;
/// 最小尺寸。无边框窗口本身没有系统 resize 边框，缩放靠前端铺在四边四角的
/// 手柄调 `startResizeDragging`（见 `CreditFloatPage`），这里只防止拖到内容
/// 挤成一团。
const MIN_WIDTH: f64 = 320.0;
const MIN_HEIGHT: f64 = 240.0;
/// 首次出现时距工作区右下角的边距（逻辑像素）。
///
/// 悬浮窗必须**显式定位**：无边框窗口若不给位置，Windows 会套用层叠默认位置，
/// 在多显示器（尤其是带负偏移 / 竖向副屏）布局下极易落到屏幕外或压在别的窗口下，
/// 用户就会「点了按钮但看不到窗」。定位到主屏工作区右下角，靠近托盘。
const RIGHT_MARGIN: f64 = 24.0;
const BOTTOM_MARGIN: f64 = 24.0;

/// 悬停预览的收起宽限（毫秒）。
///
/// 指针离开托盘图标后**不是立刻**收起：给一段宽限，让用户有机会把指针从托盘
/// 图标移到悬浮窗上（两者挨着，这点时间足够走完）。指针一旦落进窗口范围，
/// 宽限就重新计时，窗口便留住了；连续这么久都不在窗口范围内才收起。
const HOVER_HIDE_DELAY_MS: u64 = 350;

/// 悬停收起的探测间隔（毫秒）。
///
/// 用轮询光标而不是依赖前端的 `mouseleave`：悬浮窗为了不抢焦点从来不是激活窗口，
/// 未获焦点的 webview 能否稳定收到鼠标进出事件并不保证；而光标位置随时可读，
/// 一次探测的代价只是一次 `GetCursorPos`。
const HOVER_POLL_MS: u64 = 110;

/// 判定「指针在悬浮窗上」时向外放宽的物理像素。
///
/// 卡片有 8px 透明内边距，贴着边缘时的浮点误差不该被算成「已经移开」。
const HOVER_EDGE_SLACK: f64 = 6.0;

/// 当前显示的悬浮窗是否来自「指针移入托盘图标」（悬停预览）。
///
/// 只有预览态才自动收起。窗口已经被显式打开时再悬停托盘图标，也不会把它降级成
/// 预览——见 `show_or_focus` 里的来源判定。
#[cfg(desktop)]
static HOVER_PREVIEW: AtomicBool = AtomicBool::new(false);

/// 悬停预览的代次。任何改变窗口来源的动作（再次显示 / 显式打开 / 关闭）都会 +1，
/// 让先前挂起的收起轮询认领失败并退出——比维护定时器取消简单得多。
#[cfg(desktop)]
static HOVER_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 悬停预览的收起判定器。
///
/// 状态只有一项：「指针最近一次还在悬浮窗范围内」的时刻。每次探测调用一次
/// `observe`，由它判断宽限是否已经耗尽。抽成独立结构是为了能把「指针从托盘图标
/// 移向悬浮窗的那段路上不能被收掉」这个时序钉进单测。
#[cfg(any(desktop, test))]
struct HoverWatch {
    inside_since: Instant,
}

#[cfg(any(desktop, test))]
impl HoverWatch {
    fn new(now: Instant) -> Self {
        Self { inside_since: now }
    }

    /// 报告一次探测结果，返回是否该收起。
    fn observe(&mut self, pointer_inside: bool, now: Instant) -> bool {
        if pointer_inside {
            self.inside_since = now;
            return false;
        }
        now.duration_since(self.inside_since) >= Duration::from_millis(HOVER_HIDE_DELAY_MS)
    }
}

/// 悬浮窗当前是否**显示着**。
///
/// 判定的是可见性而不是「窗口对象是否存在」：悬停预览收起时只 `hide()` 不销毁
/// （下次指针移入托盘图标就能立刻显示，也不必重新拉一遍账号数据），此时窗口对象
/// 还在，但对用户而言它已经关掉了——托盘勾选与底部按钮都必须显示为关。
#[cfg(desktop)]
pub fn is_open<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    use tauri::Manager;
    app.get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 主窗口尚未挂载时暂存的跳转目标，由前端挂载后取走。
///
/// 轻量模式下主窗口可能刚被销毁，`open_credit_stats` 会把它重建出来——那一刻前端
/// 还没挂载，广播出去的事件必然收不到。目标先落在这里，前端挂载时用
/// `take_pending_nav` 取走，两条通路合起来才没有窗口期。
#[cfg(desktop)]
static PENDING_NAV: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// 悬浮窗当前是否打开。
///
/// 主窗口挂载时、以及每次切换后都读一次：窗口可能被用户用系统方式关掉，
/// 前端不能只依赖自己的乐观状态。
#[tauri::command]
pub fn get_credit_float_open(app: AppHandle) -> bool {
    #[cfg(not(desktop))]
    {
        let _ = app;
        false
    }
    #[cfg(desktop)]
    {
        is_open(&app)
    }
}

/// 打开（已存在则前置）积分概览悬浮窗。
#[tauri::command]
pub async fn open_credit_float(app: AppHandle) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = app;
        return Err("此平台不支持积分概览悬浮窗".into());
    }
    #[cfg(desktop)]
    {
        enter_pinned_mode();
        show_or_focus(&app, true, false)
    }
}

/// 悬浮窗里的环形图被双击：打开主界面并跳到积分统计页。
///
/// 主窗口可能正被轻量模式销毁着，这里统一走 `tray::show_main_window` 重建 + 前置；
/// 重建出来的那份前端还没挂载，所以先把目标暂存，再广播事件（见 `PENDING_NAV`）。
#[tauri::command]
pub fn open_credit_stats(app: AppHandle) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = app;
        return Err("此平台不支持跳转积分统计页".into());
    }
    #[cfg(desktop)]
    {
        use tauri::{Emitter, Manager};

        if app
            .get_webview_window(crate::tray::MAIN_WINDOW_LABEL)
            .is_none()
        {
            set_pending_nav(Some(CREDIT_STATS_ROUTE));
        }
        crate::tray::show_main_window(&app);
        let _ = app.emit(NAVIGATE_EVENT, CREDIT_STATS_ROUTE);
        Ok(())
    }
}

/// 取走（并清空）暂存的主窗口跳转目标。
///
/// 前端挂载时读一次；收到 `main-navigate` 事件时也读一次，顺手把暂存位清掉，
/// 免得下次重建主窗口时又跳一次。
#[tauri::command]
pub fn take_pending_nav() -> Option<String> {
    #[cfg(not(desktop))]
    {
        None
    }
    #[cfg(desktop)]
    {
        PENDING_NAV
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }
}

#[cfg(desktop)]
fn set_pending_nav(route: Option<&str>) {
    if let Ok(mut slot) = PENDING_NAV.lock() {
        *slot = route.map(str::to_string);
    }
}

/// 关闭积分概览悬浮窗（窗口不存在时视为已关闭）。
#[tauri::command]
pub async fn close_credit_float(app: AppHandle) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = app;
        return Err("此平台不支持积分概览悬浮窗".into());
    }
    #[cfg(desktop)]
    {
        hide(&app);
        Ok(())
    }
}

/// 托盘菜单项：显示 / 隐藏悬浮窗。
///
/// 托盘回调在主线程同步执行，这里直接建窗 / 关窗（与命令走同一套实现）。
#[cfg(desktop)]
pub fn toggle(app: &AppHandle) {
    if is_open(app) {
        hide(app);
    } else {
        show(app, true);
    }
}

/// 显式打开浮窗（底部按钮 / 托盘菜单 / 单击托盘图标），`focus` 决定是否抢焦点。
///
/// 悬停必须走 `show_preview`：这里会把窗口从预览态摘出来，之后移开指针不再自动收起。
#[cfg(desktop)]
pub fn show(app: &AppHandle, focus: bool) {
    enter_pinned_mode();
    if let Err(error) = show_or_focus(app, focus, false) {
        eprintln!("[credit_float] 打开积分概览悬浮窗失败: {error}");
    }
}

/// 指针移入托盘图标：以「悬停预览」显示浮窗。
///
/// 不抢焦点——用户只是把鼠标划过托盘图标，焦点不该从正在使用的窗口上被拽走。
/// `show()` 本身只做 `SWP_SHOWWINDOW`，所以不调 `set_focus` 就真的不抢焦点。
/// 预览态会在指针离开后自动收起（`on_pointer_left_tray`）。
#[cfg(desktop)]
pub fn show_preview(app: &AppHandle) {
    // 先作废挂起的收起轮询：指针又回到图标上，这次显示不该被上一次的计时器收掉。
    bump_hover_generation();
    if let Err(error) = show_or_focus(app, false, true) {
        eprintln!("[credit_float] 打开积分概览悬浮窗失败: {error}");
    }
}

/// 指针离开托盘图标：宽限期过后收起预览窗。
///
/// 轮询而不是一次性定时器——指针「从托盘图标移向悬浮窗」的路上，有一小段时间
/// 既不在图标上也不在窗上，一次性判定会在这段路上就把窗口收掉。这里改成只要
/// 指针还在窗口范围内就不断重新计时，连续 `HOVER_HIDE_DELAY_MS` 都不在窗内才收起，
/// 于是「移开就消失」和「移过去能用」同时成立。
///
/// 轮询期间只要窗口来源变了（再次悬停 / 被显式打开 / 被关闭）就自行退出。
#[cfg(desktop)]
pub fn on_pointer_left_tray(app: &AppHandle) {
    if !HOVER_PREVIEW.load(Ordering::Acquire) {
        return;
    }
    let generation = HOVER_GENERATION.load(Ordering::Acquire);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;

        let mut watch = HoverWatch::new(Instant::now());
        loop {
            tokio::time::sleep(Duration::from_millis(HOVER_POLL_MS)).await;
            if HOVER_GENERATION.load(Ordering::Acquire) != generation
                || !HOVER_PREVIEW.load(Ordering::Acquire)
            {
                return;
            }
            let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            if watch.observe(pointer_over_window(&app, &window), Instant::now()) {
                hide_preview(&app);
                return;
            }
        }
    });
}

/// 指针此刻是否落在悬浮窗（外框，含容差）上。
///
/// 两侧坐标都是**物理像素**：`cursor_position` 来自 `GetCursorPos`（虚拟屏幕原点），
/// `outer_position` 来自 `GetWindowRect`（同一坐标系），可直接比较；显示器缩放、
/// 多显示器负偏移都不会让它错位。读不到光标 / 窗口几何时按「不在窗上」处理——
/// 宁可多收一次，也不要留下一个关不掉的窗口。
#[cfg(desktop)]
fn pointer_over_window(app: &AppHandle, window: &tauri::WebviewWindow) -> bool {
    let Ok(cursor) = app.cursor_position() else {
        return false;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    pointer_within_window(cursor, position, size)
}

/// 矩形包含判定。右下边界取开区间，避免窗口贴边时把相邻像素算进来。
#[cfg(any(desktop, test))]
fn pointer_within_window(
    cursor: tauri::PhysicalPosition<f64>,
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
) -> bool {
    let left = f64::from(position.x) - HOVER_EDGE_SLACK;
    let top = f64::from(position.y) - HOVER_EDGE_SLACK;
    let right = f64::from(position.x) + f64::from(size.width) + HOVER_EDGE_SLACK;
    let bottom = f64::from(position.y) + f64::from(size.height) + HOVER_EDGE_SLACK;
    cursor.x >= left && cursor.x < right && cursor.y >= top && cursor.y < bottom
}

/// 摘掉预览标记并作废挂起的收起轮询（显式打开前的收尾）。
#[cfg(desktop)]
fn enter_pinned_mode() {
    HOVER_PREVIEW.store(false, Ordering::Release);
    bump_hover_generation();
}

#[cfg(desktop)]
fn bump_hover_generation() -> u64 {
    HOVER_GENERATION.fetch_add(1, Ordering::AcqRel) + 1
}

/// 创建或显示悬浮窗。`preview` 表示这次显示是否来自「指针移入托盘图标」。
#[cfg(desktop)]
fn show_or_focus(app: &AppHandle, focus: bool, preview: bool) -> Result<(), String> {
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        // 已经显示着就别再广播 / 重建菜单：托盘「悬停」会在指针每次进入图标时
        // 走到这里，而菜单正在展示时 `set_menu` 会让它闪掉。
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = window.show();
        if focus {
            let _ = window.set_focus();
        }
        // 本次才显示出来 → 记住来源；已经显示着又被显式打开 → 从预览态摘出来，
        // 否则「悬停过一次」会让后续的显式打开也跟着自动收起。
        if !was_visible || !preview {
            HOVER_PREVIEW.store(preview, Ordering::Release);
        }
        if !was_visible {
            let _ = app.emit(VISIBILITY_EVENT, true);
            refresh_tray(app);
        }
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(WINDOW_ENTRY.into()))
        .title(WINDOW_TITLE)
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        // 无边框 + 透明：前端画一张圆角卡片，圆角外是窗口透明区。
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(true)
        // 桌面上常驻不抢焦点，且不进任务栏 / Dock —— 与「悬浮窗」的语义一致。
        .always_on_top(true)
        .skip_taskbar(true)
        // 先以不可见创建，定位好再显示，避免默认位置闪一下。
        .visible(false)
        .build()
        .map_err(|error| format!("创建积分概览悬浮窗失败: {error}"))?;

    if let Err(error) = place_bottom_right(&window) {
        eprintln!("[credit_float] 悬浮窗定位失败: {error}");
    }

    window.show().map_err(|error| error.to_string())?;
    if focus {
        let _ = window.set_focus();
    }
    HOVER_PREVIEW.store(preview, Ordering::Release);
    let _ = app.emit(VISIBILITY_EVENT, true);
    refresh_tray(app);
    Ok(())
}

/// 悬浮窗被销毁（✕ / Alt+F4 / 系统关闭）后的收尾。
///
/// 清掉预览标记并作废挂起的收起轮询。不收拾的话，预览态下被关掉的窗口会把标记
/// 留成 `true`，之后若有一次迟到的轮询就会误广播一次「已关闭」。
#[cfg(desktop)]
pub(crate) fn on_window_closed() {
    HOVER_PREVIEW.store(false, Ordering::Release);
    bump_hover_generation();
}

/// 收起悬停预览：只 `hide()`，不销毁窗口。
///
/// 保留 WebView 有两个好处：指针再次移入托盘图标时能立刻显示（建窗要几百毫秒，
/// 悬停场景下那一下很明显），且不必重新拉一遍账号数据。`is_open` 按可见性判定，
/// 所以「隐藏」对托盘勾选与底部按钮就是「关」。
#[cfg(desktop)]
fn hide_preview(app: &AppHandle) {
    use tauri::{Emitter, Manager};

    if !HOVER_PREVIEW.swap(false, Ordering::AcqRel) {
        return;
    }
    bump_hover_generation();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit(VISIBILITY_EVENT, false);
    refresh_tray(app);
}

/// 关闭悬浮窗（销毁窗口，下次打开重新走定位）。
#[cfg(desktop)]
fn hide(app: &AppHandle) {
    use tauri::{Emitter, Manager};

    HOVER_PREVIEW.store(false, Ordering::Release);
    bump_hover_generation();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
    let _ = app.emit(VISIBILITY_EVENT, false);
    refresh_tray(app);
}

/// 让托盘菜单里的勾选状态跟上窗口的真实开关。
#[cfg(desktop)]
fn refresh_tray(app: &AppHandle) {
    crate::tray::refresh_tray_menu(app);
}

/// 把悬浮窗放到主显示器工作区的右下角（靠近系统托盘）。
///
/// 取不到显示器信息时不移动——保持系统默认位置也好过猜一个可能出屏的坐标。
#[cfg(desktop)]
fn place_bottom_right(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::LogicalPosition;

    // 主屏优先；取不到就退到「当前显示器」，再取不到就放弃定位。
    let monitor = window
        .primary_monitor()?
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };

    // work_area / 窗口尺寸都是物理像素，先按缩放因子换算成逻辑像素，
    // 再用 LogicalPosition 下发——两个显示器缩放不同时也不会错位。
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let width = DEFAULT_WIDTH;
    let height = DEFAULT_HEIGHT;

    let work_x = work.position.x as f64 / scale;
    let work_y = work.position.y as f64 / scale;
    let work_w = work.size.width as f64 / scale;
    let work_h = work.size.height as f64 / scale;

    let x = work_x + work_w - width - RIGHT_MARGIN;
    let y = work_y + work_h - height - BOTTOM_MARGIN;
    window.set_position(LogicalPosition::new(x.max(work_x), y.max(work_y)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{pointer_within_window, HoverWatch, HOVER_EDGE_SLACK, HOVER_HIDE_DELAY_MS};
    use std::time::{Duration, Instant};
    use tauri::{PhysicalPosition, PhysicalSize};

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    /// 指针离开托盘图标后一直在别处：宽限耗尽才收起。
    #[test]
    fn hover_preview_survives_the_grace_period() {
        let start = Instant::now();
        let mut watch = HoverWatch::new(start);
        assert!(
            !watch.observe(false, start + ms(HOVER_HIDE_DELAY_MS - 1)),
            "宽限没到就不该收起"
        );
        assert!(
            watch.observe(false, start + ms(HOVER_HIDE_DELAY_MS)),
            "连续离开满宽限 → 收起"
        );
    }

    /// 指针从托盘图标移向悬浮窗：落在窗口上的那一刻必须是「留下」，而不是收起。
    #[test]
    fn pointer_reaching_the_window_keeps_it_open() {
        let start = Instant::now();
        let mut watch = HoverWatch::new(start);
        let arrived = start + ms(HOVER_HIDE_DELAY_MS - 20);
        assert!(!watch.observe(true, arrived), "指针已到窗口上");
        assert!(
            !watch.observe(true, arrived + ms(HOVER_HIDE_DELAY_MS)),
            "停在窗口上多久都不会收起"
        );
    }

    /// 离开窗口后重新计时：宽限从「最后一次在窗口上」算起，不是从离开托盘图标算起。
    #[test]
    fn leaving_the_window_restarts_the_grace_period() {
        let start = Instant::now();
        let mut watch = HoverWatch::new(start);
        let left_window = start + ms(1_000);
        assert!(!watch.observe(true, left_window), "刚离开窗口时还在宽限内");
        assert!(
            !watch.observe(false, left_window + ms(HOVER_HIDE_DELAY_MS - 1)),
            "宽限要从离开窗口那一刻重新算"
        );
        assert!(watch.observe(false, left_window + ms(HOVER_HIDE_DELAY_MS)));
    }

    /// 悬停命中判定：窗口内算命中，容差外算离开，负坐标（副屏在主屏左侧）也要正确。
    #[test]
    fn pointer_hit_test_covers_window_and_slack() {
        let position = PhysicalPosition::new(-1_920, 100);
        let size = PhysicalSize::new(440u32, 660u32);
        // 窗口物理矩形：x ∈ [-1920, -1480) 、y ∈ [100, 760)，再各向外放宽 HOVER_EDGE_SLACK。
        let inside =
            |x: f64, y: f64| pointer_within_window(PhysicalPosition::new(x, y), position, size);

        assert!(inside(-1_920.0, 100.0), "左上角");
        assert!(inside(-1_481.0, 759.0), "右下角内侧");
        assert!(
            inside(-1_920.0 - HOVER_EDGE_SLACK, 100.0),
            "容差内的边外一点仍算命中"
        );
        assert!(
            !inside(-1_920.0 - HOVER_EDGE_SLACK - 1.0, 100.0),
            "超出容差就是离开"
        );
        assert!(
            !inside(-1_480.0 + HOVER_EDGE_SLACK + 1.0, 400.0),
            "右侧出界"
        );
        assert!(
            !inside(-1_700.0, 760.0 + HOVER_EDGE_SLACK + 1.0),
            "下方出界"
        );
        assert!(!inside(0.0, 0.0), "桌面另一处");
    }
}
