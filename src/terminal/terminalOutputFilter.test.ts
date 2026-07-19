import { describe, expect, it } from "vitest";

import { createTerminalOutputFilter } from "./terminalOutputFilter.js";

describe("terminal output filter", () => {
  it("preserves allowed OSC and removes host-effect OSC between ordinary data", () => {
    const filter = createTerminalOutputFilter();
    const input = [
      "before",
      "\x1b]0;title\x07",
      "middle",
      "\x1b]52;c;secret\x1b\\",
      "after",
    ].join("");

    expect(filter.push(input)).toEqual({
      data: "before\x1b]0;title\x07middleafter",
      decisions: [
        {
          type: "osc",
          command: 0,
          recommendedAction: "allow",
          reason: "terminal-control",
        },
        {
          type: "osc",
          command: 52,
          recommendedAction: "suppress",
          reason: "clipboard",
        },
      ],
      suppressedCharacters: "\x1b]52;c;secret\x1b\\".length,
    });
  });

  it("filters split 7-bit and 8-bit OSC without leaking partial frames", () => {
    const filter = createTerminalOutputFilter();
    const results = [
      filter.push("before\x1b"),
      filter.push("]9;mes"),
      filter.push("sage\x07between\x9d777;notify"),
      filter.push(";body\x9cafter"),
    ];

    expect(results.map((result) => result.data).join("")).toBe(
      "beforebetweenafter",
    );
    expect(results.flatMap((result) => result.decisions)).toEqual([
      {
        type: "osc",
        command: 9,
        recommendedAction: "suppress",
        reason: "notification",
      },
      {
        type: "osc",
        command: 777,
        recommendedAction: "suppress",
        reason: "notification",
      },
    ]);
  });

  it("passes bounded canceled OSC through exactly", () => {
    const filter = createTerminalOutputFilter();
    const input = "before\x1b]52;c;not-complete\x18after";

    expect(filter.push(input)).toEqual({
      data: input,
      decisions: [],
      suppressedCharacters: 0,
    });
  });

  it("fails closed for oversized terminated or canceled OSC", () => {
    const filter = createTerminalOutputFilter({ maxOscCharacters: 4 });
    const terminated = "\x1b]0;title\x07";
    const canceled = "\x1b]52;secret\x18";

    const first = filter.push(`a${terminated}b`);
    expect(first.data).toBe("ab");
    expect(first.decisions).toEqual([
      {
        type: "osc",
        command: null,
        recommendedAction: "suppress",
        reason: "oversized",
      },
    ]);
    expect(first.suppressedCharacters).toBe(terminated.length);

    const second = filter.push(`c${canceled}d`);
    expect(second.data).toBe("cd");
    expect(second.decisions).toEqual([
      {
        type: "osc",
        command: null,
        recommendedAction: "suppress",
        reason: "oversized",
      },
    ]);
    expect(second.suppressedCharacters).toBe(canceled.length);
  });

  it("does not interpret OSC lookalikes inside terminal string controls", () => {
    const filter = createTerminalOutputFilter();
    const input = [
      "\x1bPpayload\x1b]52;c;secret\x07\x1b\\",
      "\x9fpayload\x9d777;notify\x9c\x9c",
    ].join("");

    expect(filter.push(input)).toEqual({
      data: input,
      decisions: [],
      suppressedCharacters: 0,
    });
  });

  it("fails closed for bounded and oversized incomplete OSC", () => {
    const bounded = createTerminalOutputFilter();
    expect(bounded.push("before\x1b]0;title").data).toBe("before");
    expect(bounded.finish()).toEqual({
      data: "",
      decisions: [
        {
          type: "osc",
          command: 0,
          recommendedAction: "suppress",
          reason: "incomplete",
        },
      ],
      suppressedCharacters: "\x1b]0;title".length,
    });

    const oversized = createTerminalOutputFilter({ maxOscCharacters: 2 });
    expect(oversized.push("before\x1b]52;secret").data).toBe("before");
    expect(oversized.finish()).toEqual({
      data: "",
      decisions: [
        {
          type: "osc",
          command: null,
          recommendedAction: "suppress",
          reason: "oversized",
        },
      ],
      suppressedCharacters: "\x1b]52;secret".length,
    });
  });

  it("preserves pending non-OSC escapes and reset discards pending state", () => {
    const filter = createTerminalOutputFilter();
    expect(filter.push("a\x1b").data).toBe("a");
    expect(filter.finish().data).toBe("\x1b");

    filter.push("hidden\x1b]52;c;secret");
    filter.reset();
    expect(filter.push("visible")).toEqual({
      data: "visible",
      decisions: [],
      suppressedCharacters: 0,
    });
  });

  it("validates the configured OSC bound", () => {
    expect(() => createTerminalOutputFilter({ maxOscCharacters: 0 })).toThrow(
      "maxOscCharacters must be a positive safe integer",
    );
  });
});
