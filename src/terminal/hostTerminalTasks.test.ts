import {
  MAX_HOST_TERMINAL_TASKS_FILE_BYTES,
  composeHostTerminalTaskCommand,
  createHostTerminalTasksRevision,
  parseHostTerminalTasks,
  quoteHostShellArgument,
} from "./hostTerminalTasks.js";
import { describe, expect, it } from "vitest";

import { Buffer } from "node:buffer";
import { MAX_TERMINAL_INPUT_BYTES } from "@agentlink/protocol/terminal-surface";

describe("hostTerminalTasks", () => {
  it("parses valid tasks and skips invalid entries", () => {
    expect(
      parseHostTerminalTasks(
        JSON.stringify({
          tasks: [
            { label: "Build", command: "npm run build" },
            { label: "Tests", command: "npm test", cwd: "packages/app" },
            { label: "", command: "false" },
          ],
        }),
      ),
    ).toEqual({
      tasks: [
        { id: "task-0", label: "Build", command: "npm run build" },
        {
          id: "task-1",
          label: "Tests",
          command: "npm test",
          cwd: "packages/app",
        },
      ],
      errors: ["Task 3 has an invalid label"],
    });
  });

  it("rejects invalid and oversized files", () => {
    expect(parseHostTerminalTasks("{").errors).toEqual([
      "tasks.json is not valid JSON",
    ]);
    expect(parseHostTerminalTasks(JSON.stringify({})).errors).toEqual([
      'tasks.json must contain a "tasks" array',
    ]);
    expect(
      parseHostTerminalTasks("x".repeat(MAX_HOST_TERMINAL_TASKS_FILE_BYTES + 1))
        .errors,
    ).toEqual(["tasks.json exceeds the 256 KB limit"]);
  });

  it("changes revisions when an existing label's command changes", () => {
    const first = [{ id: "task-0", label: "Build", command: "npm run build" }];
    const second = [{ id: "task-0", label: "Build", command: "npm run lint" }];
    expect(createHostTerminalTasksRevision("/workspace", first)).not.toBe(
      createHostTerminalTasksRevision("/workspace", second),
    );
  });

  it("quotes shell arguments and bounds the final composed command", () => {
    expect(quoteHostShellArgument("/it's here")).toBe("'/it'\"'\"'s here'");
    expect(
      composeHostTerminalTaskCommand(
        { id: "task-0", label: "Test", command: "npm test" },
        "/workspace/it's here",
      ),
    ).toBe("(cd '/workspace/it'\"'\"'s here' && npm test)");

    const command = "x".repeat(MAX_TERMINAL_INPUT_BYTES - 1);
    expect(
      Buffer.byteLength(
        composeHostTerminalTaskCommand({
          id: "task-0",
          label: "Large",
          command,
        }) ?? "",
        "utf8",
      ),
    ).toBe(MAX_TERMINAL_INPUT_BYTES - 1);
    expect(
      composeHostTerminalTaskCommand(
        { id: "task-0", label: "Large", command },
        "/workspace",
      ),
    ).toBeUndefined();
  });
});
