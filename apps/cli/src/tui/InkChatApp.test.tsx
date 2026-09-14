import {
  InkChatApp,
  shellLayout,
  suspendForShell,
  visibleControlOptions,
} from "./InkChatApp.js";
import { describe, expect, it, vi } from "vitest";

import React from "react";
import type { StandaloneSessionController } from "../sessionController.js";
import { buildActivityShelfItems } from "./ActivityShelf.js";
import { createRendererBakeoffFixture } from "./rendererBakeoffFixture.js";
import { render } from "ink-testing-library";

function controllerFixture(): StandaloneSessionController {
  const fixture = createRendererBakeoffFixture();
  return {
    getState: () => fixture.projection,
    subscribe: () => () => undefined,
    initialize: vi.fn(),
    submit: vi.fn(),
    resumeInteraction: vi.fn(),
    cancel: vi.fn(async () => undefined),
    newSession: vi.fn(),
    listSessions: vi.fn(),
    selectSession: vi.fn(),
    listModels: vi.fn(async () => []),
    setModel: vi.fn(async () => undefined),
    setReasoningEffort: vi.fn(async () => undefined),
    refreshActivity: () => fixture.projection,
    refreshMcpState: vi.fn(async () => fixture.projection),
    observeCommand: vi.fn(),
    stopCommand: vi.fn(),
    steerBackgroundAgent: vi.fn(),
    stopBackgroundAgent: vi.fn(),
    respondToBackgroundApproval: vi.fn(),
    validatePendingInteraction: vi.fn(),
    acknowledgeBackgroundCommand: vi.fn(),
    addCommandRule: vi.fn(),
    runPrompt: vi.fn(),
    notifyBackgroundApproval: vi.fn(),
    cancelPrompts: vi.fn(),
    close: vi.fn(),
  } as StandaloneSessionController;
}

describe("Ink chat app", () => {
  it("hands Ctrl+Z suspension to Ink before stopping the process", async () => {
    const order: string[] = [];
    const suspendTerminal = vi.fn(
      async (callback?: () => void | Promise<void>) => {
        order.push("suspend");
        await callback?.();
        order.push("resume");
        return undefined as never;
      },
    );
    const suspendProcess = vi.fn((signal: NodeJS.Signals) => {
      order.push(signal);
    });

    await suspendForShell(suspendTerminal, suspendProcess);

    expect(suspendTerminal).toHaveBeenCalledOnce();
    expect(suspendProcess).toHaveBeenCalledWith("SIGTSTP");
    expect(order).toEqual(["suspend", "SIGTSTP", "resume"]);
  });

  it("renders Markdown transcript, session status, and multiline composer", () => {
    const controller = controllerFixture();
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.lastFrame()).toContain("AgentLink · fixture-sess");
    expect(screen.lastFrame()).toContain("const sequence = 1000;");
    expect(screen.lastFrame()).not.toContain("```ts");
    expect(screen.lastFrame()).toContain("Activity · 4 live");
    expect(screen.lastFrame()).toContain("Active work · awaiting_approval");
    expect(screen.lastFrame()).toContain("Enter send · Ctrl+J newline");
    screen.unmount();
  });

  it("starts with a compact branded composer and expands after submission", async () => {
    const baseController = controllerFixture();
    const projection = {
      ...baseController.getState(),
      phase: "idle" as const,
      transcript: [],
      thinking: [],
      tools: [],
      commands: [],
      backgroundAgents: [],
      pendingInteraction: undefined,
    };
    const listeners = new Set<
      (
        state: import("../sessionProjection.js").StandaloneSessionProjection,
        action: never,
      ) => void
    >();
    const controller = {
      ...baseController,
      getState: () => projection,
      subscribe: (
        listener: (
          state: import("../sessionProjection.js").StandaloneSessionProjection,
          action: never,
        ) => void,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as StandaloneSessionController;
    const onSubmit = vi.fn(async () => {
      const next = {
        ...projection,
        phase: "running" as const,
        transcript: [
          {
            id: "first-user",
            role: "user" as const,
            text: "Build the feature",
            turnId: "turn-1",
            streaming: false,
          },
        ],
      };
      for (const listener of listeners) listener(next, undefined as never);
    });
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.lastFrame()).toContain("◆ AgentLink");
    expect(screen.lastFrame()).toContain(
      "What would you like AgentLink to work on?",
    );
    expect(screen.lastFrame()).not.toContain("prompt writes");
    await nextInputDispatch();
    screen.stdin.write("Build the feature");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("You"));
    expect(screen.lastFrame()).toContain("prompt writes");
    screen.unmount();
  });

  it("renders every visible user and assistant label", () => {
    const controller = controllerFixture();
    const projection = {
      ...controller.getState(),
      phase: "idle" as const,
      transcript: [
        {
          id: "user-1",
          role: "user" as const,
          text: "First request",
          turnId: "turn-1",
          streaming: false,
        },
        {
          id: "assistant-1",
          role: "assistant" as const,
          text: "First answer",
          turnId: "turn-1",
          streaming: false,
        },
        {
          id: "user-2",
          role: "user" as const,
          text: "Second request",
          turnId: "turn-2",
          streaming: false,
        },
      ],
      thinking: [],
      tools: [],
      commands: [],
      backgroundAgents: [],
      pendingInteraction: undefined,
      execution: undefined,
    };
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );
    const frame = stripAnsi(screen.lastFrame());

    expect(frame.match(/You/g)).toHaveLength(2);
    expect(frame.match(/AgentLink/g)?.length).toBeGreaterThanOrEqual(2);
    expect(frame).not.toMatch(/\bAgent\b/);
    screen.unmount();
  });

  it("renders collapsed tools, expands details with Enter, and keeps response spacing", async () => {
    const baseController = controllerFixture();
    const projection = {
      ...baseController.getState(),
      phase: "idle" as const,
      transcript: [
        {
          id: "user-2",
          role: "user" as const,
          text: "Second request",
          turnId: "turn-2",
          streaming: false,
        },
        {
          id: "assistant-2",
          role: "assistant" as const,
          text: "**Done** with the tool call.",
          turnId: "turn-2",
          streaming: false,
        },
      ],
      thinking: [],
      tools: [
        {
          toolCallId: "tool-2",
          turnId: "turn-2",
          sequence: 2,
          toolName: "read_file",
          effect: "read" as const,
          status: "completed" as const,
          displayInput: { path: "src/index.ts" },
        },
      ],
      commands: [],
      backgroundAgents: [],
      pendingInteraction: undefined,
      execution: undefined,
    };
    const controller = {
      ...baseController,
      getState: () => projection,
    } as StandaloneSessionController;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );
    const frame = stripAnsi(screen.lastFrame());

    expect(frame).toContain("▸ ✓ Tools · 1 read_file · Enter expand");
    expect(frame).not.toContain('"path":"src/index.ts"');
    expect(frame).toMatch(/Enter expand[^\n]*\n│\s*│\n│ AgentLink/);
    expect(frame).toContain("Done with the tool call.");
    expect(frame).not.toContain("**Done**");
    expect(frame).not.toContain("Working");

    screen.stdin.write("\t");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await vi.waitFor(() =>
      expect(stripAnsi(screen.lastFrame())).toContain(
        'Input · {"path":"src/index.ts"}',
      ),
    );
    expect(stripAnsi(screen.lastFrame())).toContain("▾");
    screen.unmount();
  });

  it("focuses, navigates, and expands the activity shelf by keyboard", async () => {
    const controller = controllerFixture();
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("\t");
    await nextInputDispatch();
    screen.stdin.write("\t");
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Activity (focused)"),
    );
    screen.stdin.write(" ");
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain(
        "Execution accounting not available yet",
      ),
    );
    screen.unmount();
  });

  it("opens the full TODO list directly with Ctrl+T", async () => {
    const controller = controllerFixture();
    const projection = {
      ...controller.getState(),
      todos: [
        {
          id: "todo-current",
          content: "Implement current item",
          activeForm: "Implementing current item",
          status: "in_progress" as const,
        },
        {
          id: "todo-next",
          content: "Validate next item",
          activeForm: "Validating next item",
          status: "pending" as const,
        },
      ],
    };
    const todoController = {
      ...controller,
      getState: () => projection,
    } as StandaloneSessionController;
    const screen = render(
      <InkChatApp
        controller={todoController}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(
      buildActivityShelfItems(projection).find((item) => item.id === "tasks"),
    ).toMatchObject({ summary: "● Implementing current item" });
    expect(screen.lastFrame()).not.toContain("Validate next item");
    await nextInputDispatch();
    screen.stdin.write("\u0014");
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("○ Validate next item"),
    );
    expect(screen.lastFrame()).toContain("› ▾ TODO");
    expect(screen.lastFrame()).toContain("Activity (focused)");
    screen.unmount();
  });

  it("keeps transcript and activity regions bounded across terminal heights", () => {
    expect(shellLayout(24, 5)).toEqual({
      transcriptRows: 11,
      activityRows: 7,
    });
    expect(shellLayout(14, 5)).toEqual({
      transcriptRows: 4,
      activityRows: 4,
    });
  });

  it("keeps the selected option visible in long control lists", () => {
    const options = Array.from({ length: 15 }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
    }));

    expect(visibleControlOptions(options, 14, 10)).toMatchObject([
      { index: 5, option: { id: "option-5" } },
      { index: 6 },
      { index: 7 },
      { index: 8 },
      { index: 9 },
      { index: 10 },
      { index: 11 },
      { index: 12 },
      { index: 13 },
      { index: 14, option: { id: "option-14" } },
    ]);
  });

  it("presents keyboard controls and resolves selected options", async () => {
    const controller = controllerFixture();
    let presentControl:
      | ((
          request: import("./controlTypes.js").TuiControlRequest,
        ) => Promise<import("./controlTypes.js").TuiControlResponse>)
      | undefined;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        registerControlPresenter={(present) => {
          presentControl = present;
        }}
      />,
    );

    await vi.waitFor(() => expect(presentControl).toBeDefined());
    const response = presentControl!({
      id: "control-1",
      title: "Choose action",
      body: ["Review the exact action"],
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny", tone: "danger" },
      ],
    });
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Choose action"),
    );
    screen.stdin.write("\u001b[B");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await expect(response).resolves.toEqual({
      requestId: "control-1",
      cancelled: false,
      optionId: "deny",
    });
    screen.unmount();
  });

  it("cancels an outstanding control when the TUI unmounts", async () => {
    const controller = controllerFixture();
    let presentControl:
      | ((
          request: import("./controlTypes.js").TuiControlRequest,
        ) => Promise<import("./controlTypes.js").TuiControlResponse>)
      | undefined;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        registerControlPresenter={(present) => {
          presentControl = present;
        }}
      />,
    );

    await vi.waitFor(() => expect(presentControl).toBeDefined());
    const response = presentControl!({
      id: "approval-on-exit",
      title: "Review write",
      body: ["src/index.ts"],
      options: [{ id: "deny", label: "Deny" }],
      cancellable: false,
    });
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Review write"),
    );

    screen.unmount();

    await expect(response).resolves.toEqual({
      requestId: "approval-on-exit",
      cancelled: true,
    });
  });

  it("uses Ctrl+C to terminate an active approval instead of denying it", async () => {
    const controller = controllerFixture();
    let presentControl:
      | ((
          request: import("./controlTypes.js").TuiControlRequest,
        ) => Promise<import("./controlTypes.js").TuiControlResponse>)
      | undefined;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        registerControlPresenter={(present) => {
          presentControl = present;
        }}
      />,
    );

    await vi.waitFor(() => expect(presentControl).toBeDefined());
    const response = presentControl!({
      id: "approval-cancel",
      kind: "approval",
      title: "Review write",
      body: ["src/index.ts"],
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
      cancellable: false,
    });
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Review write"),
    );
    screen.stdin.write("\u0003");

    await expect(response).resolves.toEqual({
      requestId: "approval-cancel",
      cancelled: true,
      terminate: true,
    });
    await vi.waitFor(() =>
      expect(controller.cancel).toHaveBeenCalledWith("Cancelled from TUI"),
    );
    expect(controller.resumeInteraction).not.toHaveBeenCalled();
    screen.unmount();
  });

  it("cancels and clears an active control when its prompt signal aborts", async () => {
    const controller = controllerFixture();
    let presentControl:
      | ((
          request: import("./controlTypes.js").TuiControlRequest,
          signal?: AbortSignal,
        ) => Promise<import("./controlTypes.js").TuiControlResponse>)
      | undefined;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        registerControlPresenter={(present) => {
          presentControl = present;
        }}
      />,
    );
    const abort = new AbortController();

    await vi.waitFor(() => expect(presentControl).toBeDefined());
    const response = presentControl!(
      {
        id: "question-abort",
        kind: "question",
        title: "Agent question",
        body: ["Still needed?"],
        options: [{ id: "yes", label: "Yes" }],
      },
      abort.signal,
    );
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Agent question"),
    );
    abort.abort("Session closing");

    await expect(response).resolves.toEqual({
      requestId: "question-abort",
      cancelled: true,
    });
    await vi.waitFor(() =>
      expect(screen.lastFrame()).not.toContain("Still needed?"),
    );
    screen.unmount();
  });

  it("collects typed answers in the control panel", async () => {
    const controller = controllerFixture();
    let presentControl:
      | ((
          request: import("./controlTypes.js").TuiControlRequest,
        ) => Promise<import("./controlTypes.js").TuiControlResponse>)
      | undefined;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        registerControlPresenter={(present) => {
          presentControl = present;
        }}
      />,
    );

    await vi.waitFor(() => expect(presentControl).toBeDefined());
    const response = presentControl!({
      id: "question-1",
      kind: "question",
      title: "Agent question",
      body: ["What should change?"],
      input: { placeholder: "Type answer" },
    });
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Agent question"),
    );
    screen.stdin.write("Use the shared contract");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await expect(response).resolves.toMatchObject({
      requestId: "question-1",
      cancelled: false,
      text: "Use the shared contract",
    });
    screen.unmount();
  });

  it("opens the control centre from Ctrl+O", async () => {
    const controller = controllerFixture();
    const onOpenControlCenter = vi.fn();
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        onOpenControlCenter={onOpenControlCenter}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("\u000f");
    await nextInputDispatch();
    expect(onOpenControlCenter).toHaveBeenCalledOnce();
    screen.unmount();
  });

  it("keeps the composer editable while a submitted turn is still active", async () => {
    const controller = controllerFixture();
    let finishSubmit: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmit = resolve;
        }),
    );
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("first prompt");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("first prompt"),
    );
    screen.stdin.write("draft while working");
    await vi.waitFor(() =>
      expect(stripAnsi(screen.lastFrame())).toContain("draft while working"),
    );
    finishSubmit!();
    screen.unmount();
  });

  it("queues additional submissions and runs them in order", async () => {
    const controller = controllerFixture();
    const resolvers: Array<() => void> = [];
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("first");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("first"));
    screen.stdin.write("second");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("1 queued"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolvers.shift()!();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("second"));
    resolvers.shift()!();
    screen.unmount();
  });

  it("resynchronizes projection state after installing the subscription", async () => {
    const controller = controllerFixture();
    const current = {
      ...controller.getState(),
      sessionId: "current-session",
      transcript: [
        {
          id: "current-message",
          role: "assistant" as const,
          text: "Current projection",
          streaming: false,
        },
      ],
    };
    const resyncingController = {
      ...controller,
      getState: () => current,
    } as StandaloneSessionController;
    const screen = render(
      <InkChatApp
        controller={resyncingController}
        initialProjection={{
          ...current,
          sessionId: "stale-session",
          transcript: [],
        }}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Current projection"),
    );
    expect(screen.lastFrame()).toContain("AgentLink · current-sess");
    screen.unmount();
  });

  it("submits the composer and exposes command completion", async () => {
    const controller = controllerFixture();
    const onSubmit = vi.fn(async () => ({ status: "done" }));
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("/he");
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("/help · Show TUI shortcuts"),
    );
    screen.stdin.write("\r");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/help"));
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("done"));
    screen.unmount();
  });

  it("submits unmatched command text instead of trapping Enter in the picker", async () => {
    const controller = controllerFixture();
    const onSubmit = vi.fn(async () => undefined);
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("/unknown");
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("No matches"));
    screen.stdin.write("\r");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/unknown"));
    screen.unmount();
  });

  it("loads project files into attachment chips and submits their paths", async () => {
    const controller = controllerFixture();
    const onSubmit = vi.fn(async () => undefined);
    const loadFileSuggestions = vi.fn(async () => [
      {
        id: "src/index.ts",
        label: "src/index.ts",
        detail: "project file",
        insertText: "src/index.ts",
      },
    ]);
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={loadFileSuggestions}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("Review @ind");
    await vi.waitFor(() =>
      expect(loadFileSuggestions).toHaveBeenCalledWith("ind"),
    );
    expect(screen.lastFrame()).toContain("src/index.ts · project file");
    screen.stdin.write("\r");
    await nextInputDispatch();
    expect(stripAnsi(screen.lastFrame())).toContain("▣ src/index.ts");
    expect(stripAnsi(screen.lastFrame())).toContain("Review");
    screen.stdin.write("\r");
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("Review", ["src/index.ts"]),
    );
    screen.unmount();
  });

  it("sanitizes accepted file attachment chips", async () => {
    const controller = controllerFixture();
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => [
          {
            id: "unsafe",
            label: "unsafe\u001b[2J\u202e",
            detail: "project file",
            insertText: "src/unsafe.ts",
          },
        ]}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("Review @unsafe");
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("project file"),
    );
    screen.stdin.write("\r");
    await nextInputDispatch();
    expect(stripAnsi(screen.lastFrame())).toContain("▣ unsafe␛[2J�");
    expect(screen.lastFrame()).not.toContain("\u001b[2J");
    expect(screen.lastFrame()).not.toContain("\u202e");
    screen.unmount();
  });

  it("sanitizes typed control input before echoing it", async () => {
    const controller = controllerFixture();
    let presentControl:
      | ((
          request: import("./controlTypes.js").TuiControlRequest,
        ) => Promise<import("./controlTypes.js").TuiControlResponse>)
      | undefined;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
        registerControlPresenter={(present) => {
          presentControl = present;
        }}
      />,
    );

    await vi.waitFor(() => expect(presentControl).toBeDefined());
    void presentControl!({
      id: "unsafe-input",
      kind: "question",
      title: "Agent question",
      body: ["Answer"],
      input: { placeholder: "Type answer" },
    });
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("Type answer"));
    screen.stdin.write("safe\u202etext");
    await nextInputDispatch();

    expect(screen.lastFrame()).toContain("safe�text");
    expect(screen.lastFrame()).not.toContain("\u202e");
    screen.unmount();
  });

  it("renders attached file names in the transcript", () => {
    const baseController = controllerFixture();
    const projection = {
      ...baseController.getState(),
      transcript: [
        {
          id: "attachment-message",
          role: "user" as const,
          text: "Review this",
          streaming: false,
          attachments: [
            { name: "docs/spec.pdf", kind: "document" as const },
            { name: "assets/screenshot.png", kind: "image" as const },
          ],
        },
      ],
    };
    const controller = {
      ...baseController,
      getState: () => projection,
    } as StandaloneSessionController;
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.lastFrame()).toContain("▤ docs/spec.pdf");
    expect(screen.lastFrame()).toContain("▣ assets/screenshot.png");
    screen.unmount();
  });

  it("sanitizes terminal control sequences in transcript content", () => {
    const controller = controllerFixture();
    const projection = {
      ...controller.getState(),
      transcript: [
        {
          id: "unsafe",
          role: "assistant" as const,
          text: "safe\u001b[2Jstill safe",
          streaming: false,
        },
      ],
    };
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.lastFrame()).toContain("safe␛[2Jstill safe");
    expect(screen.lastFrame()).not.toContain("\u001b[2J");
    screen.unmount();
  });

  it("neutralizes C1 and bidirectional terminal control characters", () => {
    const controller = controllerFixture();
    const projection = {
      ...controller.getState(),
      transcript: [
        {
          id: "unsafe-unicode",
          role: "assistant" as const,
          text: "before\u009b2J\u061c\u200e\u200fmiddle\u202eevil\u2066after",
          streaming: false,
        },
      ],
    };
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={projection}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.lastFrame()).toContain("before�2J���middle�evil�after");
    for (const unsafe of [
      "\u009b",
      "\u061c",
      "\u200e",
      "\u200f",
      "\u202e",
      "\u2066",
    ]) {
      expect(screen.lastFrame()).not.toContain(unsafe);
    }
    screen.unmount();
  });

  it("keeps large bracketed paste and Unicode text intact", async () => {
    const controller = controllerFixture();
    const onSubmit = vi.fn(async () => undefined);
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={onSubmit}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );
    const paste = `${"🙂漢字 café\n".repeat(600)}final line`;

    await nextInputDispatch();
    screen.stdin.write(`\u001b[200~${paste}\u001b[201~`);
    await nextInputDispatch();

    const rawFrame = screen.lastFrame() ?? "";
    expect(stripAnsi(rawFrame)).toContain("🙂漢字 café");
    expect(rawFrame).not.toContain("\u001b[200~");
    expect(rawFrame).not.toContain("\u001b[201~");
    screen.stdin.write("\r");
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(paste));
    screen.unmount();
  });

  it("applies repeated external status values when their revision advances", async () => {
    const controller = controllerFixture();
    const screen = render(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        externalStatus="Repeated failure"
        externalStatusRevision={1}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );

    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Repeated failure"),
    );
    screen.stdin.write("prompt");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Repeated failure"),
    );
    screen.rerender(
      <InkChatApp
        controller={controller}
        initialProjection={controller.getState()}
        externalStatus="Repeated failure"
        externalStatusRevision={2}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={() => undefined}
        onError={() => undefined}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.lastFrame()).toContain("Repeated failure"),
    );
    screen.unmount();
  });

  it("cancels a running turn on Ctrl+C without exiting", async () => {
    const controller = controllerFixture();
    const runningController = {
      ...controller,
      getState: () => ({ ...controller.getState(), phase: "running" as const }),
    } as StandaloneSessionController;
    const onExit = vi.fn();
    const screen = render(
      <InkChatApp
        controller={runningController}
        initialProjection={runningController.getState()}
        loadFileSuggestions={async () => []}
        onSubmit={async () => undefined}
        onExit={onExit}
        onError={() => undefined}
      />,
    );

    await nextInputDispatch();
    screen.stdin.write("\u0003");
    await nextInputDispatch();
    expect(runningController.cancel).toHaveBeenCalledWith("Cancelled from TUI");
    expect(onExit).not.toHaveBeenCalled();
    screen.unmount();
  });
});

function nextInputDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stripAnsi(value: string | undefined): string {
  let result = value ?? "";
  for (;;) {
    const escape = result.indexOf("\u001b[");
    if (escape < 0) return result;
    let end = escape + 2;
    while (end < result.length && !/[A-Za-z]/u.test(result[end] ?? ""))
      end += 1;
    result = `${result.slice(0, escape)}${result.slice(Math.min(result.length, end + 1))}`;
  }
}
