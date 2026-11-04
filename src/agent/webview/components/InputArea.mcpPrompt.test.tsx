// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import type { ChatSlashCommandInfo } from "@agentlink/protocol/chat-catalog";
import { InputArea } from "./InputArea";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
const command: ChatSlashCommandInfo = {
  name: "fixture:ask",
  description: "Ask a peer",
  source: "mcp",
  builtin: false,
  mcpPrompt: {
    serverName: "fixture",
    promptName: "ask",
    completions: true,
    arguments: [
      { name: "to", required: true },
      { name: "question", required: true },
    ],
  },
};
function setup(slashCommands: ChatSlashCommandInfo[] = [command]) {
  const onSend = vi.fn();
  const postMessage = vi.fn();
  const props = {
    onSend,
    onStop: vi.fn(),
    streaming: false,
    reasoningEffort: "none" as const,
    onSetReasoningEffort: vi.fn(),
    onExportTranscript: vi.fn(),
    hasMessages: true,
    vscodeApi: { postMessage },
    injection: null,
    onInjectionConsumed: vi.fn(),
    slashCommands,
    mcpSessionId: "owner-a",
  };
  const view = render(<InputArea {...props} />);
  const input = view.container.querySelector(
    ".chat-input",
  ) as HTMLTextAreaElement;
  return { ...view, input, props, onSend, postMessage };
}
function request(post: ReturnType<typeof vi.fn>, name: string) {
  return post.mock.calls
    .map(([value]) => value)
    .find((value) => value.command === name);
}

describe("shared composer MCP prompts", () => {
  it("finds MCP prompts by a server-name prefix and selects them without sending", () => {
    const test = setup([
      {
        ...command,
        name: "agent-comms:status",
        mcpPrompt: {
          serverName: "agent-comms",
          promptName: "status",
          arguments: [],
        },
      },
    ]);
    fireEvent.input(test.input, { target: { value: "/", selectionStart: 1 } });
    fireEvent.input(test.input, {
      target: { value: "/age", selectionStart: 4 },
    });
    const option = test.getByRole("option", { name: /agent-comms:status/ });
    fireEvent.click(option);
    expect(test.input.value).toBe("/agent-comms:status ");
    expect(test.onSend).not.toHaveBeenCalled();
    expect(request(test.postMessage, "agentPrepareMcpPrompt")).toBeUndefined();
  });

  it("sends no text until the host returns the approved prompt", async () => {
    const test = setup();
    fireEvent.input(test.input, {
      target: { value: "/fixture:ask tab-2 check build?" },
    });
    fireEvent.keyDown(test.input, { key: "Enter" });
    const sent = request(test.postMessage, "agentPrepareMcpPrompt");
    expect(sent.invocation).toEqual({
      serverName: "fixture",
      promptName: "ask",
      arguments: { to: "tab-2", question: "check build?" },
      completions: true,
    });
    expect(test.onSend).not.toHaveBeenCalled();
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentMcpPromptPrepared",
          requestId: sent.requestId,
          ok: true,
          text: "<mcp_prompt>approved server text</mcp_prompt>",
        },
      }),
    );
    await waitFor(() => expect(test.onSend).toHaveBeenCalledOnce());
    expect(test.onSend.mock.calls[0][0]).toContain("approved server text");
  });

  it("retains the draft on denial and ignores an approval after switching chats", async () => {
    const test = setup();
    fireEvent.input(test.input, {
      target: { value: "/fixture:ask tab-2 question" },
    });
    fireEvent.keyDown(test.input, { key: "Enter" });
    const sent = request(test.postMessage, "agentPrepareMcpPrompt");
    test.rerender(<InputArea {...test.props} mcpSessionId="owner-b" />);
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentMcpPromptPrepared",
          requestId: sent.requestId,
          ok: true,
          text: "late text",
        },
      }),
    );
    await waitFor(() =>
      expect(test.queryByText("Waiting for MCP prompt approval")).toBeNull(),
    );
    expect(test.onSend).not.toHaveBeenCalled();
  });

  it("requests argument completions with context and inserts a selected suggestion", async () => {
    const test = setup();
    fireEvent.input(test.input, { target: { value: "/fixture:ask tab" } });
    await waitFor(() =>
      expect(request(test.postMessage, "agentCompleteMcpPrompt")).toBeTruthy(),
    );
    const sent = request(test.postMessage, "agentCompleteMcpPrompt");
    expect(sent.request).toMatchObject({ argumentName: "to", value: "tab" });
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: "agentMcpPromptCompletions",
          requestId: sent.requestId,
          values: ["tab-2"],
        },
      }),
    );
    fireEvent.click(await test.findByRole("button", { name: "tab-2" }));
    expect(test.input.value).toBe("/fixture:ask tab-2 ");
  });
});
