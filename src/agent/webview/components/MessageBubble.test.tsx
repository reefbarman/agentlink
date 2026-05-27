// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

afterEach(() => {
  cleanup();
});

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
    expect(
      container.querySelector(".slash-standalone-command-args"),
    ).toBeTruthy();
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

  it("renders final marker UI for completed historical messages", () => {
    const message: ChatMessage = {
      id: "assistant-final-historical",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Earlier completed response." }],
      finalMarker: {
        status: "completed",
        source: "tool",
      },
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    expect(screen.getByText("Earlier completed response.")).toBeTruthy();
    expect(screen.getByText("Task complete")).toBeTruthy();
    expect(container.querySelector(".assistant-final-region")).toBeTruthy();
    expect(container.querySelector(".assistant-message-final")).toBeNull();
  });

  it("does not show the empty response fallback for marker-only final messages", () => {
    const message: ChatMessage = {
      id: "assistant-final-marker-only",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "Completed with no text body.",
      },
    };

    render(<MessageBubble message={message} streaming={false} />);

    expect(screen.getByText("Task complete")).toBeTruthy();
    expect(screen.getByText("Completed with no text body.")).toBeTruthy();
    expect(screen.queryByText("(No response)")).toBeNull();
  });

  it("renders explicit final marker CTA below the marker text when visible", () => {
    const onContinue = vi.fn();
    const message: ChatMessage = {
      id: "assistant-final-visible",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Latest completed response." }],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "Ready for the next step.",
        continueAction: {
          label: "Implement this",
          prompt: "Please implement this plan.",
        },
      },
    };

    const { container } = render(
      <MessageBubble
        message={message}
        streaming={false}
        onFinalMarkerContinue={onContinue}
      />,
    );

    const finalRegion = container.querySelector(".assistant-final-region");
    const header = container.querySelector(".final-marker-header");
    const actions = container.querySelector(".final-marker-actions");
    expect(finalRegion).toBeTruthy();
    expect(container.querySelector(".assistant-message-final")).toBeNull();
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain("Task complete");
    expect(actions).toBeTruthy();
    expect(actions?.textContent).toContain("Ready for the next step.");
    expect(actions?.querySelector(".final-marker-continue")?.tagName).toBe(
      "BUTTON",
    );
    const button = screen.getByRole("button", { name: "Implement this" });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith("Please implement this plan.");
    expect(finalRegion?.textContent).not.toContain(
      "Latest completed response.",
    );
  });

  it("renders a default Continue CTA for completed final markers without explicit continuation", () => {
    const onContinue = vi.fn();
    const message: ChatMessage = {
      id: "assistant-final-default-continue",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "All requested work is complete.",
      },
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        onFinalMarkerContinue={onContinue}
      />,
    );

    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledWith(
      "Continue working from where you left off. If there are remaining subtasks, do the next one; if everything is complete, briefly confirm that no further work is needed.",
    );
  });

  it("renders an Auto Continue stopped indicator on final markers", () => {
    const message: ChatMessage = {
      id: "assistant-final-auto-stopped",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "Still has follow-up context.",
        autoContinueStopReason:
          "Auto Continue stopped after 10 turns to avoid an infinite loop.",
      },
    };

    const { container } = render(
      <MessageBubble
        message={message}
        streaming={false}
        onFinalMarkerContinue={vi.fn()}
      />,
    );

    const stopped = container.querySelector(
      ".final-marker-auto-continue-stopped",
    );
    expect(stopped).toBeTruthy();
    expect(stopped?.textContent).toContain(
      "Auto Continue stopped after 10 turns to avoid an infinite loop.",
    );
  });

  it("does not render a default Continue CTA when completed final marker suppresses continuation", () => {
    const message: ChatMessage = {
      id: "assistant-final-suppressed-continue",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "All requested work is complete.",
        continueActionSuppressed: true,
      },
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        onFinalMarkerContinue={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("does not render a default Continue CTA for blocked final markers", () => {
    const message: ChatMessage = {
      id: "assistant-final-blocked-no-default",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "blocked",
        source: "tool",
        summary: "Cannot proceed without credentials.",
      },
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        onFinalMarkerContinue={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("renders final marker summaries with normal markdown and file links", () => {
    const onOpenFile = vi.fn();
    const message: ChatMessage = {
      id: "assistant-final-markdown",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary:
          "Implemented **markdown summaries** and validated `MessageBubble`. See @src/agent/webview/components/MessageBubble.tsx:424.",
      },
    };

    const { container } = render(
      <MessageBubble
        message={message}
        streaming={false}
        onOpenFile={onOpenFile}
      />,
    );

    const finalRegion = container.querySelector(".assistant-final-region");
    const summary = finalRegion?.querySelector(".final-marker-summary");
    expect(summary?.querySelector(".markdown-body")).toBeTruthy();
    expect(summary?.querySelector("strong")?.textContent).toBe(
      "markdown summaries",
    );

    const fileLink = summary?.querySelector(
      ".file-path-link",
    ) as HTMLAnchorElement | null;
    expect(fileLink?.textContent).toBe(
      "@src/agent/webview/components/MessageBubble.tsx:424",
    );

    fireEvent.click(fileLink as HTMLAnchorElement);
    expect(onOpenFile).toHaveBeenCalledWith(
      "src/agent/webview/components/MessageBubble.tsx",
      424,
    );
  });

  it("wires final marker special block popouts to the normal special block handler", () => {
    const onOpenSpecialBlockPanel = vi.fn();
    const message: ChatMessage = {
      id: "assistant-final-special-block",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "```mermaid\ngraph TD\n  A --> B\n```",
      },
    };

    const { container } = render(
      <MessageBubble
        message={message}
        streaming={false}
        onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
      />,
    );

    const popout = container.querySelector(
      ".final-marker-summary .special-block-popout",
    ) as HTMLButtonElement | null;
    expect(popout).toBeTruthy();

    fireEvent.click(popout as HTMLButtonElement);
    expect(onOpenSpecialBlockPanel).toHaveBeenCalledWith({
      kind: "mermaid",
      source: "graph TD\n  A --> B",
    });
  });

  it("scopes final marker highlighting to the final marker region", () => {
    const message: ChatMessage = {
      id: "assistant-final-with-prior-blocks",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [
        { type: "text", text: "I will verify this first." },
        {
          type: "tool_call",
          id: "tool-verify",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: JSON.stringify({ ok: true }),
          complete: true,
        },
      ],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "Done — the final summary only should be highlighted.",
      },
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    const finalRegion = container.querySelector(".assistant-final-region");
    expect(screen.getByText("I will verify this first.")).toBeTruthy();
    expect(screen.getByText("Task complete")).toBeTruthy();
    expect(finalRegion).toBeTruthy();
    expect(finalRegion?.textContent).toContain("Task complete");
    expect(finalRegion?.textContent).toContain(
      "Done — the final summary only should be highlighted.",
    );
    expect(finalRegion?.textContent).not.toContain("I will verify this first.");
    expect(finalRegion?.querySelector(".tool-call-block")).toBeNull();
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
