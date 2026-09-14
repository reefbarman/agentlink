import type { StandaloneSessionProjection } from "../sessionProjection.js";

export type RendererFixtureFocus =
  | "transcript"
  | "activity"
  | "approval"
  | "composer";

export type RendererFixtureAction =
  | { readonly type: "focus.changed"; readonly focus: RendererFixtureFocus }
  | { readonly type: "composer.changed"; readonly value: string }
  | { readonly type: "composer.submitted"; readonly value: string }
  | { readonly type: "command-picker.toggled"; readonly open: boolean }
  | { readonly type: "turn.cancelled" }
  | { readonly type: "session.exited" };

export interface RendererBakeoffTodo {
  readonly id: string;
  readonly label: string;
  readonly status: "completed" | "in_progress" | "pending";
}

export interface RendererBakeoffFixture {
  readonly projection: StandaloneSessionProjection;
  readonly composer: string;
  readonly focus: RendererFixtureFocus;
  readonly commandPickerOpen: boolean;
  readonly commandOutput: string;
  readonly todos: readonly RendererBakeoffTodo[];
  readonly question: string;
}

const APPROVAL_DIFF = `diff --git a/src/greeting.ts b/src/greeting.ts
index 1111111..2222222 100644
--- a/src/greeting.ts
+++ b/src/greeting.ts
@@ -1,2 +1,2 @@
-export const greeting = "hello";
+export const greeting = "hello from AgentLink";
 console.log(greeting);`;

export function createRendererBakeoffFixture(
  overrides: Partial<RendererBakeoffFixture> = {},
): RendererBakeoffFixture {
  const transcript = Array.from({ length: 1_000 }, (_, index) => {
    const sequence = index + 1;
    const assistant = index % 2 === 1;
    return {
      id: `fixture-message-${sequence}`,
      role: assistant ? ("assistant" as const) : ("user" as const),
      text: assistant
        ? sequence % 10 === 0
          ? `Message ${sequence}: **Checked the implementation.**\n\n\`\`\`ts\nconst sequence = ${sequence};\n\`\`\``
          : `Message ${sequence}: Checked the implementation and kept the projected state stable.`
        : `Message ${sequence}: Please inspect the next bounded renderer update.`,
      turnId: `fixture-turn-${Math.ceil(sequence / 2)}`,
      streaming: sequence === 1_000,
    };
  });

  const projection: StandaloneSessionProjection = {
    schemaVersion: 1,
    revision: 1_042,
    projectRoot: "/fixture/agentlink",
    sessionId: "fixture-session",
    phase: "awaiting_approval",
    mode: "code",
    writePolicy: "prompt",
    transcript,
    thinking: [],
    todos: [],
    queuedMessages: [],
    tools: [
      {
        toolCallId: "fixture-tool",
        sequence: 1,
        toolName: "execute_command",
        effect: "write",
        status: "running",
        displayInput: { command: "npm test" },
        displayContent: { latest: "Test Files 32 passed" },
      },
    ],
    pendingInteraction: {
      interactionId: "fixture-approval",
      kind: "tool_authorization",
      summary: "Apply greeting update",
      toolCallId: "fixture-write",
      toolName: "apply_diff",
      effect: "write",
      displayInput: { path: "src/greeting.ts" },
      displayContent: {
        path: "src/greeting.ts",
        diff: APPROVAL_DIFF,
      },
    },
    commands: [
      {
        commandId: "fixture-command",
        command: "npm test",
        mode: "foreground",
        state: "running",
        startedAt: 1,
        outputDroppedBytes: 0,
      },
    ],
    backgroundAgents: [
      {
        childSessionId: "fixture-agent-review",
        task: "Review the renderer fixture",
        lifecycle: "running",
        phase: "reviewing",
        resultState: "pending",
        currentTool: "read_file",
        steeringQueued: 0,
      },
      {
        childSessionId: "fixture-agent-package",
        task: "Measure the package closure",
        lifecycle: "running",
        phase: "measuring",
        resultState: "pending",
        currentTool: "execute_command",
        partialOutput: "Inventorying native assets",
        steeringQueued: 0,
      },
    ],
    backgroundApprovals: [],
    mcpServers: [
      { id: "filesystem", source: "global", transport: "stdio" },
      { id: "linear", source: "project", transport: "streamable-http" },
    ],
  };

  return {
    projection,
    composer: "Compare both renderers.\nKeep the interaction fixture bounded.",
    focus: "composer",
    commandPickerOpen: false,
    commandOutput:
      "Test Files 32 passed\nTests 418 passed\nWatching command output…",
    todos: [
      {
        id: "fixture-todo-1",
        label: "Render 1,000 messages",
        status: "completed",
      },
      {
        id: "fixture-todo-2",
        label: "Verify streaming updates",
        status: "in_progress",
      },
      {
        id: "fixture-todo-3",
        label: "Measure package closure",
        status: "pending",
      },
    ],
    question: "Keep following live output after approval?",
    ...overrides,
  };
}

export function appendRendererFixtureUpdate(
  fixture: RendererBakeoffFixture,
  token: string,
  commandChunk: string,
): RendererBakeoffFixture {
  const transcript = fixture.projection.transcript.map(
    (message, index, messages) =>
      index === messages.length - 1
        ? { ...message, text: `${message.text}${token}` }
        : message,
  );
  return {
    ...fixture,
    projection: {
      ...fixture.projection,
      revision: fixture.projection.revision + 1,
      transcript,
    },
    commandOutput: `${fixture.commandOutput}${commandChunk}`,
  };
}

export function approvalDiff(fixture: RendererBakeoffFixture): string {
  const content = fixture.projection.pendingInteraction?.displayContent;
  if (!content || typeof content !== "object") return "";
  const diff = Reflect.get(content, "diff");
  return typeof diff === "string" ? diff : "";
}
