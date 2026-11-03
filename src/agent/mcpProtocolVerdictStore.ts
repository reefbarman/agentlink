import type * as vscode from "vscode";

import type {
  McpProtocolVerdict,
  McpProtocolVerdictStore,
} from "@agentlink/node-host";

export const MCP_PROTOCOL_VERDICTS_KEY = "agentlink.mcpProtocolVerdicts";
/** Bound the stored map; the oldest verdicts are dropped first. */
export const MAX_MCP_PROTOCOL_VERDICTS = 200;

type StoredVerdicts = Record<string, unknown>;

function readAll(memento: vscode.Memento): StoredVerdicts {
  const value = memento.get<unknown>(MCP_PROTOCOL_VERDICTS_KEY);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as StoredVerdicts)
    : {};
}

function checkedAt(value: unknown): number {
  const at = (value as { checkedAt?: unknown } | null)?.checkedAt;
  return typeof at === "number" ? at : 0;
}

/**
 * Remembers MCP protocol negotiation verdicts in VS Code global state so the
 * probe runs once per server across windows and reloads. Entries are
 * validated by the hub when read.
 */
export function createMementoMcpProtocolVerdictStore(
  memento: vscode.Memento,
): McpProtocolVerdictStore {
  return {
    get: (key) => {
      const all = readAll(memento);
      return Object.hasOwn(all, key) ? all[key] : undefined;
    },
    set: async (key, verdict: McpProtocolVerdict) => {
      const entries = Object.entries({ ...readAll(memento), [key]: verdict })
        .sort(([, a], [, b]) => checkedAt(b) - checkedAt(a))
        .slice(0, MAX_MCP_PROTOCOL_VERDICTS);
      await memento.update(
        MCP_PROTOCOL_VERDICTS_KEY,
        Object.fromEntries(entries),
      );
    },
    delete: async (key) => {
      const all = readAll(memento);
      if (!Object.hasOwn(all, key)) return;
      const { [key]: _removed, ...rest } = all;
      await memento.update(MCP_PROTOCOL_VERDICTS_KEY, rest);
    },
  };
}
