import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleSendFeedback } from "./sendFeedback.js";

const mocks = vi.hoisted(() => ({
  appendFeedback: vi.fn(),
}));

vi.mock("vscode", () => ({
  extensions: {
    getExtension: vi.fn(() => ({ packageJSON: { version: "1.2.3" } })),
  },
  workspace: {
    get workspaceFolders(): never {
      throw new Error(
        "workspace folders must not be used for feedback attribution",
      );
    },
  },
}));

vi.mock("../util/feedbackStore.js", async (importOriginal) => ({
  FeedbackRecordError: (
    await importOriginal<typeof import("../util/feedbackStore.js")>()
  ).FeedbackRecordError,
  appendFeedback: mocks.appendFeedback,
}));

function payload(result: Awaited<ReturnType<typeof handleSendFeedback>>) {
  const item = result.content[0];
  return JSON.parse(item?.type === "text" ? item.text : "{}");
}

describe("handleSendFeedback", () => {
  beforeEach(() => {
    mocks.appendFeedback.mockReset();
    mocks.appendFeedback.mockReturnValue({
      id: "feedback-id",
      global_index: 7,
      content_capture: {
        version: 1,
        storage: "inline",
        bytes: 120,
        sha256: "a".repeat(64),
        truncated_fields: [],
      },
    });
  });

  it("maps size, storage and unknown-state failures without claiming success", async () => {
    const { FeedbackRecordError } = await import("../util/feedbackStore.js");
    const input = {
      tool_name: "read_file",
      feedback: "Unexpected result",
      observed_impact: "Extra read",
    };
    mocks.appendFeedback.mockImplementationOnce(() => {
      throw new FeedbackRecordError("feedback_too_large", "too large", {
        actual_bytes: 200_000,
        max_bytes: 131_072,
        field_bytes: { tool_params: 199_000 },
      });
    });
    expect(payload(await handleSendFeedback(input, "s"))).toMatchObject({
      status: "rejected",
      code: "feedback_too_large",
      recorded: false,
      field_bytes: { tool_params: 199_000 },
    });
    mocks.appendFeedback.mockImplementationOnce(() => {
      throw new FeedbackRecordError("feedback_storage_failed", "no disk");
    });
    expect(payload(await handleSendFeedback(input, "s"))).toMatchObject({
      status: "error",
      recorded: false,
    });
    mocks.appendFeedback.mockImplementationOnce(() => {
      throw new FeedbackRecordError("feedback_recording_unknown", "unknown", {
        id: "maybe-id",
      });
    });
    const unknown = payload(await handleSendFeedback(input, "s"));
    expect(unknown).toMatchObject({
      status: "unknown",
      recording_state: "unknown",
      id: "maybe-id",
    });
    expect(unknown.guidance).toContain("Do not resubmit automatically");
    expect(unknown.guidance).toContain("coordinator or user");
  });

  it("reports shortened preview fields in the acknowledgement", async () => {
    mocks.appendFeedback.mockReturnValueOnce({
      id: "long-id",
      global_index: 3,
      content_capture: {
        version: 1,
        storage: "overflow",
        bytes: 9000,
        sha256: "b".repeat(64),
        truncated_fields: ["feedback", "tool_params"],
      },
    });
    expect(
      payload(
        await handleSendFeedback(
          { tool_name: "agentlink", feedback: "long", observed_impact: "x" },
          "s",
        ),
      ),
    ).toMatchObject({
      status: "recorded",
      content_preserved: true,
      content_bytes: 9000,
      preview_truncated: true,
      truncated_fields: ["feedback", "tool_params"],
      full_record: { tool: "get_feedback", input: { id: "long-id" } },
    });
  });

  it("rejects empty or whitespace-only feedback without recording it", async () => {
    for (const feedback of ["", " \n\t "]) {
      const result = await handleSendFeedback(
        {
          tool_name: "read_file",
          feedback,
          observed_impact: "Extra read required",
        },
        "session-empty",
      );

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify({
          status: "rejected",
          error:
            "feedback must describe a concrete, actionable AgentLink issue and cannot be empty or whitespace-only",
        }),
      });
    }
    expect(mocks.appendFeedback).not.toHaveBeenCalled();
  });

  it("trims recorded feedback without changing its content", async () => {
    await handleSendFeedback(
      {
        tool_name: "read_file",
        feedback: "  Unexpected result  ",
        observed_impact: "  Required another read  ",
        workaround: "  Used a direct read  ",
        observed_recurrence: "  Once in this session  ",
        improvement_signal: "  First read returns usable content  ",
        category: "bug",
        suspected_cause: "  The result may have been truncated  ",
        suggested_change: "  Return continuation arguments  ",
      },
      "session-trimmed",
    );

    expect(mocks.appendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: "Unexpected result",
        observed_impact: "Required another read",
        workaround: "Used a direct read",
        observed_recurrence: "Once in this session",
        improvement_signal: "First read returns usable content",
        category: "bug",
        suspected_cause: "The result may have been truncated",
        suggested_change: "Return continuation arguments",
      }),
    );
  });

  it("rejects missing, empty or whitespace-only impact without recording", async () => {
    for (const observed_impact of [undefined, "", " \n\t "]) {
      const result = await handleSendFeedback(
        {
          tool_name: "read_file",
          feedback: "Unexpected result",
          observed_impact: observed_impact as string,
        },
        "session-empty-impact",
      );

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: JSON.stringify({
          status: "rejected",
          error:
            "observed_impact must describe the concrete consequence for the current task and cannot be missing, empty or whitespace-only",
        }),
      });
    }
    expect(mocks.appendFeedback).not.toHaveBeenCalled();
  });

  it("omits blank optional context without inventing values", async () => {
    await handleSendFeedback(
      {
        tool_name: "read_file",
        feedback: "Unexpected result",
        observed_impact: "Required another read",
        workaround: " \n ",
        observed_recurrence: "",
        improvement_signal: "\t",
        suspected_cause: " \n ",
        suggested_change: "\t",
      },
      "session-blank-context",
    );

    expect(mocks.appendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        workaround: undefined,
        observed_recurrence: undefined,
        improvement_signal: undefined,
        category: undefined,
        suspected_cause: undefined,
        suggested_change: undefined,
      }),
    );
  });

  it.each(["improvement", "feature_request"] as const)(
    "records a grounded %s after a successful task without inventing a cause",
    async (category) => {
      await handleSendFeedback(
        {
          tool_name: "agentlink",
          feedback: "A shared session comparison would simplify handoffs",
          observed_impact:
            "Task succeeded after manually comparing two histories",
          category,
          suggested_change: "Show a side-by-side session comparison",
        },
        "successful-task-session",
      );
      expect(mocks.appendFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_name: "agentlink",
          category,
          suspected_cause: undefined,
          suggested_change: "Show a side-by-side session comparison",
        }),
      );
    },
  );

  it("attributes feedback with only the supplied opaque project ID", async () => {
    const result = await handleSendFeedback(
      {
        tool_name: "read_file",
        feedback: "Unexpected result",
        observed_impact: "Needed another read",
        tool_params: '{"path":"/sensitive/root/file.ts"}',
      },
      "session-1",
      "project-0123456789abcdef",
    );

    expect(mocks.appendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: "read_file",
        feedback: "Unexpected result",
        session_id: "session-1",
        workspace: "project-0123456789abcdef",
        extension_version: "1.2.3",
      }),
    );
    expect(payload(result)).toMatchObject({
      status: "recorded",
      id: "feedback-id",
      global_index: 7,
      tool_name: "read_file",
      content_preserved: true,
      preview_truncated: false,
      truncated_fields: [],
    });
  });

  it("preserves feedback recording without project scope", async () => {
    const result = await handleSendFeedback(
      {
        tool_name: "search_files",
        feedback: "Suggestion",
        observed_impact: "Extra search required",
      },
      "session-2",
    );

    expect(mocks.appendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-2",
        workspace: undefined,
      }),
    );
    expect(payload(result)).toMatchObject({
      status: "recorded",
      id: "feedback-id",
      global_index: 7,
      tool_name: "search_files",
    });
  });
});
