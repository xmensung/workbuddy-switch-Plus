import type { ToolId } from "@/lib/supported-tools";
import type { TokenStatsSource } from "@/lib/types";

/** Token 统计的数据来源，与后端 `token_stats.rs` 的 `source` 字段一一对应。 */
export type TokenSourceKey = TokenStatsSource["source"];

/**
 * 每个来源归属的「支持工具」开关（设置 → 支持工具）。
 *
 * 关闭某个工具后，它的来源不应继续出现在 Token 统计的数据源 Tab 里。
 *
 * `codebuddy-ide` 一项同时覆盖 CodeBuddy IDE 与 VS Code 插件：后端这两个客户端
 * 共用 `CodeBuddyExtension` 数据目录，前端也只给了一个 Tab 入口，
 * 因此需要两个开关都关闭才隐藏它。
 */
export const TOKEN_SOURCE_TOOLS: Record<TokenSourceKey, ToolId[]> = {
  workbuddy: ["workbuddy"],
  "workbuddy-ai": ["workbuddy"],
  "codebuddy-cli": ["codebuddyCli"],
  "codebuddy-ide": ["codebuddyIde", "vscodeExt"],
};

/** 稳定顺序：与后端 `sources` 数组、页面 Tab 的展示顺序一致。 */
export const TOKEN_SOURCE_KEYS = Object.keys(TOKEN_SOURCE_TOOLS) as TokenSourceKey[];

/** 该来源是否有任一对应工具处于开启状态。 */
export function isTokenSourceVisible(
  source: TokenSourceKey,
  enabled: Record<ToolId, boolean>,
): boolean {
  return TOKEN_SOURCE_TOOLS[source].some((tool) => enabled[tool]);
}

/** 当前应展示的来源列表（保持 {@link TOKEN_SOURCE_KEYS} 的顺序）。 */
export function visibleTokenSources(enabled: Record<ToolId, boolean>): TokenSourceKey[] {
  return TOKEN_SOURCE_KEYS.filter((key) => isTokenSourceVisible(key, enabled));
}
