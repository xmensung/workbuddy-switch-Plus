import { describe, expect, it } from "vitest";

import type { ToolId } from "./supported-tools";
import {
  TOKEN_SOURCE_KEYS,
  TOKEN_SOURCE_TOOLS,
  isTokenSourceVisible,
  visibleTokenSources,
} from "./token-sources";

const ALL_TOOLS: ToolId[] = ["workbuddy", "codebuddyIde", "codebuddyCli", "vscodeExt", "jetbrains"];

/** 「支持工具」开关快照：列出的为开启，其余关闭（与设置页语义一致）。 */
function tools(on: ToolId[]): Record<ToolId, boolean> {
  return Object.fromEntries(ALL_TOOLS.map((id) => [id, on.includes(id)])) as Record<
    ToolId,
    boolean
  >;
}

/** 默认状态：四个端开启、JetBrains 关闭（见 SUPPORTED_TOOLS 的 defaultEnabled）。 */
const DEFAULTS = tools(["workbuddy", "codebuddyIde", "codebuddyCli", "vscodeExt"]);

describe("visibleTokenSources", () => {
  it("全部默认工具开启时展示全部四个来源，且顺序稳定", () => {
    expect(visibleTokenSources(DEFAULTS)).toEqual([
      "workbuddy",
      "workbuddy-ai",
      "codebuddy-cli",
      "codebuddy-ide",
    ]);
  });

  it("关闭 CodeBuddy CLI 后不再出现 codebuddy-cli", () => {
    const enabled = tools(["workbuddy", "codebuddyIde", "vscodeExt"]);
    expect(visibleTokenSources(enabled)).toEqual(["workbuddy", "workbuddy-ai", "codebuddy-ide"]);
  });

  it("关闭 WorkBuddy 后国内版与国际版两个来源一起隐藏", () => {
    const enabled = tools(["codebuddyIde", "codebuddyCli", "vscodeExt"]);
    expect(visibleTokenSources(enabled)).toEqual(["codebuddy-cli", "codebuddy-ide"]);
  });

  it("codebuddy-ide 同时归属 IDE 与 VS Code 插件：只关一个仍保留", () => {
    const onlyIdeOff = tools(["workbuddy", "codebuddyCli", "vscodeExt"]);
    const onlyVscodeOff = tools(["workbuddy", "codebuddyCli", "codebuddyIde"]);
    expect(visibleTokenSources(onlyIdeOff)).toContain("codebuddy-ide");
    expect(visibleTokenSources(onlyVscodeOff)).toContain("codebuddy-ide");
  });

  it("只有 IDE 与 VS Code 插件都关闭时才隐藏 codebuddy-ide", () => {
    const enabled = tools(["workbuddy", "codebuddyCli"]);
    expect(visibleTokenSources(enabled)).toEqual(["workbuddy", "workbuddy-ai", "codebuddy-cli"]);
  });

  it("全部工具关闭时返回空数组（页面据此显示空态）", () => {
    expect(visibleTokenSources(tools([]))).toEqual([]);
  });
});

describe("isTokenSourceVisible", () => {
  it("按来源判断其对应工具是否至少开启一个", () => {
    expect(isTokenSourceVisible("workbuddy-ai", DEFAULTS)).toBe(true);
    expect(isTokenSourceVisible("codebuddy-cli", tools(["workbuddy"]))).toBe(false);
    expect(isTokenSourceVisible("codebuddy-ide", tools(["vscodeExt"]))).toBe(true);
  });
});

describe("TOKEN_SOURCE_TOOLS", () => {
  it("覆盖全部来源，且每个来源至少映射一个工具", () => {
    expect(TOKEN_SOURCE_KEYS).toEqual([
      "workbuddy",
      "workbuddy-ai",
      "codebuddy-cli",
      "codebuddy-ide",
    ]);
    for (const key of TOKEN_SOURCE_KEYS) {
      expect(TOKEN_SOURCE_TOOLS[key].length).toBeGreaterThan(0);
    }
  });
});
