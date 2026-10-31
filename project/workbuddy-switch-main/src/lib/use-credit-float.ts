import { useCallback, useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import * as api from "@/lib/api";

/**
 * 积分悬浮窗的打开状态（主窗口侧）。
 *
 * 状态以后端为准：窗口可能被用户用系统方式（关闭按钮 / Alt+F4 / 焦点丢失时的
 * 系统行为）关掉，前端只做乐观更新会失真。因此：
 * - 首个订阅者挂载时读一次后端；
 * - 后端在每次开 / 关时广播 `credit-float-visibility`，主窗口据此同步；
 * - 切换动作完成后延迟再校准一次，兜住事件丢失的场景。
 */
type CreditFloatState = {
  /** null 表示尚未从后端读到（按钮按不可用渲染）。 */
  open: boolean | null;
  busy: boolean;
  error: string | null;
};

const VISIBILITY_EVENT = "credit-float-visibility";

let state: CreditFloatState = { open: null, busy: false, error: null };
const subscribers = new Set<() => void>();
let unlisten: (() => void) | undefined;
let generation = 0;

function publish(next: CreditFloatState) {
  state = next;
  for (const subscriber of subscribers) subscriber();
}

async function refresh(current = generation) {
  try {
    const open = await api.getCreditFloatOpen();
    if (current === generation) publish({ ...state, open, error: null });
  } catch (error) {
    if (current === generation) publish({ ...state, error: api.asError(error) });
  }
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  if (subscribers.size === 1) {
    const current = ++generation;
    void refresh(current);
    void listen<boolean>(VISIBILITY_EVENT, (event) => {
      if (current === generation) publish({ ...state, open: event.payload, error: null });
    })
      .then((stop) => {
        if (current === generation) unlisten = stop;
        else stop();
      })
      .catch(() => {
        /* 非 Tauri 宿主（WebUI）没有事件通道：状态由 getCreditFloatOpen 决定。 */
      });
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      generation += 1;
      unlisten?.();
      unlisten = undefined;
    }
  };
}

function getSnapshot() {
  return state;
}

export function useCreditFloat(): CreditFloatState & {
  toggle: () => Promise<void>;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const toggle = useCallback(async () => {
    if (state.busy || state.open === null) return;
    const next = !state.open;
    publish({ ...state, busy: true, error: null });
    try {
      if (next) await api.openCreditFloat();
      else await api.closeCreditFloat();
      publish({ open: next, busy: false, error: null });
    } catch (error) {
      publish({ ...state, busy: false, error: api.asError(error) });
      throw error;
    } finally {
      // 事件之外的兜底校准：窗口创建 / 销毁是异步的，稍后再对齐一次真实状态。
      const current = generation;
      window.setTimeout(() => void refresh(current), 400);
    }
  }, []);

  // 主窗口重新可见时对齐一次：期间浮窗可能已被系统关掉。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return { ...snapshot, toggle };
}
