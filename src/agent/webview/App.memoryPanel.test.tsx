// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { App } from "./App.js";
import type { MemoryPanelSnapshot } from "../../core/capabilities/memory.js";
import type { MemoryRecord } from "../../core/memory/contracts.js";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function createVsCodeApi() {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
}

function deliver(message: unknown): void {
  fireEvent(window, new MessageEvent("message", { data: message }));
}

const record: MemoryRecord = {
  id: "memory-current",
  revision: 2,
  scope: { kind: "global", id: "agentlink-user" },
  kind: "preference",
  statement: "Keep the current memory record.",
  conflictKey: "preference:current",
  confidence: 0.9,
  status: "active",
  provenance: [
    {
      source: "current_user",
      observedAt: "2026-07-26T12:00:00.000Z",
      evidence: "The user stated a durable preference.",
    },
  ],
  createdAt: "2026-07-26T12:00:00.000Z",
  updatedAt: "2026-07-26T12:01:00.000Z",
  observedAt: "2026-07-26T12:00:00.000Z",
};

const health = {
  status: "ready" as const,
  retrieval: "lexical-only" as const,
  crud: true,
  dedupe: true,
  conflict: true,
  auditUndo: true,
  recordCount: 1,
  activeRecordCount: 1,
  auditEventCount: 0,
};

function snapshot(memoryRecord: MemoryRecord = record): MemoryPanelSnapshot {
  return {
    records: [memoryRecord],
    total: 1,
    events: [],
    health,
  };
}

function postedCommands(
  postMessage: ReturnType<typeof vi.fn>,
  command: string,
): Array<Record<string, unknown>> {
  return postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.command === command);
}

describe("App memory panel integration", () => {
  it("drops stale responses and merges current detail into the existing snapshot", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);

    deliver({
      type: "agentMemoryPanelUpdate",
      open: true,
      scope: "global",
      availableScopes: ["global", "project"],
      snapshot: snapshot(),
    });
    expect(screen.getByText(record.statement)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const queryRequest = postedCommands(
      vscodeApi.postMessage,
      "agentMemoryQuery",
    ).at(-1)!;
    expect(queryRequest.requestId).toEqual(expect.any(String));

    const staleRecord = {
      ...record,
      id: "memory-stale",
      statement: "Stale memory.",
    };
    deliver({
      type: "agentMemoryPanelUpdate",
      requestId: "stale-request",
      scope: "global",
      availableScopes: ["global", "project"],
      snapshot: snapshot(staleRecord),
    });
    expect(screen.getByText(record.statement)).toBeTruthy();
    expect(screen.queryByText(staleRecord.statement)).toBeNull();

    deliver({
      type: "agentMemoryPanelUpdate",
      requestId: queryRequest.requestId,
      scope: "global",
      availableScopes: ["global", "project"],
      snapshot: snapshot(),
    });
    fireEvent.click(screen.getByText(record.statement));
    const detailRequest = postedCommands(
      vscodeApi.postMessage,
      "agentMemoryDetail",
    ).at(-1)!;
    expect(detailRequest).toMatchObject({
      recordId: record.id,
      scope: "global",
      requestId: expect.any(String),
    });

    const detailedRecord = {
      ...record,
      statement: "Current detail without replacing the list.",
    };
    deliver({
      type: "agentMemoryPanelUpdate",
      requestId: detailRequest.requestId,
      scope: "global",
      availableScopes: ["global", "project"],
      selected: {
        record: detailedRecord,
        revisions: [
          {
            recordId: record.id,
            revision: record.revision,
            recordedAt: record.updatedAt,
            record: detailedRecord,
          },
        ],
        audit: [],
      },
    });

    expect(screen.getByText(record.statement)).toBeTruthy();
    expect(screen.getByText(detailedRecord.statement)).toBeTruthy();
    expect(screen.getByText("Provenance: current_user")).toBeTruthy();
  });

  it("refreshes the latest query after a stale mutation completion", () => {
    const vscodeApi = createVsCodeApi();
    render(<App vscodeApi={vscodeApi} />);
    deliver({
      type: "agentMemoryPanelUpdate",
      open: true,
      scope: "global",
      availableScopes: ["global"],
      snapshot: {
        ...snapshot(),
        selected: { record, revisions: [], audit: [] },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const mutation = postedCommands(
      vscodeApi.postMessage,
      "agentMemoryManage",
    ).at(-1)!;
    expect(mutation.requestId).toEqual(expect.any(String));

    deliver({
      type: "agentSlashCommandsUpdate",
      commands: [
        {
          name: "memory",
          description: "Open autonomous memory",
          builtin: true,
        },
      ],
    });
    const composer = screen.getByPlaceholderText(/Message\.\.\./);
    fireEvent.input(composer, { target: { value: "/memory" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    const newerQuery = postedCommands(
      vscodeApi.postMessage,
      "agentMemoryQuery",
    ).at(-1)!;
    expect(newerQuery.requestId).not.toBe(mutation.requestId);

    deliver({
      type: "agentMemoryPanelUpdate",
      requestId: mutation.requestId,
      scope: "global",
      availableScopes: ["global"],
      snapshot: snapshot({
        ...record,
        revision: 3,
        status: "forgotten",
        forgottenAt: "2026-07-26T12:02:00.000Z",
      }),
    });

    const refresh = postedCommands(
      vscodeApi.postMessage,
      "agentMemoryQuery",
    ).at(-1)!;
    expect(refresh).toMatchObject({
      requestId: expect.any(String),
      request: { scope: "global", limit: 100 },
    });
    expect(refresh.requestId).not.toBe(mutation.requestId);
    expect(refresh.requestId).not.toBe(newerQuery.requestId);
  });
});
