import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleDeleteFeedback } from "./deleteFeedback.js";
import { handleGetFeedback } from "./getFeedback.js";

const mocks = vi.hoisted(() => ({
  readFeedback: vi.fn(),
  deleteFeedback: vi.fn(),
}));

vi.mock("../util/feedbackStore.js", () => mocks);

function payload(result: Awaited<ReturnType<typeof handleGetFeedback>>) {
  const text = result.content.find((item) => item.type === "text")?.text;
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

describe("feedback tools", () => {
  beforeEach(() => {
    mocks.readFeedback.mockReset();
    mocks.deleteFeedback.mockReset();
  });

  it("returns stable IDs and global indices from filtered reads", async () => {
    mocks.readFeedback.mockReturnValue([
      {
        id: "feedback-id",
        global_index: 7,
        timestamp: "2026-01-01T00:00:00.000Z",
        tool_name: "execute_command",
        feedback: "busy terminal",
        extension_version: "1.0.0",
      },
    ]);

    const result = await handleGetFeedback({ tool_name: "execute_command" });

    expect(mocks.readFeedback).toHaveBeenCalledWith("execute_command");
    expect(payload(result)).toEqual({
      status: "success",
      count: 1,
      entries: [
        expect.objectContaining({ id: "feedback-id", global_index: 7 }),
      ],
    });
  });

  it("deletes by ID and returns exact removal metadata", async () => {
    mocks.deleteFeedback.mockReturnValue({
      removed: [
        {
          id: "feedback-id",
          global_index: 7,
          timestamp: "2026-01-01T00:00:00.000Z",
          tool_name: "execute_command",
          feedback: "busy terminal",
          extension_version: "1.0.0",
        },
      ],
      already_deleted_ids: ["old-id"],
      unknown_ids: ["missing-id"],
      unknown_indices: [],
    });

    const result = await handleDeleteFeedback({
      ids: ["feedback-id", "old-id", "missing-id"],
    });

    expect(mocks.deleteFeedback).toHaveBeenCalledWith({
      ids: ["feedback-id", "old-id", "missing-id"],
    });
    expect(payload(result)).toEqual({
      status: "success",
      removed: 1,
      removed_entries: [
        expect.objectContaining({ id: "feedback-id", global_index: 7 }),
      ],
      already_deleted_ids: ["old-id"],
      unknown_ids: ["missing-id"],
      unknown_indices: [],
    });
  });

  it("returns selector errors as failed tool results", async () => {
    mocks.deleteFeedback.mockImplementation(() => {
      throw new Error("Provide exactly one selector.");
    });

    const result = await handleDeleteFeedback({});

    expect(result.isError).toBe(true);
    expect(result.error).toEqual({
      kind: "invalid_feedback_selector",
      message: "Provide exactly one selector.",
    });
  });

  it("forwards legacy global indices without treating them as filtered positions", async () => {
    mocks.deleteFeedback.mockReturnValue({
      removed: [],
      already_deleted_ids: [],
      unknown_ids: [],
      unknown_indices: [],
    });

    await handleDeleteFeedback({ indices: [7] });

    expect(mocks.deleteFeedback).toHaveBeenCalledWith({ indices: [7] });
  });
});
