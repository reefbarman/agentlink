// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMessagesToChatMessages, initialState, reducer } from "../App";

import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

const TOOL_GROUP_SETTLE_MS_FOR_TEST = 350;

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("MessageBubble memory disclosure rendering", () => {
  it("renders compact memory source metadata without raw transcript text", () => {
    const message: ChatMessage = {
      id: "assistant-memory",
      role: "assistant",
      content: "Memory-informed answer.",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Memory-informed answer." }],
      memoryDisclosure: {
        status: "used",
        summaryCount: 2,
        transcriptExcerptCount: 1,
        sources: [
          {
            kind: "summary",
            label: "summary:prior-memory-chunk",
            title: "Prior browser memory discussion",
            score: 0.74,
          },
          {
            kind: "transcript",
            label: "transcript:prior-memory-chunk",
            title: "Prior browser memory discussion",
            score: 0.72,
          },
        ],
      },
    };

    render(<MessageBubble message={message} streaming={false} />);

    expect(
      screen.getByText(
        "Memory used · 2 memory summaries, 1 transcript excerpt",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Prior browser memory discussion")).toHaveLength(
      2,
    );
    expect(screen.getByText("74%")).toBeTruthy();
    expect(screen.getByText("72%")).toBeTruthy();
    expect(
      screen.getByText(/background recall, not as durable instructions/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Should Browser Ask Agent memory be injected as user text?",
      ),
    ).toBeNull();
  });

  it("does not render memory disclosure when metadata is absent", () => {
    const message: ChatMessage = {
      id: "assistant-no-memory",
      role: "assistant",
      content: "Plain answer.",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Plain answer." }],
    };

    render(<MessageBubble message={message} streaming={false} />);

    expect(screen.queryByText(/Memory used/)).toBeNull();
  });
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

  it("renders attached image previews above user message text", () => {
    const message: ChatMessage = {
      id: "user-image",
      role: "user",
      content: "[1 image attached]\nPlease inspect this screenshot",
      timestamp: Date.now(),
      blocks: [],
      displayMedia: {
        images: [
          {
            name: "screenshot.png",
            mimeType: "image/png",
            src: "data:image/png;base64,abc123",
          },
        ],
        documents: [],
      },
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    const preview = container.querySelector(
      ".user-image-preview",
    ) as HTMLImageElement;
    expect(preview).toBeTruthy();
    expect(preview.src).toBe("data:image/png;base64,abc123");
    expect(preview.alt).toBe("screenshot.png");
    expect(screen.getByText("1 image attached")).toBeTruthy();
    expect(screen.getByText("Please inspect this screenshot")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open screenshot.png" }),
    );
    const dialog = screen.getByRole("dialog", { name: "screenshot.png" });
    expect(dialog).toBeTruthy();
    const fullPreview = container.querySelector(
      ".user-image-lightbox-image",
    ) as HTMLImageElement;
    expect(fullPreview).toBeTruthy();
    expect(fullPreview.src).toBe("data:image/png;base64,abc123");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "screenshot.png" })).toBeNull();
  });

  it("renders inline code and fenced code blocks in user text", () => {
    const message: ChatMessage = {
      id: "user-code-markdown",
      role: "user",
      content:
        "Please run `npm test` after this:\n```ts\nconst answer = 42;\n```",
      timestamp: Date.now(),
      blocks: [],
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    const inlineCode = Array.from(
      container.querySelectorAll(".user-content code"),
    ).find((node) => node.textContent === "npm test");
    expect(inlineCode).toBeTruthy();

    const fencedCode = container.querySelector(
      ".user-content pre code.language-ts",
    );
    expect(fencedCode?.textContent).toBe("const answer = 42;");
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

  it("renders inline directory paths as clickable links in user text", () => {
    const onOpenFile = vi.fn();
    const message: ChatMessage = {
      id: "user-inline-directory-mention",
      role: "user",
      content: "Please check @src/agent/webview/components before continuing",
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
    expect(fileLink.textContent).toBe("@src/agent/webview/components");

    fireEvent.click(fileLink);
    expect(onOpenFile).toHaveBeenCalledWith(
      "src/agent/webview/components",
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

  it("does not render detected question fallback when a final Continue CTA is visible", () => {
    const message: ChatMessage = {
      id: "assistant-final-with-detected-question",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [{ type: "text", text: "Should I continue?" }],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "Ready to continue.",
      },
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        detectedQuestion={{
          messageId: "assistant-final-with-detected-question",
          kind: "yes_no",
          prompt: "Should I continue?",
          options: [
            { label: "Yes", payload: "Yes" },
            { label: "No", payload: "No" },
          ],
        }}
        onDetectedQuestionAnswer={vi.fn()}
        onDismissDetectedQuestion={vi.fn()}
        onFinalMarkerContinue={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByText("Detected choice prompt")).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
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

  it("copies final marker summaries as Markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const message: ChatMessage = {
      id: "assistant-final-copy",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "**Done**\n\n- Validated `npm test`.",
      },
    };

    const { container } = render(
      <MessageBubble message={message} streaming={false} />,
    );

    const copyButton = container.querySelector(
      ".final-marker-summary .copy-button",
    ) as HTMLButtonElement | null;
    expect(copyButton).toBeTruthy();

    fireEvent.click(copyButton!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "**Done**\n\n- Validated `npm test`.",
      );
    });
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

  it("renders a default Continue CTA when legacy tool suppression is present", () => {
    const message: ChatMessage = {
      id: "assistant-final-legacy-suppressed-continue",
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

    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("does not render a default Continue CTA when the action was consumed by the UI", () => {
    const message: ChatMessage = {
      id: "assistant-final-consumed-continue",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [],
      finalMarker: {
        status: "completed",
        source: "tool",
        summary: "All requested work is complete.",
        continueActionConsumed: true,
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
        toolCall: {
          id: "final-1",
          name: "set_task_status",
          inputJson: JSON.stringify({
            status: "completed",
            summary: "Done — the final summary only should be highlighted.",
          }),
          result: JSON.stringify({ ok: true }),
        },
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
    const finalTool = finalRegion?.querySelector(".tool-call-block");
    expect(finalTool).toBeTruthy();
    expect(finalTool?.textContent).toContain("set_task_status");
    expect(finalTool?.textContent).not.toContain('"status"');

    const finalToolHeader = finalRegion?.querySelector(
      ".final-marker-tool-call .tool-call-header",
    );
    expect(finalToolHeader).toBeTruthy();
    fireEvent.click(finalToolHeader!);
    expect(finalRegion?.textContent).toContain('"status"');
    expect(finalRegion?.textContent).toContain('"completed"');
    expect(finalRegion?.textContent).toContain('"summary"');
  });

  it("restores provider-prefixed built-in tool names with normal group labels", () => {
    const restored = agentMessagesToChatMessages([
      { role: "user", content: "check spacing" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "functions.apply_diff",
            input: { path: "src/agent/webview/styles/chat.css" },
          },
          {
            type: "text",
            text: "The selector is now limited to real runtime block classes.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: JSON.stringify({ status: "accepted" }),
          },
        ],
      },
    ]);
    const assistant = restored.find(
      (message): message is ChatMessage => message.role === "assistant",
    );

    expect(assistant?.blocks[0]).toMatchObject({
      type: "tool_call",
      name: "apply_diff",
    });
    const { container } = render(
      <MessageBubble message={assistant!} streaming={false} />,
    );
    const blocks = container.querySelector(".assistant-blocks");
    const toolGroup = blocks?.children[0];
    const textBlock = blocks?.children[1];

    expect(
      screen.getByRole("button", { name: /tools edited 1 file/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /1 other call/i })).toBeNull();
    expect(toolGroup?.classList.contains("tool-group-block")).toBe(true);
    expect(textBlock?.classList.contains("assistant-content")).toBe(true);
    expect(toolGroup?.nextElementSibling).toBe(textBlock);
  });

  it("settles completed tools into a summary while streaming and keeps running tools standalone", () => {
    vi.useFakeTimers();

    let state = reducer(initialState, {
      type: "ADD_USER_MESSAGE",
      text: "inspect",
    });

    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-1",
      toolName: "read_file",
    });
    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-1",
      toolName: "read_file",
      result: JSON.stringify({ ok: true }),
      durationMs: 5,
      input: { path: "src/one.ts" },
    });
    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-2",
      toolName: "search_files",
    });
    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-2",
      toolName: "search_files",
      result: JSON.stringify({ total_matches: 2 }),
      durationMs: 7,
      input: { regex: "needle", path: "src" },
    });
    state = reducer(state, {
      type: "TOOL_START",
      toolCallId: "tool-3",
      toolName: "execute_command",
    });

    const assistant = state.messages[state.messages.length - 1] as ChatMessage;
    const { rerender } = render(
      <MessageBubble message={assistant} streaming={true} />,
    );

    expect(
      screen.queryByRole("button", { name: /tools explored/i }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /read_file/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /search_files/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /execute_command/i }),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(TOOL_GROUP_SETTLE_MS_FOR_TEST);
    });

    const streamingGroup = screen.getByRole("button", {
      name: /tools explored 1 file, 1 search/i,
    });
    expect(streamingGroup.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /read_file/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /search_files/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /execute_command/i }),
    ).toBeTruthy();

    state = reducer(state, {
      type: "TOOL_COMPLETE",
      toolCallId: "tool-3",
      toolName: "execute_command",
      result: JSON.stringify({ exit_code: 0 }),
      durationMs: 9,
      input: { command: "npm test" },
    });

    rerender(
      <MessageBubble
        message={state.messages[state.messages.length - 1] as ChatMessage}
        streaming={false}
      />,
    );

    const groupButton = screen.getByRole("button", {
      name: /tools explored 1 file, 1 search · ran 1 command/i,
    });
    expect(groupButton.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryAllByRole("button", { name: /execute_command/i }),
    ).toHaveLength(0);

    fireEvent.click(groupButton);
    expect(groupButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders inline controls for running tool calls", () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const message: ChatMessage = {
      id: "assistant-running-tool",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [
        {
          type: "tool_call",
          id: "tool-running",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: "",
          complete: false,
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        streaming={true}
        onCompleteToolCall={onComplete}
        onCancelToolCall={onCancel}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Complete execute_command" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel execute_command" }),
    );

    expect(onComplete).toHaveBeenCalledWith("tool-running");
    expect(onCancel).toHaveBeenCalledWith("tool-running");
  });

  it("does not render inline controls for completed tool calls", () => {
    const message: ChatMessage = {
      id: "assistant-complete-tool",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      blocks: [
        {
          type: "tool_call",
          id: "tool-complete",
          name: "execute_command",
          inputJson: JSON.stringify({ command: "npm test" }),
          result: JSON.stringify({ exit_code: 0 }),
          complete: true,
          durationMs: 12,
        },
      ],
    };

    render(
      <MessageBubble
        message={message}
        streaming={false}
        onCompleteToolCall={vi.fn()}
        onCancelToolCall={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
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
