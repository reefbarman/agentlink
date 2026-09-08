// @vitest-environment jsdom

import type {
  MemoryArchiveV1,
  MemoryAuditEvent,
  MemoryPanelSnapshot,
  MemoryRecord,
} from "@agentlink/protocol/autonomous-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { MemoryPanel } from "./MemoryPanel.js";

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

    expect(
      screen.getAllByText("Keep final answers concise.").length,
    ).toBeGreaterThanOrEqual(2);
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
    expect(
      screen.getByText(
        /Forget all global memories, including records hidden by filters/,
      ),
    ).toBeTruthy();
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

  it("adds memory directly and waits for the save before closing the editor", async () => {
    let finish!: () => void;
    const onManage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <MemoryPanel {...props({ onManage, availableScopes: ["global"] })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    expect(
      (screen.getByRole("button", { name: "Save memory" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.input(screen.getByLabelText("Memory statement"), {
      target: { value: "  Prefer concise examples.  " },
    });
    fireEvent.change(screen.getByLabelText("Record kind"), {
      target: { value: "workflow_hint" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect(onManage).toHaveBeenCalledWith({
      operation: "remember",
      scope: "global",
      statement: "Prefer concise examples.",
      kind: "workflow_hint",
      source_evidence: "User added memory from /memory.",
    });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    finish();
    await screen.findByText(/Memory saved/);
    expect(screen.queryByLabelText("Memory statement")).toBeNull();
  });

  it("preserves failed edit drafts and their original revision, then allows retry", async () => {
    const onManage = vi
      .fn()
      .mockRejectedValueOnce(new Error("This memory changed elsewhere."))
      .mockResolvedValue(undefined);
    render(<MemoryPanel {...props({ onManage })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (screen.getByLabelText("Memory statement") as HTMLTextAreaElement).value,
    ).toBe(activeRecord.statement);
    fireEvent.input(screen.getByLabelText("Memory statement"), {
      target: { value: "A corrected preference." },
    });
    for (const name of [
      "Project",
      "Search",
      "Forget",
      "Import JSON",
      "Clear…",
    ]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText("This memory changed elsewhere.");
    expect(
      (screen.getByLabelText("Memory statement") as HTMLTextAreaElement).value,
    ).toBe("A corrected preference.");
    expect(onManage).toHaveBeenCalledWith({
      operation: "update",
      scope: "global",
      kind: "preference",
      statement: "A corrected preference.",
      target_id: "memory-1",
      expected_revision: 3,
      source_evidence: "User edited memory from /memory.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByText(/Memory saved/);
  });

  it("preserves a draft when the host changes scope and prevents saving it into the new scope", () => {
    const onManage = vi.fn();
    const { rerender } = render(<MemoryPanel {...props({ onManage })} />);
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.input(screen.getByLabelText("Memory statement"), {
      target: { value: "My global preference." },
    });
    rerender(<MemoryPanel {...props({ onManage, scope: "project" })} />);
    expect(
      (screen.getByLabelText("Memory statement") as HTMLTextAreaElement).value,
    ).toBe("My global preference.");
    expect(screen.getByText(/The active scope changed/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save memory" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Add memory" }));
    expect(onManage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(screen.queryByLabelText("Memory statement")).toBeNull();
  });

  it("submits search from the form and resets filters", () => {
    const onQuery = vi.fn();
    render(<MemoryPanel {...props({ onQuery })} />);
    fireEvent.input(screen.getByLabelText("Search memory"), {
      target: { value: " concise " },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Filter memories" }));
    expect(onQuery).toHaveBeenLastCalledWith({
      scope: "global",
      query: "concise",
      limit: 100,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onQuery).toHaveBeenLastCalledWith({ scope: "global", limit: 100 });
    expect(
      (screen.getByLabelText("Search memory") as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows source evidence and revision statements, not only counts", () => {
    render(<MemoryPanel {...props()} />);
    fireEvent.click(screen.getByText("Sources (1)"));
    expect(screen.getByText("User requested concise answers.")).toBeTruthy();
    fireEvent.click(screen.getByText("Revisions (1)"));
    expect(screen.getByText(/Revision 3 ·/)).toBeTruthy();
    expect(screen.getByText("Confidence: 95%")).toBeTruthy();
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
