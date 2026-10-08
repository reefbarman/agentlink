import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchToolCall, type ToolDispatchContext } from "./toolAdapter.js";
import { readFeedback } from "../util/feedbackStore.js";

const context: ToolDispatchContext = {
  approvalManager: {} as any,
  approvalPanel: {} as any,
  sessionId: "feedback-composition-session",
  projectRoot: "/tmp/project",
  extensionUri: {} as any,
  onApprovalRequest: vi.fn(),
  terminalProvider: {} as any,
};

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-feedback-dispatch-"),
  );
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("feedback production dispatch", () => {
  it("passes all impact fields through real handlers, storage and get_feedback", async () => {
    const fields = {
      observed_impact: "Task needed an extra call to locate the implementation",
      workaround: "Used an exact search, task completed",
      observed_recurrence: "Two failures in three attempts this session",
      improvement_signal: "Implementation appears in the first search results",
      category: "bug" as const,
      suspected_cause: "The implementation may be missing from the index",
      suggested_change: "Include the implementation in indexed results",
    };
    const sent = await dispatchToolCall(
      "send_feedback",
      {
        tool_name: "codebase_search",
        feedback: "Implementation absent from relevant search results",
        ...fields,
      },
      context,
    );
    const sentText =
      sent.content.find((item) => item.type === "text")?.text ?? "";
    const recorded = JSON.parse(sentText);
    expect(recorded.status).toBe("recorded");
    expect(readFeedback()).toEqual([
      expect.objectContaining({
        ...fields,
        id: recorded.id,
        session_id: context.sessionId,
      }),
    ]);

    const retrieved = await dispatchToolCall(
      "get_feedback",
      { tool_name: "codebase_search", triaged: false },
      context,
    );
    const retrievedText =
      retrieved.content.find((item) => item.type === "text")?.text ?? "";
    expect(JSON.parse(retrievedText)).toMatchObject({
      status: "success",
      count: 1,
      entries: [{ ...fields, id: recorded.id }],
    });
  });

  it.each(["improvement", "feature_request"] as const)(
    "preserves a %s proposal through retrieval and triage",
    async (category) => {
      const fields = {
        category,
        suggested_change: "Add a session comparison view",
        observed_impact: "Task succeeded after manually comparing histories",
        improvement_signal: "Compare the histories in one view",
      };
      const sent = await dispatchToolCall(
        "send_feedback",
        {
          tool_name: "agentlink",
          feedback: "Manual history comparison",
          ...fields,
        },
        context,
      );
      const recorded = JSON.parse(
        sent.content.find((item) => item.type === "text")?.text ?? "",
      );
      expect(recorded.status).toBe("recorded");
      const triaged = await dispatchToolCall(
        "triage_feedback",
        { ids: [recorded.id], triaged: true, priority: "P2" },
        context,
      );
      expect(
        JSON.parse(
          triaged.content.find((item) => item.type === "text")?.text ?? "",
        ),
      ).toMatchObject({
        updated_entries: [expect.objectContaining(fields)],
      });
      const retrieved = await dispatchToolCall(
        "get_feedback",
        { tool_name: "agentlink", triaged: true },
        context,
      );
      const entry = JSON.parse(
        retrieved.content.find((item) => item.type === "text")?.text ?? "",
      ).entries[0];
      expect(entry).toMatchObject({ ...fields, priority: "P2" });
      expect(entry).not.toHaveProperty("suspected_cause");
    },
  );

  it("rejects invalid categories without recording or silently reclassifying", async () => {
    for (const category of ["", "suggestion", 7, null, {}]) {
      const result = await dispatchToolCall(
        "send_feedback",
        {
          tool_name: "read_file",
          feedback: "Unexpected result",
          observed_impact: "Needed another read",
          category,
        },
        context,
      );
      expect(
        JSON.parse(
          result.content.find((item) => item.type === "text")?.text ?? "",
        ),
      ).toMatchObject({
        status: "rejected",
        error: "category must be bug, improvement, or feature_request",
      });
    }
    expect(readFeedback()).toEqual([]);
  });

  it("rejects missing, blank and non-string impact through dispatch", async () => {
    for (const observed_impact of [undefined, "", " \n\t ", 7, {}]) {
      const result = await dispatchToolCall(
        "send_feedback",
        {
          tool_name: "read_file",
          feedback: "Unexpected result",
          observed_impact,
        },
        context,
      );
      const text =
        result.content.find((item) => item.type === "text")?.text ?? "";
      expect(JSON.parse(text)).toMatchObject({ status: "rejected" });
    }
    expect(readFeedback()).toEqual([]);
  });

  it("returns historical feedback without fabricating impact context", async () => {
    const feedbackPath = path.join(
      tmpHome,
      ".agentlink",
      "agentlink-feedback.jsonl",
    );
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
    fs.writeFileSync(
      feedbackPath,
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        tool_name: "read_file",
        feedback: "Historical issue",
        extension_version: "1.0.0",
      }) + "\n",
    );

    const result = await dispatchToolCall("get_feedback", {}, context);
    const text =
      result.content.find((item) => item.type === "text")?.text ?? "";
    const retrieved = JSON.parse(text);
    expect(retrieved).toMatchObject({
      status: "success",
      count: 1,
      entries: [{ feedback: "Historical issue", global_index: 0 }],
    });
    expect(retrieved.entries[0].id).toMatch(/^legacy-/);
    for (const field of [
      "observed_impact",
      "workaround",
      "observed_recurrence",
      "improvement_signal",
      "category",
      "suspected_cause",
      "suggested_change",
    ]) {
      expect(retrieved.entries[0]).not.toHaveProperty(field);
    }
    expect(retrieved.entries[0].content_status).toBe("legacy_unverified");
  });

  async function dispatchJson(name: string, input: Record<string, unknown>) {
    const result = await dispatchToolCall(name, input, context);
    return JSON.parse(
      result.content.find((item) => item.type === "text")?.text ?? "{}",
    );
  }

  const longFields = {
    feedback:
      'Long revision with "quotes"\\n, newlines\nand 🌊 Unicode. '.repeat(90) +
      "Supersedes: distinctive-id-1, distinctive-id-2",
    suspected_cause: "cause ".repeat(150) + "CAUSE-TAIL",
    suggested_change: "change ".repeat(150) + "CHANGE-TAIL",
    observed_impact: "Lost acceptance constraints",
    tool_result_summary: '\u0001"\\'.repeat(3000) + "RESULT-TAIL",
  };

  it("acknowledges preservation and returns a small full record as a parsed entry", async () => {
    const sent = await dispatchJson("send_feedback", {
      tool_name: "read_file",
      feedback: "Short report",
      observed_impact: "Needed a reread",
      workaround: "w".repeat(700),
    });
    expect(sent).toMatchObject({
      status: "recorded",
      content_preserved: true,
      preview_truncated: true,
      truncated_fields: ["workaround"],
      content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      full_record: { tool: "get_feedback", input: { id: sent.id } },
    });
    expect(sent.full_record.note).toContain("If get_feedback is available");

    const list = await dispatchJson("get_feedback", { tool_name: "read_file" });
    expect(list.entries[0]).toMatchObject({
      content_status: "preview",
      full_record: { input: { id: sent.id } },
    });

    const full = await dispatchJson("get_feedback", { id: sent.id });
    expect(full).toMatchObject({
      status: "success",
      mode: "entry",
      content_status: "complete",
      content_sha256: sent.content_sha256,
      entry: { id: sent.id, workaround: "w".repeat(700) },
    });
  });

  it("reassembles a large report exactly from bounded pages", async () => {
    const sent = await dispatchJson("send_feedback", {
      tool_name: "agentlink",
      category: "bug",
      ...longFields,
    });
    expect(sent.status).toBe("recorded");

    let request: Record<string, unknown> = { id: sent.id };
    let reassembled = "";
    let pages = 0;
    for (;;) {
      const page = await dispatchJson("get_feedback", request);
      expect(page).toMatchObject({ status: "success", mode: "page" });
      expect(
        Buffer.byteLength(JSON.stringify(page, null, 2), "utf-8"),
      ).toBeLessThanOrEqual(16 * 1024);
      expect(page.offset).toBe(reassembled.length);
      reassembled += page.record_json;
      pages += 1;
      if (page.final_page) {
        expect(page.next_offset).toBeNull();
        break;
      }
      request = page.next_request.input;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1);
    const parsed = JSON.parse(reassembled);
    expect(parsed).toMatchObject({ id: sent.id, ...longFields });
    expect(
      createHash("sha256").update(reassembled, "utf-8").digest("hex"),
    ).toBe(sent.content_sha256);
  });

  it("never splits surrogate pairs across pages", async () => {
    const sent = await dispatchJson("send_feedback", {
      tool_name: "agentlink",
      feedback: "🌊".repeat(3000),
      observed_impact: "Unicode tail",
    });
    let offset = 0;
    let reassembled = "";
    for (;;) {
      const page = await dispatchJson("get_feedback", {
        id: sent.id,
        offset,
        limit: 101,
      });
      const chunk: string = page.record_json;
      expect(chunk.charCodeAt(chunk.length - 1) & 0xfc00).not.toBe(0xd800);
      reassembled += chunk;
      if (page.final_page) break;
      offset = page.next_offset;
    }
    expect(JSON.parse(reassembled).feedback).toBe("🌊".repeat(3000));
    const split = await dispatchJson("get_feedback", {
      id: sent.id,
      offset: reassembled.indexOf("🌊") + 1,
    });
    expect(split).toMatchObject({ status: "rejected" });
  });

  it.each([
    [{ offset: 0 }, "offset and limit require id"],
    [{ id: "x", tool_name: "read_file" }, "cannot be combined"],
    [{ id: "x", limit: 0 }, "limit must be"],
    [{ id: "x", limit: 8001 }, "limit must be"],
    [{ id: "x", offset: -1 }, "offset must be"],
    [{ id: "x", offset: 1.5 }, "offset must be"],
  ])("rejects invalid retrieval requests %#", async (input, message) => {
    const result = await dispatchJson("get_feedback", input);
    expect(result.status).toBe("rejected");
    expect(result.error).toContain(message);
  });

  it("reports unknown IDs and out-of-range offsets explicitly", async () => {
    expect(await dispatchJson("get_feedback", { id: "missing" })).toMatchObject(
      { status: "error", code: "not_found" },
    );
    const sent = await dispatchJson("send_feedback", {
      tool_name: "agentlink",
      feedback: "small",
      observed_impact: "x",
    });
    expect(
      await dispatchJson("get_feedback", { id: sent.id, offset: 100_000 }),
    ).toMatchObject({ status: "rejected" });
  });

  it("rejects reports above the record ceiling with per-field sizes", async () => {
    const result = await dispatchJson("send_feedback", {
      tool_name: "agentlink",
      feedback: "Huge result",
      observed_impact: "x",
      tool_result_summary: "r".repeat(140_000),
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "feedback_too_large",
      recorded: false,
      field_bytes: { tool_result_summary: 140_000 },
    });
    expect(readFeedback()).toEqual([]);
  });
});
