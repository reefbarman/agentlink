import { describe, expect, it } from "vitest";

import { createAlternateScreenTracker } from "./alternateScreenTracker.js";

describe("alternate screen tracker", () => {
  it.each([47, 1047, 1049])(
    "tracks DEC private alternate-screen mode %i",
    (mode) => {
      const tracker = createAlternateScreenTracker();
      const enter = `before\x1b[?${mode}hafter`;
      const exit = `done\x1b[?${mode}lprompt`;

      expect(tracker.push(enter)).toEqual({
        data: enter,
        alternateScreen: true,
        transitions: [{ type: "enter", modes: [mode] }],
      });
      expect(tracker.alternateScreen).toBe(true);
      expect(tracker.push(exit)).toEqual({
        data: exit,
        alternateScreen: false,
        transitions: [{ type: "exit", modes: [mode] }],
      });
    },
  );

  it("recognizes alternate modes inside multi-parameter DECSET/DECRST", () => {
    const tracker = createAlternateScreenTracker();

    expect(tracker.push("\x1b[?;25;1049;2004h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);
    expect(tracker.push("\x1b[?1049;47;47;l").transitions).toEqual([
      { type: "exit", modes: [1049, 47] },
    ]);
  });

  it("preserves state across arbitrary CSI chunk boundaries", () => {
    const tracker = createAlternateScreenTracker();
    const chunks = [
      "text\x1b",
      "[",
      "?10",
      "49",
      "h",
      "tui",
      "\x1b[?1049",
      "l",
    ];
    const results = chunks.map((chunk) => tracker.push(chunk));

    expect(results.map((result) => result.data).join("")).toBe(chunks.join(""));
    expect(results.flatMap((result) => result.transitions)).toEqual([
      { type: "enter", modes: [1049] },
      { type: "exit", modes: [1049] },
    ]);
    expect(tracker.alternateScreen).toBe(false);
  });

  it("supports 8-bit CSI and ST control forms", () => {
    const tracker = createAlternateScreenTracker();

    expect(tracker.push("\x9b?1049h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);
    expect(tracker.push("\x9dtitle\x9c\x9b?1049l").transitions).toEqual([
      { type: "exit", modes: [1049] },
    ]);
  });

  it("ignores CSI lookalikes inside OSC strings terminated by BEL or split ST", () => {
    const tracker = createAlternateScreenTracker();
    const bel = "\x1b]0;title\x1b[?1049h\x07";
    const stPrefix = "\x1b]8;;https://example.test/\x1b[?1049h\x1b";

    expect(tracker.push(bel).transitions).toEqual([]);
    expect(tracker.push(stPrefix).transitions).toEqual([]);
    expect(tracker.push("\\label").transitions).toEqual([]);
    expect(tracker.alternateScreen).toBe(false);
  });

  it("keeps DCS/APC payloads shielded across BEL and split ST", () => {
    const tracker = createAlternateScreenTracker();
    const dcs = "\x1bPpayload\x07\x1b[?1049h\x1b";

    expect(tracker.push(dcs).transitions).toEqual([]);
    expect(tracker.push("\\").transitions).toEqual([]);
    expect(tracker.push("\x1b[?1049h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);

    tracker.reset();
    expect(tracker.push("\x9fdata\x9b?1049h\x9c").transitions).toEqual([]);
    expect(tracker.alternateScreen).toBe(false);
  });

  it("terminates strings when BEL or C1 ST follows a pending escape", () => {
    const tracker = createAlternateScreenTracker();

    expect(tracker.push("\x1b]title\x1b\x07\x1b[?1049h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);

    tracker.reset();
    expect(tracker.push("\x1bPdata\x1b\x9c\x1b[?1049h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);
  });

  it("handles CAN and SUB cancellation inside CSI and string controls", () => {
    const tracker = createAlternateScreenTracker();

    expect(tracker.push("\x1b[?1049\x18h").transitions).toEqual([]);
    expect(tracker.push("\x9b?1049\x1al").transitions).toEqual([]);
    expect(tracker.push("\x1b]title\x1a\x1b[?1049h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);
  });

  it("ignores malformed, non-private, unsupported, and overflowing CSI", () => {
    const tracker = createAlternateScreenTracker();
    const oversized = `\x1b[?${"1;".repeat(80)}1049h`;
    const input = [
      "\x1b[1049h",
      "\x1b[?1049x",
      "\x1b[?1049 h",
      "\x1b[?1049:h",
      "\x1b[?9999h",
      "\x1b[?h",
      oversized,
    ].join("");

    expect(tracker.push(input)).toEqual({
      data: input,
      alternateScreen: false,
      transitions: [],
    });
  });

  it("emits transitions only when overlapping active modes cross empty state", () => {
    const tracker = createAlternateScreenTracker();

    expect(tracker.push("\x1b[?1049h\x1b[?47h").transitions).toEqual([
      { type: "enter", modes: [1049] },
    ]);
    expect(tracker.push("\x1b[?1047l\x1b[?1049l").transitions).toEqual([]);
    expect(tracker.alternateScreen).toBe(true);
    expect(tracker.push("\x1b[?47l").transitions).toEqual([
      { type: "exit", modes: [47] },
    ]);
    expect(tracker.alternateScreen).toBe(false);
  });

  it("exposes parser ground state for safe replay checkpoints", () => {
    const tracker = createAlternateScreenTracker();
    expect(tracker.atGround).toBe(true);
    tracker.push("\x1b[");
    expect(tracker.atGround).toBe(false);
    tracker.push("?1049h");
    expect(tracker.atGround).toBe(true);
  });

  it("reset clears parser and alternate-screen state", () => {
    const tracker = createAlternateScreenTracker();
    tracker.push("\x1b[?1049h\x1b[");
    expect(tracker.alternateScreen).toBe(true);

    tracker.reset();

    expect(tracker.alternateScreen).toBe(false);
    expect(tracker.push("?1049l")).toEqual({
      data: "?1049l",
      alternateScreen: false,
      transitions: [],
    });
  });
});
