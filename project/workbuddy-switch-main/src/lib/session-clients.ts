import type { ToolId } from "@/lib/supported-tools";
import type { SessionGroupClient } from "@/lib/types";

export interface SessionClientDef {
  id: SessionGroupClient;
  /** 对应的「支持工具」开关：关掉后该客户端在「关联会话」页不再出现。 */
  tool: ToolId;
  title: string;
  description: string;
}

/** 「关联会话」页的客户端 Tab（展示顺序即数组顺序）。 */
export const SESSION_CLIENTS: SessionClientDef[] = [
  { id: "workbuddy", tool: "workbuddy", title: "WorkBuddy", description: "含国内版与国际版会话" },
  { id: "vscodeExt", tool: "vscodeExt", title: "CodeBuddy 插件", description: "VS Code 扩展会话" },
  { id: "codebuddyIde", tool: "codebuddyIde", title: "CodeBuddy IDE", description: "国内版 / 国际版独立分组" },
];

/** 当前应展示的客户端列表。 */
export function visibleSessionClients(enabled: Record<ToolId, boolean>): SessionClientDef[] {
  return SESSION_CLIENTS.filter((item) => enabled[item.tool]);
}
