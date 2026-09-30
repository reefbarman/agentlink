import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
    ]) {
      expect(retrieved.entries[0]).not.toHaveProperty(field);
    }
  });
});
