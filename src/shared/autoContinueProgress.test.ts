import {
  AUTO_CONTINUE_NO_PROGRESS_REASON,
  isProgressToolName,
  turnMadeProgress,
} from "./autoContinueProgress.js";
import { describe, expect, it } from "vitest";

describe("auto-continue progress protocol compatibility shim", () => {
  it("preserves the legacy reason and projection behavior", () => {
    expect(AUTO_CONTINUE_NO_PROGRESS_REASON).toContain(
      "last turn completed without making further changes",
    );
    expect(isProgressToolName("write_file")).toBe(true);
    expect(
      turnMadeProgress(
        [
          { id: "auto-user", role: "user" },
          {
            id: "assistant-1",
            role: "assistant",
            blocks: [{ type: "tool_call", name: "read_file" }],
          },
        ],
        "auto-user",
      ),
    ).toBe(false);
  });
});
