import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";

import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble slash-command rendering", () => {
  it("renders standalone slash command as a tool-call-style block with args", () => {
    const message: ChatMessage = {
      id: "user-1",
      role: "user",
      content: "/review src/agent/webview/App.tsx",
      timestamp: Date.now(),
      blocks: [],
      isSlashCommand: true,
      slashCommandLabel: "/review src/agent/webview/App.tsx",
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(container.querySelector(".tool-call-block")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByText("src/agent/webview/App.tsx")).toBeTruthy();
    expect(container.querySelector(".slash-tool-call-args")).toBeTruthy();
    expect(container.querySelector(".user-content")).toBeNull();
  });

  it("renders slash command chip in attachment row for non-standalone user text", () => {
    const message: ChatMessage = {
      id: "user-2",
      role: "user",
      content: "Please run this\n[Attached: src/agent/webview/App.tsx]",
      timestamp: Date.now(),
      blocks: [],
      isSlashCommand: true,
      slashCommandLabel: "/snapshot latest",
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(container.querySelector(".user-attachments")).toBeTruthy();
    expect(
      container.querySelector(".user-attachment-slash-command"),
    ).toBeTruthy();
    expect(screen.getByText("/snapshot latest")).toBeTruthy();
    expect(container.querySelector(".user-slash-command-tool-call")).toBeNull();
  });

  it("renders attachment markers as basename chips and removes them from the message body", () => {
    const message: ChatMessage = {
      id: "user-3",
      role: "user",
      content:
        "Please inspect this file\n[Attached: src/agent/webview/App.tsx]",
      timestamp: Date.now(),
      blocks: [],
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(container.querySelector(".user-attachments")).toBeTruthy();
    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(
      screen.queryByText("[Attached: src/agent/webview/App.tsx]"),
    ).toBeNull();
    expect(screen.getByText("Please inspect this file")).toBeTruthy();
  });

  it("renders inline @path mentions as clickable file links in user text", () => {
    const onOpenFile = vi.fn();
    const message: ChatMessage = {
      id: "user-inline-mention",
      role: "user",
      content: "Please check @src/agent/webview/App.tsx before continuing",
      timestamp: Date.now(),
      blocks: [],
    };

    const { container } = render(
      <MessageBubble
        message={message}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const fileLink = container.querySelector(
      ".file-path-link",
    ) as HTMLAnchorElement;
    expect(fileLink).toBeTruthy();
    expect(fileLink.textContent).toBe("@src/agent/webview/App.tsx");

    fireEvent.click(fileLink);
    expect(onOpenFile).toHaveBeenCalledWith(
      "src/agent/webview/App.tsx",
      undefined,
    );
  });

  it("opens inline @path:line mentions at the referenced line", () => {
    const onOpenFile = vi.fn();
    const message: ChatMessage = {
      id: "user-inline-mention-line",
      role: "user",
      content: "Please check @src/agent/webview/App.tsx:42 before continuing",
      timestamp: Date.now(),
      blocks: [],
    };

    const { container } = render(
      <MessageBubble
        message={message}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const fileLink = container.querySelector(
      ".file-path-link",
    ) as HTMLAnchorElement;
    expect(fileLink).toBeTruthy();
    expect(fileLink.textContent).toBe("@src/agent/webview/App.tsx:42");
    expect(fileLink.title).toContain("src/agent/webview/App.tsx:42");

    fireEvent.click(fileLink);
    expect(onOpenFile).toHaveBeenCalledWith("src/agent/webview/App.tsx", 42);
  });

  it("renders detected question fallback options and dispatches selected payload", () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Proceed?" }],
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        detectedQuestion={{
          messageId: "assistant-1",
          kind: "yes_no",
          prompt: "Proceed?",
          options: [
            { label: "Yes", payload: "Yes, proceed with test updates." },
            { label: "No", payload: "No" },
          ],
        }}
        onDetectedQuestionAnswer={onAnswer}
        onDismissDetectedQuestion={onDismiss}
      />,
    );

    expect(screen.getByText("Detected choice prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onAnswer).toHaveBeenCalledWith("Yes, proceed with test updates.");
    expect(onDismiss).toHaveBeenCalledWith("assistant-1");
  });

  it("collapses detected question options after the first 6 and expands on demand", () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    const message: ChatMessage = {
      id: "assistant-3",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Pick one" }],
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        detectedQuestion={{
          messageId: "assistant-3",
          kind: "single_choice",
          prompt: "Pick one",
          options: [
            { label: "One", payload: "One" },
            { label: "Two", payload: "Two" },
            { label: "Three", payload: "Three" },
            { label: "Four", payload: "Four" },
            { label: "Five", payload: "Five" },
            { label: "Six", payload: "Six" },
            { label: "Seven", payload: "Seven" },
            { label: "Eight", payload: "Eight" },
          ],
        }}
        onDetectedQuestionAnswer={onAnswer}
        onDismissDetectedQuestion={onDismiss}
      />,
    );

    expect(screen.getByRole("button", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Six" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seven" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eight" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));

    expect(screen.getByRole("button", { name: "Seven" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Eight" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show 2 more" })).toBeNull();
  });

  it("renders MCP approval promotion actions for completed tool calls", () => {
    const onPromote = vi.fn();
    const message: ChatMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [
        {
          type: "tool_call",
          id: "tool-1",
          name: "notion__search",
          inputJson: JSON.stringify({ query: "docs" }),
          result: JSON.stringify({ ok: true }),
          complete: true,
          durationMs: 12,
          mcpApprovalPromotion: {
            serverName: "notion",
            bareToolName: "search",
            scopes: ["session", "project", "global"],
          },
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        onPromoteMcpToolApproval={onPromote}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /notion__search/i }));
    expect(
      screen.getByText(/promote this one-time mcp approval/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /allow for global/i }));
    expect(onPromote).toHaveBeenCalledWith({
      serverName: "notion",
      bareToolName: "search",
      scope: "global",
    });
    expect(
      screen.queryByRole("button", { name: /allow for global/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /allow for session/i }),
    ).toBeTruthy();
  });
});
