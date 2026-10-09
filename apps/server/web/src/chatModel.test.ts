import type { SequencedEvent, TurnEvent } from "./types.js";
import { SessionEventBuffer, parseSessionEvent } from "./eventBuffer.js";
import { describe, expect, it } from "vitest";
import { liveItems, transcriptItems } from "./chatModel.js";

const turn = (sequence: number, event: TurnEvent): SequencedEvent => ({
  sequence,
  event: { kind: "turn", event },
});
const started = (sequence: number): SequencedEvent => ({
  sequence,
  event: { kind: "task", state: "started", taskId: "t", operation: "turn" },
});

describe("chat model", () => {
  it("maps transcript entries to chat items", () => {
    expect(
      transcriptItems([
        { kind: "user", text: "hi" },
        { kind: "tool", toolName: "read_file" },
        { kind: "assistant", text: "long", truncated: true },
      ]),
    ).toEqual([
      { kind: "user", text: "hi" },
      { kind: "tool", toolName: "read_file", state: "called" },
      { kind: "assistant", text: "long", truncated: true },
    ]);
  });

  it("assembles streamed text and tool progress for a live task", () => {
    const items = liveItems(
      [
        started(4),
        turn(5, { type: "text.delta", text: "Hel" }),
        turn(6, { type: "text.delta", text: "lo" }),
        turn(7, {
          type: "tool.started",
          toolCallId: "c1",
          toolName: "read_file",
        }),
        turn(8, {
          type: "tool.completed",
          toolCallId: "c1",
          toolName: "read_file",
        }),
        turn(9, { type: "text.delta", text: "Done" }),
      ],
      3,
    );
    expect(items).toEqual([
      { kind: "assistant", text: "Hello" },
      { kind: "tool", toolName: "read_file", state: "done" },
      { kind: "assistant", text: "Done" },
    ]);
  });

  it("skips turns the snapshot already holds and reports failures", () => {
    const items = liveItems(
      [
        started(2),
        turn(3, { type: "text.delta", text: "already in transcript" }),
        {
          sequence: 4,
          event: { kind: "task", state: "finished", taskId: "t", status: "x" },
        },
        started(5),
        turn(6, { type: "text.delta", text: "partial" }),
        {
          sequence: 7,
          event: {
            kind: "task",
            state: "failed",
            taskId: "t",
            error: "server_restarted",
          },
        },
      ],
      3,
    );
    expect(items).toEqual([
      { kind: "assistant", text: "partial" },
      {
        kind: "notice",
        tone: "error",
        text: "Interrupted by a server restart",
      },
    ]);
  });
});

describe("session event buffer", () => {
  it("drops replayed duplicates and builds the resume URL", () => {
    const buffer = new SessionEventBuffer("epoch-1", 3);
    expect(buffer.add(started(4))).toBe(true);
    expect(buffer.add(started(4))).toBe(false);
    expect(buffer.add(started(2))).toBe(false);
    expect(buffer.add(started(6))).toBe(true);
    expect(buffer.cursor).toBe(6);
    expect(buffer.streamUrl("/api/projects/p/sessions/s")).toBe(
      "/api/projects/p/sessions/s/events?epoch=epoch-1&after=6",
    );
    buffer.rebase(4);
    expect(buffer.events.map((event) => event.sequence)).toEqual([6]);
    // A newer snapshot moves the resume point forward, never back.
    buffer.rebase(9);
    expect(buffer).toMatchObject({ base: 9, cursor: 9 });
    expect(buffer.events).toEqual([]);
    expect(buffer.add(started(8))).toBe(false);
    buffer.rebase(7);
    expect(buffer.cursor).toBe(9);
    buffer.reset("epoch-2", 10);
    expect(buffer).toMatchObject({ epoch: "epoch-2", cursor: 10, base: 10 });
    expect(buffer.events).toEqual([]);
  });

  it("parses only well-formed session events", () => {
    expect(parseSessionEvent(JSON.stringify(started(1)))).toEqual(started(1));
    expect(parseSessionEvent("not json")).toBeUndefined();
    expect(parseSessionEvent('{"sequence":"1","event":{}}')).toBeUndefined();
  });
});
