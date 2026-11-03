import type * as vscode from "vscode";

import {
  MAX_MCP_PROTOCOL_VERDICTS,
  MCP_PROTOCOL_VERDICTS_KEY,
  createMementoMcpProtocolVerdictStore,
} from "./mcpProtocolVerdictStore.js";
import { describe, expect, it } from "vitest";

function memento(initial?: unknown): vscode.Memento {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(MCP_PROTOCOL_VERDICTS_KEY, initial);
  return {
    keys: () => [...values.keys()],
    get: (key: string, fallback?: unknown) =>
      values.has(key) ? values.get(key) : fallback,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as vscode.Memento;
}

describe("memento MCP protocol verdict store", () => {
  it("stores, reads and forgets verdicts", async () => {
    const store = createMementoMcpProtocolVerdictStore(memento());
    await store.set("a", { kind: "legacy", checkedAt: 1 });
    expect(store.get("a")).toEqual({ kind: "legacy", checkedAt: 1 });
    expect(store.get("constructor")).toBe(undefined);
    await store.delete("a");
    expect(store.get("a")).toBe(undefined);
  });

  it("ignores a corrupt stored value", () => {
    expect(
      createMementoMcpProtocolVerdictStore(memento(["bad"])).get("0"),
    ).toBe(undefined);
  });

  it("keeps only the most recent verdicts", async () => {
    const state = memento();
    const store = createMementoMcpProtocolVerdictStore(state);
    for (let index = 0; index <= MAX_MCP_PROTOCOL_VERDICTS; index += 1) {
      await store.set(`k${index}`, { kind: "legacy", checkedAt: index });
    }
    const stored = state.get<Record<string, unknown>>(
      MCP_PROTOCOL_VERDICTS_KEY,
    )!;
    expect(Object.keys(stored)).toHaveLength(MAX_MCP_PROTOCOL_VERDICTS);
    expect(store.get("k0")).toBe(undefined);
    expect(store.get(`k${MAX_MCP_PROTOCOL_VERDICTS}`)).toBeDefined();
  });
});
