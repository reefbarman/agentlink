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

  it("attributes feedback with only the supplied opaque project ID", async () => {
    const result = await handleSendFeedback(
      {
        tool_name: "read_file",
        feedback: "Unexpected result",
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
