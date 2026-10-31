// 积分概览悬浮窗渲染冒烟：注入假的 Tauri IPC，用真实 Chromium 打开
// credit-float.html，逐条确认：
//   1. 环形图分三档（红 = 72 小时内到期，橙 = 72h~7 天，绿 = 其余）、环心金额；
//   2. 72 小时内到期的积分逐笔列出（金额 · 包名 · 到期日 · N 天后），
//      并标出最近的到期时间；72h 外 7 天内的只给合计 + 最近到期日；
//   3. 8 向缩放手柄都调到原生 startResizeDragging；
//   4. 右上角刷新后贴出刷新时间；
//   5. 双击环形图调用 open_credit_stats（且环上的按下不会触发窗口拖动）。
// 最后落一张截图。
import { chromium } from "file:///C:/Users/X/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";

const EXE = process.env.CHROME_PATH;
const URL_UNDER_TEST = process.env.TARGET_URL || "http://127.0.0.1:8099/credit-float.html";
const OUT = process.env.OUT_PNG || "float-verify.png";

const DAY = 24 * 3600 * 1000;
const now = Date.now();
// 后端给的是「一小时前取的数」，这样手动刷新后的时间戳能明显区分出来。
const BACKEND_FETCHED_AT = now - 3600 * 1000;

const account = (id, nickname, email) => ({
  id,
  uid: id.toUpperCase(),
  email,
  nickname,
  phoneNumber: null,
  note: null,
  displayField: null,
  enterpriseName: null,
  expiresAt: null,
  refreshExpiresAt: null,
  refreshedAt: null,
  createdAt: null,
  needsRelogin: false,
  needsReloginReason: null,
  variant: "cn",
});

const ACCOUNTS = [
  account("acc-1", "梦森", "mengsen@example.com"),
  account("acc-2", "19081287917", "phone@example.com"),
  account("acc-3", "Work", "work@example.com"),
  account("acc-4", "读取失败的号", "broken@example.com"),
];

const pkg = (packageName, total, remaining, used, expireAt) => ({
  packageCode: packageName,
  packageName,
  total,
  remaining,
  used,
  status: 1,
  expireAt,
  expired: expireAt !== null && expireAt <= now,
  expiringSoon: expireAt !== null && expireAt > now && expireAt - now <= 7 * DAY,
});

const CREDITS = {
  // 19 笔不同到期日 —— 真实账号的典型形态。其中 7 笔在 7 天内：
  // 前 3 笔（1/2/3 天 = 90 + 95 + 100 = 285）落在 72 小时内 → 红档、逐笔列出；
  // 5/6/7 天共 3 笔（105 + 110 + 115 = 330）落在 72h~7 天 → 橙档、只给合计。
  "acc-1": (() => {
    const offsets = [1, 2, 3, 5, 6, 7, 12, 15, 18, 20, 25, 28, 30, 40, 60, 80, 90, 120, 180];
    const resources = offsets.map((days, index) => {
      const total = 200;
      const remaining = 90 + index * 5;
      return pkg(`资源包 ${index + 1}`, total, remaining, total - remaining, now + days * DAY);
    });
    const usable = resources.reduce((sum, item) => sum + item.remaining, 0);
    return {
      ok: true,
      accountId: "acc-1",
      updatedAt: BACKEND_FETCHED_AT,
      totalCapacity: 200 * offsets.length,
      totalRemaining: usable,
      expiredRemaining: 0,
      resources,
    };
  })(),
  // 两笔都在 3 天内（今天到期 + 2 天后），逐笔列出；右侧另有 120 天的一笔不算急。
  "acc-2": {
    ok: true,
    accountId: "acc-2",
    updatedAt: BACKEND_FETCHED_AT,
    totalCapacity: 7000,
    totalRemaining: 4800,
    expiredRemaining: 0,
    resources: [
      pkg("基础版资源包", 3000, 2200, 800, now),
      pkg("活动赠送包", 3000, 2000, 1000, now + 2 * DAY),
      pkg("年度礼包", 1000, 600, 400, now + 120 * DAY),
    ],
  },
  // 7 天内没有到期（20 天 / 200 天），另有一笔已过期残余 200。
  "acc-3": {
    ok: true,
    accountId: "acc-3",
    updatedAt: BACKEND_FETCHED_AT,
    totalCapacity: 4500,
    totalRemaining: 3250,
    expiredRemaining: 200,
    resources: [
      pkg("基础版资源包", 3000, 2500, 500, now + 20 * DAY),
      pkg("年度礼包", 1000, 550, 450, now + 200 * DAY),
      pkg("已过期旧包", 500, 200, 300, now - 12 * DAY),
    ],
  },
  "acc-4": { ok: false, error: "token 已失效，请重新登录" },
};

const INIT = `
  window.__resizeCalls = [];
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "credit-float" },
      currentWebview: { label: "credit-float", windowLabel: "credit-float" },
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      window.__calls.push(cmd);
      if (cmd === "plugin:window|start_resize_dragging") { window.__resizeCalls.push(args); return null; }
      if (cmd === "plugin:window|start_dragging") { window.__resizeCalls.push("DRAG"); return null; }
      if (cmd === "get_accounts") return { accounts: ${JSON.stringify(ACCOUNTS)} };
      if (cmd === "get_status") return {};
      if (cmd === "get_credit_expiry") return ${JSON.stringify(CREDITS)}[args && args.accountId] || { ok: false, error: "无数据" };
      if (cmd === "get_credit_float_open") return true;
      if (cmd === "open_credit_float" || cmd === "close_credit_float") return null;
      if (cmd === "open_credit_stats") return null;
      if (cmd === "take_pending_nav") return null;
      return null;
    },
  };
`;

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const context = await browser.newContext({
  viewport: { width: 440, height: 660 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
await context.addInitScript(INIT);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`console: ${m.text()}`);
});

await page.goto(URL_UNDER_TEST, { waitUntil: "networkidle" });
await page.waitForSelector('svg[role="img"]', { timeout: 10000 });
await page.waitForTimeout(500);

const clockOf = (text) => (text.match(/(\d{2}:\d{2}:\d{2})\s*刷新/) || [])[1] || null;
const headerText = () => page.locator("header").innerText();

// 打开时贴的是后端给的取数时刻（一小时前）。
const clockOnOpen = clockOf(await headerText());

await page.screenshot({ path: OUT, omitBackground: true });

// 逐个按下 8 条缩放手柄，确认每条都调到了原生 startResizeDragging（带方向）。
const handleCount = await page.locator("[data-resize-handle]").count();
for (let i = 0; i < handleCount; i += 1) {
  await page.locator("[data-resize-handle]").nth(i).dispatchEvent("mousedown", { button: 0 });
  await page.waitForTimeout(60);
}

// 环形图上按下：必须被 data-no-drag 豁免，不能触发窗口拖动（否则双击凑不齐）。
await page.locator("[data-no-drag]").first().dispatchEvent("mousedown", { button: 0 });
await page.waitForTimeout(120);
const dragAfterRingPress = (await page.evaluate(() => window.__resizeCalls)).includes("DRAG");

// 双击环形图：应调用 open_credit_stats。
await page.locator("[data-no-drag]").first().dblclick();
await page.waitForTimeout(400);
const callsAfterDoubleClick = await page.evaluate(() => window.__calls.slice());
const openedStats = callsAfterDoubleClick.includes("open_credit_stats");

// 点刷新：右上角应贴出**新的**刷新时间。
await page.locator('button[aria-label="刷新积分"]').click();
await page.waitForTimeout(800);
const clockAfterRefresh = clockOf(await headerText());

const snapshot = await page.evaluate(() => ({
  title: document.title,
  handles: document.querySelectorAll("[data-resize-handle]").length,
  resizeCalls: window.__resizeCalls,
  rings: [...document.querySelectorAll('svg[role="img"]')].map((svg) => ({
    aria: svg.getAttribute("aria-label"),
    arcs: [...svg.querySelectorAll("g circle")].map((c) => ({
      stroke: c.getAttribute("stroke"),
      dash: c.getAttribute("stroke-dasharray"),
    })),
    center: [...svg.querySelectorAll("text")].map((t) => t.textContent).join(" / "),
  })),
  // 每个账号的到期提示整块文本（含逐笔明细），用于确认「3 天内」的写法。
  notices: [...document.querySelectorAll("li")].map((li) => {
    const name = li.querySelector("p");
    return {
      account: name ? name.textContent : "",
      lines: [...li.querySelectorAll("p, li li, ul li")].map((node) => node.textContent.trim()),
    };
  }),
  bodyText: (document.body.innerText || "").replace(/\s+/g, " "),
}));

await browser.close();
console.log(
  JSON.stringify(
    {
      snapshot,
      refreshClock: { onOpen: clockOnOpen, afterRefresh: clockAfterRefresh },
      doubleClick: { openedStats, dragAfterRingPress, callsAfterDoubleClick },
      errors,
    },
    null,
    2,
  ),
);
