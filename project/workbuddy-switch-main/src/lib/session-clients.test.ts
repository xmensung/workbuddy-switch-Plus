import { describe, expect, it } from "vitest";

import { SESSION_CLIENTS, visibleSessionClients } from "./session-clients";
import type { ToolId } from "./supported-tools";

const ALL_TOOLS: ToolId[] = ["workbuddy", "codebuddyIde", "codebuddyCli", "vscodeExt", "jetbrains"];

function tools(on: ToolId[]): Record<ToolId, boolean> {
  return Object.fromEntries(ALL_TOOLS.map((id) => [id, on.includes(id)])) as Record<
    ToolId,
    boolean
  >;
}

const DEFAULTS = tools(["workbuddy", "codebuddyIde", "codebuddyCli", "vscodeExt"]);

describe("visibleSessionClients", () => {
  it("默认展示三个客户端，顺序与 Tab 一致", () => {
    expect(visibleSessionClients(DEFAULTS).map((item) => item.id)).toEqual([
      "workbuddy",
      "vscodeExt",
      "codebuddyIde",
    ]);
  });

  it("关闭 CodeBuddy IDE 后该 Tab 不再出现", () => {
    const enabled = tools(["workbuddy", "codebuddyCli", "vscodeExt"]);
    expect(visibleSessionClients(enabled).map((item) => item.id)).toEqual([
      "workbuddy",
      "vscodeExt",
    ]);
  });

  it("关闭 VS Code 插件后只剩 WorkBuddy 与 CodeBuddy IDE", () => {
    const enabled = tools(["workbuddy", "codebuddyIde", "codebuddyCli"]);
    expect(visibleSessionClients(enabled).map((item) => item.id)).toEqual([
      "workbuddy",
      "codebuddyIde",
    ]);
  });

  it("关闭全部工具时返回空数组（页面显示空态）", () => {
    expect(visibleSessionClients(tools([]))).toEqual([]);
  });
});

describe("SESSION_CLIENTS", () => {
  it("每个客户端都映射到一个「支持工具」开关，且 id 不重复", () => {
    const ids = SESSION_CLIENTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SESSION_CLIENTS) {
      expect(ALL_TOOLS).toContain(item.tool);
    }
  });
});
