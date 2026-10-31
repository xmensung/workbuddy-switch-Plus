// TEMP-VERIFY: 用 WebView2 远程调试协议读取真实窗口的 DOM，验证：
//   1) 各窗口的 label / URL / 正文（确认 Agent Companion 悬浮栏已不再回退成主界面）
//   2) 点击底部 ✦ 后，credit-float 窗口是否出现，且渲染的是环形图页面
// 用完即删。
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = 9555;
const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error("用法: node verify.mjs <wb-switch-rust.exe>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    const list = await r.json();
    return Array.isArray(list) ? list.filter((t) => t.type === "page") : [];
  } catch {
    return null;
  }
}

async function waitTargets(_min = 1, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const t = (await listTargets()) ?? [];
    if (t.length) last = t;
    const real = t.filter((x) => x.url && !x.url.startsWith("about:"));
    if (real.length) return t;
    await sleep(1500);
  }
  return last;
}

function evaluate(wsUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      resolve(v);
    };
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        if (msg.result?.exceptionDetails) return finish({ error: String(msg.result.exceptionDetails.text) });
        finish({ value: msg.result?.result?.value });
      } catch (e) {
        finish({ error: String(e) });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish({ error: "ws-error" });
    };
  });
}

const PROBE = `JSON.stringify({
  href: location.href,
  label: (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label) || null,
  title: document.title,
  hasFloatBtn: !!document.querySelector('[aria-label="积分悬浮窗"]'),
  floatingToggleOn: document.querySelector('[aria-label="积分悬浮窗"]')?.getAttribute('data-state') ?? null,
  rings: document.querySelectorAll('[aria-label^="可使用积分占比"]').length,
  text: (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200)
})`;

async function dump(tag, targets) {
  console.log(`\n===== ${tag}：共 ${targets.length} 个页面 target =====`);
  for (const t of targets) {
    const r = await evaluate(t.webSocketDebuggerUrl, PROBE);
    let info;
    try {
      info = r.value ? JSON.parse(r.value) : r;
    } catch {
      info = r;
    }
    console.log(`- title=${JSON.stringify(t.title)} url=${JSON.stringify(t.url)}`);
    console.log(`  label=${JSON.stringify(info?.label)} rings=${info?.rings} hasFloatBtn=${info?.hasFloatBtn}`);
    console.log(`  text=${JSON.stringify(info?.text)}`);
  }
}

// 旧实例由外部脚本清理（本沙箱禁止同步子进程）。
await sleep(500);

const logFd = fs.openSync("verify-app.log", "w");
const child = spawn(EXE, [], {
  cwd: EXE.replace(/[\\/][^\\/]+$/, ""),
  detached: false,
  stdio: ["ignore", logFd, logFd],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    http_proxy: "",
    HTTP_PROXY: "",
    https_proxy: "",
    HTTPS_PROXY: "",
  },
});
console.log("已启动 exe, pid =", child.pid);

let targets = await waitTargets(1, 90000);
await sleep(5000);
targets = (await listTargets()) ?? targets;
await dump("启动后", targets);

// 找到主窗口 target 并点击 ✦
const main = targets.find(
  (t) => t.url && !t.url.startsWith("about:") && t.url !== "about:blank",
);
if (!main) {
  console.log("\n!! 未找到主窗口 target，无法点击");
} else {
  const r = await evaluate(
    main.webSocketDebuggerUrl,
    `(() => { const b = document.querySelector('[aria-label="积分悬浮窗"]'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`,
  );
  console.log("\n点击 ✦ 结果:", JSON.stringify(r));
  await sleep(7000);
  const after = (await listTargets()) ?? [];
  await dump("点击后", after);
}

await sleep(500);
try {
  child.kill();
} catch {}
console.log("\n完成");
process.exit(0);
