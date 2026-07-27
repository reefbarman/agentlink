// @vitest-environment jsdom

import type {
  MemoryArchiveV1,
  MemoryAuditEvent,
  MemoryRecord,
} from "../../core/memory/contracts.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { MemoryPanel } from "./MemoryPanel.js";
import type { MemoryPanelSnapshot } from "../../core/capabilities/memory.js";

afterEach(cleanup);

const activeRecord: MemoryRecord = {
  id: "memory-1",
  revision: 3,
  scope: { kind: "global", id: "agentlink-user" },
  kind: "preference",
  statement: "Keep final answers concise.",
  conflictKey: "preference:response-length",
  confidence: 0.95,
  status: "active",
  provenance: [
    {
      source: "current_user",
      observedAt: "2026-07-26T10:00:00.000Z",
      evidence: "User requested concise answers.",
    },
  ],
  createdAt: "2026-07-26T10:00:00.000Z",
  updatedAt: "2026-07-26T10:00:00.000Z",
  observedAt: "2026-07-26T10:00:00.000Z",
};

const auditEvent: MemoryAuditEvent = {
  id: "audit-1",
  operation: "update",
  disposition: "updated",
  occurredAt: "2026-07-26T10:01:00.000Z",
  actor: activeRecord.provenance[0]!,
  scope: activeRecord.scope,
  changes: [{ recordId: activeRecord.id, before: null, after: activeRecord }],
};

function snapshot(record: MemoryRecord = activeRecord): MemoryPanelSnapshot {
  return {
    records: [record],
    total: 1,
    events: [auditEvent],
    selected: {
      record,
      revisions: [
        {
          recordId: record.id,
          revision: record.revision,
          recordedAt: record.updatedAt,
          record,
        },
      ],
      audit: [auditEvent],
    },
    health: {
      status: "ready",
      retrieval: "lexical-only",
      crud: true,
      dedupe: true,
      conflict: true,
      auditUndo: true,
      recordCount: 1,
      activeRecordCount: record.status === "active" ? 1 : 0,
      auditEventCount: 1,
    },
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: snapshot(),
    scope: "global" as const,
    availableScopes: ["global", "project"] as Array<"global" | "project">,
    onClose: vi.fn(),
    onQuery: vi.fn(),
    onDetail: vi.fn(),
    onManage: vi.fn(),
    onClear: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
    ...overrides,
  };
}

describe("MemoryPanel", () => {
  it("renders records and emits bounded scope and filter queries", () => {
    const onQuery = vi.fn();
    render(<MemoryPanel {...props({ onQuery })} />);

    expect(screen.getAllByText("Keep final answers concise.")).toHaveLength(2);
    fireEvent.input(screen.getByLabelText("Search memory"), {
      target: { value: "concise" },
    });
    fireEvent.change(screen.getByLabelText("Memory kind"), {
      target: { value: "preference" },
    });
    fireEvent.change(screen.getByLabelText("Memory status"), {
      target: { value: "active" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(onQuery).toHaveBeenLastCalledWith({
      scope: "global",
      query: "concise",
      kinds: ["preference"],
      statuses: ["active"],
      limit: 100,
    });

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(onQuery).toHaveBeenLastCalledWith({
      scope: "project",
      query: "concise",
      kinds: ["preference"],
      statuses: ["active"],
      limit: 100,
    });
  });

  it("emits detail, forget, restore, and undo operations with revision evidence", () => {
    const onDetail = vi.fn();
    const onManage = vi.fn();
    const { rerender } = render(
      <MemoryPanel {...props({ onDetail, onManage })} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Keep final answers concise/ }),
    );
    expect(onDetail).toHaveBeenCalledWith("memory-1");

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(onManage).toHaveBeenCalledWith({
      operation: "forget",
      scope: "global",
      target_id: "memory-1",
      expected_revision: 3,
      source_evidence: "User forgot memory from /memory.",
    });

    fireEvent.click(screen.getByText("Recent activity (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onManage).toHaveBeenCalledWith({
      operation: "undo",
      scope: "global",
      undo_audit_event_id: "audit-1",
      source_evidence: "User selected undo from /memory activity.",
    });

    const forgotten = {
      ...activeRecord,
      revision: 4,
      status: "forgotten" as const,
      forgottenAt: "2026-07-26T10:02:00.000Z",
    };
    rerender(
      <MemoryPanel
        {...props({ snapshot: snapshot(forgotten), onDetail, onManage })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onManage).toHaveBeenLastCalledWith({
      operation: "restore",
      scope: "global",
      target_id: "memory-1",
      expected_revision: 4,
      source_evidence: "User restored memory from /memory.",
    });
  });

  it("requires clear confirmation and emits archive export and import callbacks", async () => {
    const onClear = vi.fn();
    const onExport = vi.fn();
    const onImport = vi.fn();
    const { container } = render(
      <MemoryPanel {...props({ onClear, onExport, onImport })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear…" }));
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByText(/Clear tombstones all non-forgotten/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    expect(onClear).toHaveBeenCalledWith("global");
    expect(screen.queryByRole("button", { name: "Confirm clear" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(onExport).toHaveBeenCalledWith("global");

    const archive: MemoryArchiveV1 = {
      schema: "agentlink-memory",
      version: 1,
      archiveId: "archive-1",
      exportedAt: "2026-07-26T10:03:00.000Z",
      scope: activeRecord.scope,
      records: [activeRecord],
      warning: "Archive warning.",
    };
    const file = new File([JSON.stringify(archive)], "memory.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: vi.fn(async () => JSON.stringify(archive)),
    });
    fireEvent.change(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [file] } },
    );
    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith(archive, "global"),
    );
  });

  it("locks all memory interactions while an operation is pending", () => {
    render(<MemoryPanel {...props({ loading: true })} />);

    fireEvent.click(screen.getByText("Recent activity (1)"));
    for (const name of [
      "Global",
      "Project",
      /Keep final answers concise/,
      "Forget",
      "Undo",
      "Export JSON",
      "Import JSON",
      "Clear…",
    ]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(
      (screen.getByLabelText("Search memory") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Memory kind") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Memory status") as HTMLSelectElement).disabled,
    ).toBe(true);
  });

  it("shows a controlled error for malformed JSON archives", async () => {
    const onImport = vi.fn();
    const { container } = render(<MemoryPanel {...props({ onImport })} />);
    const file = new File(["{"], "broken.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: vi.fn(async () => "{"),
    });

    fireEvent.change(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [file] } },
    );

    expect(
      await screen.findByText("The selected file is not valid JSON."),
    ).toBeTruthy();
    expect(onImport).not.toHaveBeenCalled();
  });
});
