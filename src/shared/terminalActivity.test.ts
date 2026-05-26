import {
  deriveTerminalBuffers,
  extractTerminalActivityEntries,
} from "./terminalActivity";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../agent/webview/types";

function assistantMessage(blocks: ChatMessage["blocks"]): ChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    timestamp: 1,
    blocks,
  };
}

describe("extractTerminalActivityEntries", () => {
  it("ignores non-assistant messages and non-terminal tool calls", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "run it",
        timestamp: 1,
        blocks: [],
      },
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-1",
          name: "read_file",
          inputJson: JSON.stringify({ path: "src/app.ts" }),
          result: JSON.stringify({ ok: true }),
          complete: true,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([]);
  });

  it("extracts running execute_command activity", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-exec",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: "",
          complete: false,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([
      expect.objectContaining({
        toolCallId: "tool-exec",
        kind: "execute_command",
        command: "npm test",
        status: "running",
      }),
    ]);
  });

  it("extracts execute_command terminal metadata from input and result", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-exec",
          name: "execute_command",
          inputJson: JSON.stringify({
            command: "npm test",
            cwd: "/workspace/agentlink",
            terminal_id: "term_input",
            terminal_name: "Tests",
            split_from: "term_parent",
            background: true,
            timeout: 30,
          }),
          result: JSON.stringify({
            terminal_id: "term_result",
            terminal_name: "AgentLink",
            exit_code: 0,
          }),
          complete: true,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([
      expect.objectContaining({
        command: "npm test",
        cwd: "/workspace/agentlink",
        terminalId: "term_result",
        terminalName: "AgentLink",
        splitFrom: "term_parent",
        background: true,
        timeoutSeconds: 30,
      }),
    ]);
  });

  it("marks execute_command non-zero exit as warning and captures output", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-exec",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: JSON.stringify({
            terminal_id: "term_1",
            exit_code: 2,
            output: "failed output",
          }),
          complete: true,
          durationMs: 1234,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([
      expect.objectContaining({
        toolCallId: "tool-exec",
        kind: "execute_command",
        terminalId: "term_1",
        exitCode: 2,
        output: "failed output",
        durationMs: 1234,
        status: "warning",
      }),
    ]);
  });

  it("marks terminal activity with explicit error payload as error", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-output",
          name: "get_terminal_output",
          inputJson: JSON.stringify({ terminal_id: "term_2" }),
          result: JSON.stringify({ error: "terminal missing" }),
          complete: true,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([
      expect.objectContaining({
        toolCallId: "tool-output",
        kind: "get_terminal_output",
        terminalId: "term_2",
        status: "error",
      }),
    ]);
  });

  it("extracts get_terminal_output terminal id from input and completed output", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-output",
          name: "get_terminal_output",
          inputJson: JSON.stringify({ terminal_id: "term_3" }),
          result: JSON.stringify({
            is_running: false,
            exit_code: 0,
            output: "ok",
          }),
          complete: true,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([
      expect.objectContaining({
        toolCallId: "tool-output",
        kind: "get_terminal_output",
        terminalId: "term_3",
        exitCode: 0,
        output: "ok",
        status: "completed",
      }),
    ]);
  });

  it("handles malformed tool JSON defensively", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-bad",
          name: "execute_command",
          inputJson: "{not-json",
          result: "{also-bad",
          complete: true,
        },
      ]),
    ];

    expect(extractTerminalActivityEntries(messages)).toEqual([
      expect.objectContaining({
        toolCallId: "tool-bad",
        kind: "execute_command",
        status: "completed",
      }),
    ]);
  });
});

describe("deriveTerminalBuffers", () => {
  it("creates an idle default buffer when no commands exist", () => {
    expect(
      deriveTerminalBuffers([], {
        workspaceName: "agentlink",
        gitBranch: "main",
        dirty: true,
      }),
    ).toEqual([
      expect.objectContaining({
        id: "terminal:default",
        label: "AgentLink",
        lines: [
          expect.objectContaining({
            id: "terminal:default:cursor",
            kind: "cursor",
            prompt: "➜  agentlink git:(main) ✗",
          }),
        ],
      }),
    ]);
  });

  it("groups foreground execute commands by terminal id", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-one",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo one" }),
          result: JSON.stringify({
            terminal_id: "term_1",
            terminal_name: "AgentLink",
            output: "one\n",
          }),
          complete: true,
        },
        {
          type: "tool_call",
          id: "tool-two",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo two" }),
          result: JSON.stringify({ terminal_id: "term_2", output: "two" }),
          complete: true,
        },
      ]),
    ];

    const buffers = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
    });

    expect(buffers).toHaveLength(2);
    expect(buffers[0]).toEqual(
      expect.objectContaining({
        id: "terminal:term_1",
        label: "AgentLink",
        lines: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-1:tool-one:command",
            kind: "command",
            text: "echo one",
          }),
          expect.objectContaining({
            id: "assistant-1:tool-one:output:0",
            kind: "output",
            text: "one",
          }),
        ]),
      }),
    );
    expect(buffers[1].id).toBe("terminal:term_2");
  });

  it("preserves raw terminal output chunks when present", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-raw",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: JSON.stringify({
            terminal_id: "term_1",
            output: "green plain",
            terminal_raw_output: "\u001b[32mgreen\u001b[0m\rplain",
          }),
          complete: true,
        },
      ]),
    ];

    const [buffer] = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
    });

    expect(buffer.chunks).toEqual([
      expect.objectContaining({
        id: "assistant-1:tool-raw:chunk",
        kind: "raw",
        text: "\u001b[32mgreen\u001b[0m\rplain",
        command: "npm test",
        prompt: "➜  agentlink git:(main)",
      }),
    ]);
    expect(buffer.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "command", text: "npm test" }),
        expect.objectContaining({ kind: "output", text: "green plain" }),
      ]),
    );
  });

  it("creates chunks for mixed raw and clean terminal output entries", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-old",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo old" }),
          result: JSON.stringify({ terminal_id: "term_1", output: "old" }),
          complete: true,
        },
        {
          type: "tool_call",
          id: "tool-new",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo new" }),
          result: JSON.stringify({
            terminal_id: "term_1",
            output: "new",
            terminal_raw_output: "\u001b[32mnew\u001b[0m",
          }),
          complete: true,
        },
      ]),
    ];

    const [buffer] = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
    });

    expect(buffer.chunks).toEqual([
      expect.objectContaining({
        id: "assistant-1:tool-old:chunk",
        command: "echo old",
        text: "old",
      }),
      expect.objectContaining({
        id: "assistant-1:tool-new:chunk",
        command: "echo new",
        text: "\u001b[32mnew\u001b[0m",
      }),
    ]);
  });

  it("filters completed closed-terminal history when known terminals are available", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-closed-one",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo closed one" }),
          result: JSON.stringify({
            terminal_id: "term_closed_1",
            output: "old",
          }),
          complete: true,
        },
        {
          type: "tool_call",
          id: "tool-open-one",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo open one" }),
          result: JSON.stringify({
            terminal_id: "term_open_1",
            output: "current",
          }),
          complete: true,
        },
        {
          type: "tool_call",
          id: "tool-closed-two",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo closed two" }),
          result: JSON.stringify({
            terminal_id: "term_closed_2",
            output: "old",
          }),
          complete: true,
        },
      ]),
    ];

    const buffers = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
      terminals: [
        { id: "term_open_1", name: "AgentLink", busy: false },
        { id: "term_open_2", name: "AgentLink", busy: false },
      ],
    });

    expect(buffers.map((buffer) => buffer.id)).toEqual([
      "terminal:term_open_1",
      "terminal:term_open_2",
    ]);
    expect(buffers[0].lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "command", text: "echo open one" }),
      ]),
    );
  });

  it("filters completed unassigned history when known terminals are available", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-unassigned",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "echo old" }),
          result: JSON.stringify({ output: "old" }),
          complete: true,
        },
      ]),
    ];

    const buffers = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
      terminals: [{ id: "term_open", name: "AgentLink", busy: false }],
    });

    expect(buffers.map((buffer) => buffer.id)).toEqual(["terminal:term_open"]);
    expect(buffers[0].lines).toEqual([
      expect.objectContaining({ kind: "cursor" }),
    ]);
  });

  it("keeps running closed-terminal entries until completion to avoid hiding active work", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-running",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: JSON.stringify({ terminal_id: "term_pending" }),
          complete: false,
        },
      ]),
    ];

    const buffers = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
      terminals: [{ id: "term_open", name: "AgentLink", busy: false }],
    });

    expect(buffers.map((buffer) => buffer.id)).toEqual([
      "terminal:term_pending",
      "terminal:term_open",
    ]);
  });

  it("associates an unassigned running command with a single busy terminal", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-running",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: "",
          complete: false,
        },
      ]),
    ];

    const buffers = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
      terminals: [{ id: "term_7", name: "AgentLink", busy: true }],
    });

    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toEqual(
      expect.objectContaining({
        id: "terminal:term_7",
        terminalId: "term_7",
        label: "AgentLink",
        lastStatus: "running",
      }),
    );
    expect(buffers[0].lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "command", text: "npm test" }),
      ]),
    );
  });

  it("keeps unassigned running commands in the default buffer when terminal match is ambiguous", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-running",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: "",
          complete: false,
        },
      ]),
    ];

    const buffers = deriveTerminalBuffers(messages, {
      workspaceName: "agentlink",
      terminals: [
        { id: "term_1", name: "AgentLink", busy: true },
        { id: "term_2", name: "AgentLink", busy: true },
      ],
    });

    expect(buffers.map((buffer) => buffer.id)).toContain("terminal:default");
  });

  it("skips background commands and get_terminal_output entries", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-bg",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "server", background: true }),
          result: JSON.stringify({ terminal_id: "term_bg", output: "ready" }),
          complete: true,
        },
        {
          type: "tool_call",
          id: "tool-output",
          name: "get_terminal_output",
          inputJson: JSON.stringify({ terminal_id: "term_bg" }),
          result: JSON.stringify({ output: "ready" }),
          complete: true,
        },
      ]),
    ];

    expect(
      deriveTerminalBuffers(messages, { workspaceName: "agentlink" }),
    ).toEqual([expect.objectContaining({ id: "terminal:default" })]);
  });

  it("uses cwd and git metadata in synthesized prompts", () => {
    const messages: ChatMessage[] = [
      assistantMessage([
        {
          type: "tool_call",
          id: "tool-exec",
          name: "execute_command",
          inputJson: JSON.stringify({
            command: "npm run lint",
            cwd: "/workspace/agentlink",
          }),
          result: JSON.stringify({ output: "ok" }),
          complete: true,
        },
      ]),
    ];

    const [buffer] = deriveTerminalBuffers(messages, {
      workspaceName: "workspace",
      gitBranch: "main",
      dirty: true,
    });

    expect(buffer.lines[0]).toEqual(
      expect.objectContaining({
        kind: "command",
        prompt: "➜  agentlink git:(main) ✗",
        text: "npm run lint",
      }),
    );
  });
});
