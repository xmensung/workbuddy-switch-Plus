import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, RefreshCw, Sparkles, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Button } from "@/components/ui/button";
import { displayName } from "@/lib/account-display";
import * as api from "@/lib/api";
import type { AccountMeta, CreditExpiry, CreditResource } from "@/lib/types";
import { CREDIT_REFRESH_INTERVAL_MS } from "@/lib/use-credit-auto-refresh";
import { useAccountsStore } from "@/stores/accounts";

/**
 * 积分概览悬浮窗。
 *
 * 独立原生窗口（label = `credit-float`，页面入口 `credit-float.html`）的内容：
 * 每个账号一枚环形图 + 一句到期提示。整圈 = 该账号**当前可用的积分**，
 * 按紧急度切成三段：
 * - 红 `--credit-expiring`：**72 小时（3 天）内**到期
 * - 橙 `--credit-soon`    ：72 小时～**7 天（168 小时）内**到期
 * - 绿 `--credit-safe`    ：更久
 *
 * 刻意只做「概览」：不展示积分包明细（那是主窗口积分统计页的事）。这一版之前
 * 环按每一笔积分包分段，一个账号常有 20+ 笔到期日，画出来是满环 1~2px 的碎色块；
 * 逐笔明细又会把卡片撑成一面墙。现在环只按紧急度分三档，文字也只提示 7 天内
 * 到期的量——看不清的信息等于没有，交给主窗口去看。
 *
 * 数据口径（对应 `credit_result` / `credit_resource` 两个后端结构）：
 * - 官方按「资源包」发放积分，每包有 total（发放量）/ remaining（剩余）/ expireAt（到期）。
 * - 可用 = Σ 未过期包的 remaining（真正能用的量）
 * - 总量 = Σ 所有包的 total（官方口径的发放总量）
 * - 已过期 = Σ 已过期包的 remaining（官方仍算在 remaining 里，但实际不可用）
 * 后端缺 `resources` 明细时退回官方汇总字段 totalCapacity / totalRemaining。
 */

const DAY_MS = 24 * 3600 * 1000;
const numberFormat = new Intl.NumberFormat("zh-CN");

/**
 * 三档紧急度。
 *
 * `urgent` = 72 小时内到期（红），`soon` = 72 小时～7 天内到期（橙），
 * `later` = 更久（绿）。
 */
type Tone = "urgent" | "soon" | "later";

/** 环上分段的绘制顺序：最紧急的那段从 12 点方向开始。 */
const TONE_ORDER: Tone[] = ["urgent", "soon", "later"];

const TONE_COLOR: Record<Tone, string> = {
  urgent: "var(--credit-expiring)",
  soon: "var(--credit-soon)",
  later: "var(--credit-safe)",
};

/**
 * 两档到期窗口。
 *
 * 官方给的 `expireAt` 是**到期日当天 00:00**，所以在真实数据上
 * 「距今天数 = N」等价于「距该时刻约 N×24 小时」：`daysUntil === 7` 恰好落在
 * 168 小时边界内。用整天判定既符合数据粒度，也不会出现「同一屏两种天数口径」。
 */
const URGENT_HOURS = 72;
const SOON_HOURS = 168;
const URGENT_DAYS = URGENT_HOURS / 24; // 3 天
const SOON_DAYS = SOON_HOURS / 24; // 7 天

const TONE_LEGEND: { tone: Tone; label: string; hint: string }[] = [
  { tone: "urgent", label: "72 小时内到期", hint: `${URGENT_HOURS} 小时（${URGENT_DAYS} 天）内到期` },
  { tone: "soon", label: "7 天内到期", hint: `${SOON_HOURS} 小时（${SOON_DAYS} 天）内到期` },
  { tone: "later", label: "其余可用", hint: "7 天以后才到期" },
];

function toneOf(expireAt: number | null, now: number): Tone {
  if (expireAt === null) return "later";
  // 整天口径：今天到期 = 0 天。
  const days = daysUntil(expireAt, now);
  if (days <= URGENT_DAYS) return "urgent";
  if (days <= SOON_DAYS) return "soon";
  return "later";
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `MM-DD`；跨年时补上年份，避免把明年看成今年。 */
function formatDate(ts: number, now: number): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const md = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return sameYear ? md : `${date.getFullYear()}-${md}`;
}

/** 「3 天后」/「今天到期」/「已过期 2 天」。同样按整天算。 */
function formatLeft(ts: number, now: number): string {
  const days = daysUntil(ts, now);
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天后`;
}

/** `HH:MM:SS`——刷新时间要秒级，否则连点两次刷新看不出有什么区别。 */
function formatClock(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 环上的一段。 */
interface Segment {
  tone: Tone;
  amount: number;
}

/** 72 小时～7 天内某一天到期的积分合计。 */
interface SoonBucket {
  key: string;
  amount: number;
  expireAt: number;
}

/** 72 小时内到期的一笔积分包（一个包一条，同名的也不合并）。 */
interface UrgentEntry {
  key: string;
  amount: number;
  expireAt: number;
  /** 积分包名；缺失时由界面回退成「积分包」。 */
  label: string | null;
}

interface AccountSummary {
  usable: number;
  /** 72 小时内到期的积分合计（环上红段）。 */
  urgentAmount: number;
  /** 72 小时～7 天内到期的积分合计（环上橙段，不含红段）。 */
  soonAmount: number;
  /** 7 天内到期的每一天，最近的在前（不含 72 小时内那档）。 */
  soonBuckets: SoonBucket[];
  /** 72 小时内到期的积分包，最早的在前；空数组表示没有「火烧眉毛」的。 */
  urgent: UrgentEntry[];
  segments: Segment[];
}

const EMPTY_SUMMARY: AccountSummary = {
  usable: 0,
  urgentAmount: 0,
  soonAmount: 0,
  soonBuckets: [],
  urgent: [],
  segments: [],
};

/**
 * 该积分包是否已经失效。
 *
 * 按**整天**判定，不是按时刻：官方给的 `expireAt` 是**到期日当天 00:00**，
 * 直接拿它跟当前时刻比较的话，从当天零点起这一笔就会被判成「已过期」而整笔剔除
 * （既不计入可用积分，也不在「3 天内到期」里露面）——「今天到期」这一天恰恰是
 * 最该看到它的时刻却在界面上消失。
 *
 * 所以到期日当天仍然算可用，过了到期日次日零点才失效。
 */
function isExpired(resource: CreditResource, now: number): boolean {
  if (resource.expireAt !== null && resource.expireAt !== undefined) {
    return startOfDay(resource.expireAt) + DAY_MS <= startOfDay(now);
  }
  return resource.expired === true;
}

/** 该时间戳所在自然日的零点（本机时区）。 */
function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 距离到期日还剩几个整天：今天到期 = 0。 */
function daysUntil(expireAt: number, now: number): number {
  return Math.round((startOfDay(expireAt) - startOfDay(now)) / DAY_MS);
}

function summarize(credit: CreditExpiry | undefined, now: number): AccountSummary {
  if (!credit || credit.ok === false) return EMPTY_SUMMARY;

  const resources = Array.isArray(credit.resources) ? credit.resources : [];
  if (resources.length === 0) {
    // 旧后端 / 未返回明细：退回官方汇总字段，至少把数字显示对。
    const usable = credit.totalRemaining ?? 0;
    // 官方没给逐笔到期日，只能把 expiringSoonRemaining 整体算进橙档（7 天内）。
    const soon = Math.min(credit.expiringSoonRemaining ?? 0, usable);
    const segments: Segment[] = [];
    if (soon > 0) segments.push({ tone: "soon", amount: soon });
    if (usable - soon > 0) segments.push({ tone: "later", amount: usable - soon });
    return {
      usable,
      urgentAmount: 0,
      soonAmount: soon,
      soonBuckets: [],
      // 没有 resources 就不知道是哪几笔、各自多少，只能给汇总。
      urgent: [],
      segments,
    };
  }

  let usable = 0;
  const byTone: Record<Tone, number> = { urgent: 0, soon: 0, later: 0 };
  const byExpiry = new Map<number, number>();
  const urgent: UrgentEntry[] = [];

  for (const resource of resources) {
    const remaining = resource.remaining ?? 0;
    if (isExpired(resource, now)) continue;
    usable += remaining;
    if (remaining <= 0) continue;
    const expireAt = resource.expireAt ?? null;
    const tone = toneOf(expireAt, now);
    byTone[tone] += remaining;
    if (expireAt === null) continue;
    if (tone === "urgent") {
      // 72 小时内到期的逐笔留下，不按到期日合并——用户要看的是「哪几笔、各多少」。
      urgent.push({
        key: `${expireAt}-${resource.packageCode ?? ""}-${resource.packageName ?? ""}-${urgent.length}`,
        amount: remaining,
        expireAt,
        label: resource.packageName ?? resource.packageCode ?? null,
      });
    } else if (tone === "soon") {
      byExpiry.set(expireAt, (byExpiry.get(expireAt) ?? 0) + remaining);
    }
  }
  urgent.sort((a, b) => a.expireAt - b.expireAt);

  const segments: Segment[] = TONE_ORDER.filter((tone) => byTone[tone] > 0).map((tone) => ({
    tone,
    amount: byTone[tone],
  }));

  // 同一天到期的多笔合并成一句提示，最近的排前面。
  const soonBuckets: SoonBucket[] = [...byExpiry.entries()]
    .map(([expireAt, amount]) => ({ key: String(expireAt), amount, expireAt }))
    .sort((a, b) => a.expireAt - b.expireAt);

  return {
    usable,
    urgentAmount: byTone.urgent,
    soonAmount: byTone.soon,
    soonBuckets,
    urgent,
    segments,
  };
}

/**
 * 悬浮窗是无边框 + 透明的：把 html / body / #root 的底色清掉，
 * 只让卡片本身可见（否则圆角外会露出 body 的 `bg-background`）。
 */
function useTransparentChrome() {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    const previous = {
      html: html.style.background,
      body: body.style.background,
      bodyMinWidth: body.style.minWidth,
      root: root?.style.background ?? "",
    };
    html.style.background = "transparent";
    body.style.background = "transparent";
    body.style.minWidth = "0";
    if (root) root.style.background = "transparent";
    return () => {
      html.style.background = previous.html;
      body.style.background = previous.body;
      body.style.minWidth = previous.bodyMinWidth;
      if (root) root.style.background = previous.root;
    };
  }, []);
}

/**
 * 无边框窗口没有系统标题栏，整张卡片都必须能拖。
 *
 * 只在标题栏挂 `data-tauri-drag-region` 的话，用户按住卡片正文拖拽是没有反应的。
 * 这里在卡片容器上补一条手动拖动：命中交互元素（按钮 / 链接 / 输入）、缩放手柄
 * 或标注了 `data-no-drag` 的区域（可双击的环形图）时放行，其余位置一律触发原生
 * `startDragging`。
 *
 * `data-no-drag` 不是为了好看：`startDragging` 会在按下时进入系统级的模态拖动循环，
 * 鼠标抬起根本回不到 webview，双击事件就永远凑不齐——把环形图排除在拖动之外，
 * 它才可能被双击到。
 */
function useWindowDrag() {
  return useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest(
        "button, a, input, select, textarea, [data-tauri-drag-region], [data-resize-handle], [data-no-drag]",
      )
    ) {
      return;
    }
    try {
      // 非 Tauri 宿主（WebUI / 纯浏览器）没有原生窗口可拖，静默忽略即可。
      void getCurrentWindow().startDragging().catch(() => undefined);
    } catch {
      /* getCurrentWindow 在缺少 Tauri 运行时环境时同步抛错。 */
    }
  }, []);
}

/** 原生缩放的 8 个方向。`@tauri-apps/api/window` 只声明未导出该类型，这里照抄一份。 */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

/**
 * 缩放手柄。
 *
 * `decorations(false)` 的窗口**没有系统 resize 边框**——`resizable(true)` 只是
 * 允许改变尺寸，用户却找不着可以下手的边。所以在窗口四边四角铺 8 条透明手柄，
 * 按住就调原生 `startResizeDragging`，这才叫「能自由拉动大小」。
 */
const RESIZE_HANDLES: { direction: ResizeDirection; className: string }[] = [
  { direction: "North", className: "left-2.5 right-2.5 top-0 h-1.5 cursor-ns-resize" },
  { direction: "South", className: "left-2.5 right-2.5 bottom-0 h-1.5 cursor-ns-resize" },
  { direction: "West", className: "top-2.5 bottom-2.5 left-0 w-1.5 cursor-ew-resize" },
  { direction: "East", className: "top-2.5 bottom-2.5 right-0 w-1.5 cursor-ew-resize" },
  { direction: "NorthWest", className: "left-0 top-0 size-3 cursor-nwse-resize" },
  { direction: "NorthEast", className: "right-0 top-0 size-3 cursor-nesw-resize" },
  { direction: "SouthWest", className: "left-0 bottom-0 size-3 cursor-nesw-resize" },
  { direction: "SouthEast", className: "right-0 bottom-0 size-3 cursor-nwse-resize" },
];

function ResizeHandles() {
  return (
    <>
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          data-resize-handle
          aria-hidden="true"
          className={`absolute z-20 ${handle.className}`}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            // 必须拦住冒泡，否则会同时触发整卡拖动。
            event.preventDefault();
            event.stopPropagation();
            try {
              void getCurrentWindow().startResizeDragging(handle.direction).catch(() => undefined);
            } catch {
              /* 非 Tauri 宿主没有原生窗口可缩放。 */
            }
          }}
        />
      ))}
    </>
  );
}

/**
 * 环形图：整圈 = 可用积分。
 *
 * 红段 = 72 小时内到期，橙段 = 72 小时～7 天内到期，绿段 = 更久。
 * 环心显示可用数额——它是这个窗口唯一的主角，放在最中间一眼就能读到。
 */
function CreditRing({ segments, usable, label }: { segments: Segment[]; usable: number; label: string }) {
  const size = 116;
  const stroke = 15;
  const center = size / 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, segment) => sum + segment.amount, 0);

  let cursor = 0;
  const gap = segments.length > 1 ? 3 : 0;
  const arcs = segments.map((segment) => {
    const length = total > 0 ? circumference * (segment.amount / total) : 0;
    const visible = Math.max(0, length - gap);
    const arc = {
      tone: segment.tone,
      dash: `${visible} ${Math.max(0, circumference - visible)}`,
      offset: -cursor,
    };
    cursor += length;
    return arc;
  });

  const text = numberFormat.format(Math.round(usable));
  // 位数不定，按长度收字号，保证 6 位数也塞得进内圈。
  const fontSize = text.length <= 4 ? 23 : text.length <= 6 ? 19 : 16;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${label}：可用积分 ${text}。双击查看积分统计详情`}
      className="shrink-0"
    >
      <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
      <g transform={`rotate(-90 ${center} ${center})`}>
        {arcs.map((arc) => (
          <circle
            key={arc.tone}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={TONE_COLOR[arc.tone]}
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={arc.dash}
            strokeDashoffset={arc.offset}
          />
        ))}
      </g>
      <text
        x={center}
        y={center - 7}
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        style={{ fontSize, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
      >
        {text}
      </text>
      <text
        x={center}
        y={center + fontSize * 0.75}
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--muted-foreground)"
        style={{ fontSize: 11 }}
      >
        可用积分
      </text>
    </svg>
  );
}

/**
 * 到期提示。
 *
 * - 7 天内没有到期的：`7 天内没有到期的积分`（灰）。
 * - **72 小时内**到期的：红字合计 + 最近的到期时间；多于一笔时逐笔列出
 *   「金额 · 包名 · MM-DD 到期 · N 天后」——这是真正火烧眉毛的部分。
 * - **72 小时～7 天内**到期的：橙字合计 + 最近的到期时间（不铺明细，
 *   「具体哪个包」归主窗口的积分统计页）。
 *
 * 两档可以同时出现：上面红、下面橙。
 */
function SoonNotice({ summary, now }: { summary: AccountSummary; now: number }) {
  const { urgentAmount, soonAmount, urgent, soonBuckets } = summary;
  const nearestUrgent = urgent[0];
  const nearestSoon = soonBuckets[0];

  if (urgentAmount + soonAmount <= 0) {
    return <p className="mt-1.5 text-[13.5px] text-muted-foreground">7 天内没有到期的积分</p>;
  }

  return (
    <div className="mt-1.5 space-y-1">
      {urgentAmount > 0 && nearestUrgent ? (
        <div>
          <p className="flex items-center gap-1.5 text-[14px] font-medium text-[var(--credit-expiring)]">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            {numberFormat.format(Math.round(urgentAmount))} 将在 72 小时内到期
          </p>
          {urgent.length > 1 ? (
            <ul className="mt-0.5">
              {urgent.map((entry) => (
                <li key={entry.key} className="flex items-baseline gap-1.5 text-[13px]">
                  <span className="shrink-0 font-medium tabular-nums text-[var(--credit-expiring)]">
                    {numberFormat.format(Math.round(entry.amount))}
                  </span>
                  {/* 包名先让位：数字和到期日才是这行必须读到的信息。 */}
                  {entry.label ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={entry.label}>
                      {entry.label}
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1" />
                  )}
                  <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatDate(entry.expireAt, now)} 到期 · {formatLeft(entry.expireAt, now)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            // 只有一笔时不必再列一遍，直接标出最近的到期时间。
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {formatDate(nearestUrgent.expireAt, now)} 到期 · {formatLeft(nearestUrgent.expireAt, now)}
            </p>
          )}
        </div>
      ) : null}

      {soonAmount > 0 ? (
        <div>
          <p className="flex items-center gap-1.5 text-[14px] font-medium text-[var(--credit-soon)]">
            <Clock className="size-3.5 shrink-0" aria-hidden="true" />
            {numberFormat.format(Math.round(soonAmount))} 将在 7 天内到期
          </p>
          {nearestSoon ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {formatDate(nearestSoon.expireAt, now)} 到期 · {formatLeft(nearestSoon.expireAt, now)}
              {soonBuckets.length > 1 ? `，另有 ${soonBuckets.length - 1} 个到期日` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function CreditFloatPage() {
  useTransparentChrome();
  const onDragStart = useWindowDrag();

  const accounts = useAccountsStore((s) => s.accounts);
  const creditMap = useAccountsStore((s) => s.creditMap);
  const fetchAll = useAccountsStore((s) => s.fetchAll);
  const ensureCredits = useAccountsStore((s) => s.ensureCredits);
  const refreshCredits = useAccountsStore((s) => s.refreshCredits);
  const [refreshing, setRefreshing] = useState(false);
  /** 手动刷新完成的本机时刻；为 `null` 时退回后端给的 `updatedAt`。 */
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // 账号集合变化（首挂载 / 新增账号）时补齐还没有缓存的积分。
  useEffect(() => {
    const ids = accounts.map((account) => account.id);
    if (ids.length > 0) void ensureCredits(ids);
  }, [accounts, ensureCredits]);

  // 后台定时刷新：与应用内保持同一节流下限，避免密集请求官方接口。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const ids = useAccountsStore.getState().accounts.map((account) => account.id);
      if (ids.length > 0) void useAccountsStore.getState().refreshCredits(ids, { silent: true });
    }, CREDIT_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  // 到期倒计时按天变化，没必要做成秒级 tick；每小时重算一次足以让「今天到期」及时翻面。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const summaries = useMemo(() => {
    const map = new Map<string, AccountSummary>();
    for (const account of accounts) map.set(account.id, summarize(creditMap[account.id], now));
    return map;
  }, [accounts, creditMap, now]);

  const totalUsable = useMemo(() => {
    let total = 0;
    for (const summary of summaries.values()) total += summary.usable;
    return total;
  }, [summaries]);

  /**
   * 后端给出的最近一次取数时刻。
   *
   * 手动刷新之外还有两条路会更新数据（窗口打开时的补齐、30 分钟后台刷新），
   * 它们没有本机时间戳，用各账号 `updatedAt` 的最大值才不会把「上次刷新」显示成
   * 之前那次手动刷新。
   */
  const lastSyncedAt = useMemo(() => {
    let newest = 0;
    for (const credit of Object.values(creditMap)) {
      if (!credit || credit.ok === false) continue;
      if (typeof credit.updatedAt === "number") newest = Math.max(newest, credit.updatedAt);
    }
    return newest || null;
  }, [creditMap]);

  const shownRefreshedAt = refreshedAt ?? lastSyncedAt;

  async function onRefresh() {
    const ids = useAccountsStore.getState().accounts.map((account) => account.id);
    if (ids.length === 0) return;
    setRefreshing(true);
    try {
      // 单账号失败会在 store 内落成 `ok: false`（卡片上显示原因），这里只兜住整体异常。
      await refreshCredits(ids);
      const at = Date.now();
      setNow(at);
      setRefreshedAt(at);
    } catch {
      /* 浮窗没有 Toaster：失败态由各账号卡片自身呈现。 */
    } finally {
      setRefreshing(false);
    }
  }

  async function onClose() {
    try {
      await api.closeCreditFloat();
    } catch {
      /* 窗口已经在关闭路径上，失败无需打扰用户。 */
    }
  }

  return (
    <div onMouseDown={onDragStart} className="relative h-screen w-screen p-2.5 text-[15px]">
      <ResizeHandles />

      <div
        onMouseDown={onDragStart}
        className="flex h-full w-full select-none flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-xl"
      >
        <header className="flex items-center gap-2 px-4 pb-2.5 pt-3">
          <Sparkles className="size-4 text-[var(--credit-safe)]" aria-hidden="true" />
          <span className="text-[15px] font-semibold tracking-tight">积分概览</span>
          <div className="ml-auto flex items-center gap-1">
            {/* 刷新时间贴在最右侧按钮旁：按一下刷新，这里立刻变成新的时刻。 */}
            {refreshing ? (
              <span className="mr-0.5 whitespace-nowrap text-[11.5px] text-muted-foreground">
                刷新中…
              </span>
            ) : shownRefreshedAt ? (
              <span
                className="mr-0.5 whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground"
                title="积分数据的最近刷新时间"
              >
                {formatClock(shownRefreshedAt)} 刷新
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="刷新积分"
              onClick={() => void onRefresh()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="关闭悬浮窗"
              onClick={() => void onClose()}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* 汇总行：合计可用 + 图例。 */}
        <div className="space-y-2 border-y border-border bg-muted/40 px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">合计可用</span>
            <span className="text-[19px] font-semibold leading-none tabular-nums">
              {numberFormat.format(Math.round(totalUsable))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {TONE_LEGEND.map((entry) => (
              <span
                key={entry.tone}
                className="flex items-center gap-1.5 text-muted-foreground"
                title={entry.hint}
              >
                <span
                  className="size-2.5 rounded-full"
                  style={{ background: TONE_COLOR[entry.tone] }}
                  aria-hidden="true"
                />
                {entry.label}
              </span>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {accounts.length === 0 ? (
            <p className="px-1 py-10 text-center text-muted-foreground">
              账号库里还没有账号，先在主窗口添加。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  credit={creditMap[account.id]}
                  summary={summaries.get(account.id) ?? EMPTY_SUMMARY}
                  now={now}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountRow({
  account,
  credit,
  summary,
  now,
}: {
  account: AccountMeta;
  credit: CreditExpiry | undefined;
  summary: AccountSummary;
  now: number;
}) {
  const failed = credit ? credit.ok === false : false;

  /**
   * 双击环形图 → 打开主界面并切到积分统计页。
   *
   * 环上标了 `data-no-drag`：整个卡片是可拖的，不排除掉的话按下的瞬间就进了
   * 系统级拖动循环，双击永远凑不齐（见 `useWindowDrag`）。
   */
  async function onOpenStats() {
    try {
      await api.openCreditStats();
    } catch {
      /* 非桌面宿主没有主界面可跳。 */
    }
  }

  return (
    <li className="rounded-xl px-3 py-3.5">
      <div className="flex items-center gap-4">
        <div
          data-no-drag
          title="双击查看该账号的积分统计详情"
          onDoubleClick={() => void onOpenStats()}
          className="shrink-0 cursor-pointer rounded-full transition-transform hover:scale-[1.03] active:scale-95"
        >
          <CreditRing
            segments={failed ? [] : summary.segments}
            usable={failed ? 0 : summary.usable}
            label={displayName(account)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold" title={displayName(account)}>
            {displayName(account)}
          </p>
          {failed ? (
            <p className="mt-1.5 truncate text-[13.5px] text-muted-foreground">
              {credit?.error ? `读取失败：${credit.error}` : "暂未取到积分"}
            </p>
          ) : !credit ? (
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">查询中…</p>
          ) : (
            <SoonNotice summary={summary} now={now} />
          )}
        </div>
      </div>
    </li>
  );
}
