---
name: agent-activity-ux
description: Suggested chat UX patterns for apps built on the AgentLink SDK, based on how the AgentLink VS Code extension renders agent activity. Use when designing loading spinners, live status text, streaming text, thinking or reasoning blocks, tool call rows, tool grouping, approval waits, stop/cancel, or turn-end states from SDK turn events or the embedded client reducer.
---

# Agent activity UX: patterns from the VS Code extension

This page describes how the AgentLink VS Code extension shows a running agent: the live spinner, streaming text, thinking, and tool calls. It is offered as a **reference, not a requirement**. The SDK does not depend on any of it, and your app should follow its own design language. These patterns have held up well in daily use, so they are a reasonable starting point if you are building a chat UI on `@agentlink/core` or `@agentlink/protocol` and want similar behavior.

For the event stream, reducer, and session lifecycle themselves, see [Embed AgentLink](embedding-agentlink.md).

## What you have to work with

The turn event stream (`engine.sessions.runTurn(...)`, or NDJSON through `createEmbeddedAgentWebHandler(...)`) emits ordered events. The browser reducer `reduceEmbeddedAgentTurnEvent(...)` (or `createEmbeddedAgentClientController(...)`) folds them into `EmbeddedAgentClientState`:

- `status`: `idle`, `running`, `suspended`, `completed`, `cancelled`, or `failed`.
- `blocks`: an ordered list, in arrival order, of:
  - `text` blocks (consecutive `text.delta` events append to the last text block);
  - `thinking` blocks with `thinkingId`, `text`, and `status: "running" | "completed"`;
  - `tool` blocks with `toolCallId`, `toolName`, `effect`, optional host-authored `presentation`, `status: "requested" | "running" | "completed" | "failed" | "denied"`, and display-safe `displayInput` / `displayContent` / `error`.
- `pendingInteraction` while an approval is waiting.

Every pattern below can be derived from that state. The VS Code extension uses its own internal transcript type, but its blocks have the same shape: ordered thinking, text, and tool blocks, each with a complete/incomplete flag.

## The live activity indicator

The extension shows **one** activity row while a turn runs: an animated icon plus a short, literal label. It is derived from the **last** block in the current turn, not from separate timers:

| Last block                    | Label                      | Suggested motion |
| ----------------------------- | -------------------------- | ---------------- |
| none yet                      | `Working…`                 | moving           |
| `thinking`, running           | `Thinking…`                | moving           |
| `thinking`, completed         | `Working…`                 | moving           |
| `text`                        | `Responding…`              | moving           |
| `tool`, requested or running  | `Running tool…`            | moving           |
| `tool`, completed or failed   | `Processing tool results…` | moving           |
| `pendingInteraction` present  | `Approval needed`          | attention        |
| turn completed/failed/stopped | hide it, or `Done`/`Error` | static           |

```ts
import type {
  EmbeddedAgentBlock,
  EmbeddedAgentClientState,
} from "@agentlink/protocol/embedded-agent-transport";

type Motion = "moving" | "attention" | "static";

function activity(state: EmbeddedAgentClientState): {
  label: string;
  motion: Motion;
} {
  if (state.pendingInteraction)
    return { label: "Approval needed", motion: "attention" };
  const last: EmbeddedAgentBlock | undefined = state.blocks.at(-1);
  switch (last?.type) {
    case "text":
      return { label: "Responding…", motion: "moving" };
    case "thinking":
      return {
        label: last.status === "running" ? "Thinking…" : "Working…",
        motion: "moving",
      };
    case "tool":
      return last.status === "requested" || last.status === "running"
        ? { label: "Running tool…", motion: "moving" }
        : { label: "Processing tool results…", motion: "moving" };
    default:
      return { label: "Working…", motion: "moving" };
  }
}
```

Things that worked well:

- **Keep it visible through every gap.** The model often goes quiet between a tool result and the next token. Showing the row for the whole time `status === "running"` (rather than only while bytes arrive) stops the UI from looking frozen.
- **Say only what you know.** The extension falls back to `Working…` instead of guessing a phase it has no event for.
- **A temporary override beats a new widget.** Short host-side states, such as `Condensing context…` between `context.condensing` and `context.condensed`, or a credential refresh, replace the label and clear on the next real event.
- **Separate motion from text.** "Moving" for work in progress, "attention" (a warning colour, no spin) for waiting on the user, and "static" for queued or finished. Under `prefers-reduced-motion`, swap the animation for a still icon.
- **Placement.** The VS Code chat pins this row just above the composer so it stays on screen while the transcript scrolls; nested transcript views render it inline at the end of the streaming message. Either works. Avoid showing both at once.
- **Optional detail.** Background-agent views append an elapsed time (`Thinking… · request 12s`) or a retry countdown (`Retrying provider… · retry in 4s`) when the host knows them. The SDK's `response.retry` event carries `attempt` and `delayMs` if you want this; the default reducer just appends a `[Response interrupted. Retrying.]` note to the text.

## Thinking blocks

Providers that stream reasoning produce `thinking.started`, `thinking.delta`, and `thinking.completed` events. The extension treats thinking as secondary, collapsed-by-default content:

- **While running, keep it out of the transcript.** An in-progress thinking block is not rendered as a transcript row. Instead the activity row becomes `Thinking…`, and when there is text it becomes an expandable button showing the latest one-line summary (`Thinking… ↳ Checking the config loader`). Clicking it reveals the live text. The expansion resets when a new thinking block starts.
- **When completed, show a collapsed row.** A finished thinking block renders as a one-line `Thinking` header with a chevron and a lightbulb icon. The text is shown only when expanded, in a monospace or pre-wrapped block.
- **Drop empty thinking.** Some providers open and close a thinking block with no text. Filtering out blocks whose trimmed text is empty avoids rows that expand to nothing.
- **Normalize provider quirks before display.** Two that the extension handles:
  - OpenAI-style reasoning summaries can arrive as adjacent bold fragments (`**First step****Second step**`). The extension splits these into a numbered list of steps and uses the latest completed fragment as the live one-line summary.
  - Some OpenAI-compatible streams put a newline after every token. The extension rejoins runs of single-token lines while leaving real paragraphs and code alone.
- **Make the visibility decision deliberately.** Thinking text is provider output, not a vetted answer. Decide whether your users should see it at all, and if not, ignore the `thinking.*` events or show only the `Thinking…` label.

## Streaming text

`text.delta` events append to the current text block. Raw token arrival is bursty, so the extension smooths it:

- **Buffer, then reveal.** It waits for a small buffer (about 1,200 characters) or the end of the stream before revealing, then reveals a few characters per animation frame. The speed adapts to the backlog (roughly 1 to 6 characters per frame), so it catches up when far behind without jumping.
- **Throttle re-parsing.** Markdown is re-parsed at most about 20 times a second (about every 48 ms), not on every frame or token. Re-parsing the whole message per token gets expensive on long answers.
- **Don't replay history as typing.** When a view mounts mid-stream (reopening a panel, switching tabs) with a large amount of text already delivered, render that text immediately and animate only what arrives afterwards. A typewriter replay of old text looks like live output that isn't happening.
- **Copy and actions only after the block settles.** The extension hides the copy button on the actively streaming text block.
- **Empty-turn fallback.** If a turn completes with no visible blocks and no error, show a muted `(No response)` rather than an empty bubble.

## Tool call rows

Each tool block renders as a compact, single-line row that expands for details:

```text
›  ⟳  read_file   src/config.ts                        (running)
›  ✓  read_file   src/config.ts · 120 lines      0.3s  (completed)
›  ⚠  run_tests   exit 1                         4.1s  (completed with a soft failure)
›  ✕  write_file  Permission denied                    (failed)
```

- **Header:** a chevron, a status icon, the tool name (or your `presentation.title`), a one-line summary, and the duration once complete. The status icon is a spinner while the tool is `requested`/`running`, then a check, warning, or error icon.
- **One-line summary from the input.** The extension picks the most meaningful field: a `description`, then `command`, `path`, `query`, or `url`, truncated to roughly 80 to 140 characters. File paths become clickable links. For tools it knows well it summarises the result instead (for example, a line count or match count). With the SDK, `displayInput` and `presentation.inputLabel` / `outputLabel` are the natural sources, since they are host-authored and display-safe.
- **Expanded body:** labelled sections for `Input` (pretty-printed JSON) and `Result`, plus timing. Keep large results inside a bounded, scrollable area.
- **Three outcomes, not two.** Besides success and error, the extension uses a **warning** state for soft failures: a non-zero exit code, a partially applied edit, or a cancelled, rejected, or timed-out call. That keeps routine failures from looking like crashes.
- **A denial is not an error.** When a user denies an approval, the SDK reducer sets the tool status to `denied`. Render it neutrally (for example, `Denied`, or your `presentation.denialMessage`), not with the error style.
- **Long-running tools get inline actions.** For commands, the extension shows `Running` with the command text and offers stop or continue-in-background buttons on the row while it runs. Add these only where your host can actually honour them.

### Grouping completed tools

Agents often make many small read-only calls in a row. The extension keeps the transcript readable by collapsing them:

- **Let each tool settle first.** A finished tool stays as its own row for about 350 ms before it is folded into a group, so users see each call land instead of rows jumping.
- **Collapse runs of successful calls.** Consecutive successful (or soft-warning) tool rows become one `Tools` row with a summary such as `Explored 3 files, 2 searches · Ran 1 command` and the total duration. Expanding it shows the individual rows. A single call is never wrapped in a group.
- **Keep problems visible.** Errors and interrupted calls (rejected, cancelled, timed out) are never hidden inside a group; they break the run and render on their own.
- **Optional wider grouping.** When three or more completed rows mix completed thinking and tool groups, the extension wraps them in one `Activity` row (`2 thinking steps · 5 tool calls · Explored 4 files`). That keeps long agentic stretches from pushing the answer off screen.
- **Categorise by effect when you can.** The extension's labels come from tool categories (files, searches, edits, commands). With the SDK, the `effect` field (`read`, `write`, `external`, `unknown`) is an easy basis for similar labels.

## Approvals and waiting on the user

When `interaction.required` arrives, the reducer moves to `suspended` and sets `pendingInteraction`:

- Switch the activity row to `Approval needed` with the attention treatment, and stop the spinner.
- Show the approval card near the composer rather than deep in the transcript, using `summary`, `presentation.confirmationLabel`, `presentation.destructive`, and the display-safe input.
- After `interaction.resumed`, return to the normal running indicator.

## Ending a turn cleanly

- **Never leave a spinner running.** When a turn completes, fails, or is cancelled, the extension marks any still-incomplete tool or thinking block as finished (tools get a `stopped` result). Without this, an interrupted stream leaves rows spinning forever. Apply the same rule after a reconnect or hydration that finds a turn no longer running.
- **Cancelled is a visible state.** Show a neutral "Stopped" marker rather than silently ending.
- **Failures sit with the turn.** Show `turn.failed` errors inline at the end of the assistant message, offering retry only when `retryable` is true.

## Scrolling

The extension follows the bottom of the transcript while new content arrives, but stops as soon as the user scrolls up. It only treats real user input (wheel, touch, scroll keys, dragging the scrollbar) as "scrolled up". Layout shifts, such as the composer resizing or content being replaced, never stop following. Getting this wrong is the most common reason a chat leaves new output off screen.

## Accessibility

- The animated icon is decorative (`aria-hidden`) when the label text sits next to it.
- Collapsible headers are buttons with `aria-expanded`.
- Group and badge rows carry a full accessible label (for example, `Tools Explored 3 files 1 failed`).
- Honour `prefers-reduced-motion` for spinners and reveal animations.

## Event-to-UI quick reference

| SDK event                                  | Suggested UI effect                                                  |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `turn.started`                             | Show the activity row as `Working…`                                  |
| `thinking.started` / `thinking.delta`      | `Thinking…` with an expandable live summary                          |
| `thinking.completed`                       | Collapsed `Thinking` row (or drop it if empty)                       |
| `text.delta`                               | Smoothly revealed text; `Responding…`                                |
| `tool.requested` / `tool.started`          | New tool row with a spinner; `Running tool…`                         |
| `tool.completed`                           | Check or warning icon, duration, result summary                      |
| `tool.failed`                              | Error row, or a neutral `Denied` row for `tool_authorization_denied` |
| `interaction.required`                     | `Approval needed` (attention), approval card                         |
| `interaction.resumed`                      | Back to the running indicator                                        |
| `context.condensing` / `context.condensed` | Temporary `Condensing context…` label                                |
| `response.retry`                           | Optional `Retrying…` label or note                                   |
| `turn.completed` / `cancelled` / `failed`  | Finish open rows, hide the indicator, show stopped or error state    |
