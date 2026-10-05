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

vi.mock("../util/feedbackStore.js", () => ({
  appendFeedback: mocks.appendFeedback,
}));

describe("handleSendFeedback", () => {
  beforeEach(() => {
    mocks.appendFeedback.mockReset();
    mocks.appendFeedback.mockReturnValue({
      id: "feedback-id",
      global_index: 7,
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
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({
        status: "recorded",
        id: "feedback-id",
        global_index: 7,
        tool_name: "read_file",
      }),
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
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: JSON.stringify({
        status: "recorded",
        id: "feedback-id",
        global_index: 7,
        tool_name: "search_files",
      }),
    });
  });
});
