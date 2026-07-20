import {
  createTerminalOutputPolicyScanner,
  evaluateTerminalOsc,
} from "./terminalOutputPolicy.js";
import { describe, expect, it } from "vitest";

describe("terminal output policy scanner", () => {
  it("exposes the same pure OSC policy for future renderer handlers", () => {
    expect(evaluateTerminalOsc("52;c;secret")).toEqual({
      type: "osc",
      command: 52,
      recommendedAction: "suppress",
      reason: "clipboard",
    });
    expect(evaluateTerminalOsc("697;AgentLink;foreign;D;0")).toEqual({
      type: "osc",
      command: 697,
      recommendedAction: "suppress",
      reason: "private-shell-integration",
    });
    expect(evaluateTerminalOsc("8;;https://example.test")).toEqual({
      type: "osc",
      command: 8,
      recommendedAction: "allow",
      reason: "terminal-control",
    });
    expect(evaluateTerminalOsc("0;title", true)).toEqual({
      type: "osc",
      command: 0,
      recommendedAction: "suppress",
      reason: "oversized",
    });
  });

  it.each([
    ["\x1b]0;title\x07", 0],
    ["\x1b]2;title\x1b\\", 2],
    ["\x1b]7;file://host/path\x07", 7],
    ["\x1b]8;;https://example.test\x1b\\", 8],
    ["\x1b]9;4;1;50\x07", 9],
    ["\x1b]9;9;/workspace\x07", 9],
    ["\x1b]133;A\x07", 133],
  ])("allows terminal control %j", (input, command) => {
    const scanner = createTerminalOutputPolicyScanner();

    expect(scanner.push(input)).toEqual({
      data: input,
      decisions: [
        {
          type: "osc",
          command,
          recommendedAction: "allow",
          reason: "terminal-control",
        },
      ],
    });
  });

  it.each([
    ["\x1b]52;c;secret\x07", 52, "clipboard"],
    ["\x1b]9;message\x07", 9, "notification"],
    ["\x1b]777;notify;title;body\x07", 777, "notification"],
    ["\x1b]1337;File=name=test:data\x07", 1337, "proprietary-host-integration"],
  ] as const)("suppresses host-effect OSC %j", (input, command, reason) => {
    const scanner = createTerminalOutputPolicyScanner();

    expect(scanner.push(input)).toEqual({
      data: input,
      decisions: [
        { type: "osc", command, recommendedAction: "suppress", reason },
      ],
    });
  });

  it("preserves output and parser state across arbitrary OSC chunk boundaries", () => {
    const scanner = createTerminalOutputPolicyScanner();
    const chunks = ["before\x1b", "]52;c;", "payload\x1b", "\\after"];
    const results = chunks.map((chunk) => scanner.push(chunk));

    expect(results.map((result) => result.data).join("")).toBe(chunks.join(""));
    expect(results.flatMap((result) => result.decisions)).toEqual([
      {
        type: "osc",
        command: 52,
        recommendedAction: "suppress",
        reason: "clipboard",
      },
    ]);
  });

  it("supports ordered 7-bit and 8-bit OSC forms in one chunk", () => {
    const scanner = createTerminalOutputPolicyScanner();
    const input = "\x1b]0;title\x07\x9d52;c;secret\x9c";

    expect(scanner.push(input)).toEqual({
      data: input,
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
    });
  });

  it("does not classify OSC lookalikes inside DCS, SOS, PM, or APC strings", () => {
    const scanner = createTerminalOutputPolicyScanner();
    const input = [
      "\x1bPpayload\x1b]52;c;secret\x07\x1b\\",
      "\x98payload\x9d9;message\x9c\x9c",
      "\x1b^payload\x1b]777;notify\x07\x1b\\",
      "\x9fpayload\x9d1337;File=data\x9c\x9c",
    ].join("");

    expect(scanner.push(input)).toEqual({ data: input, decisions: [] });
  });

  it("handles pending escapes, CAN, and SUB without losing following OSC", () => {
    const scanner = createTerminalOutputPolicyScanner();

    expect(scanner.push("\x1b]0;title\x1b\x07").decisions).toEqual([
      {
        type: "osc",
        command: 0,
        recommendedAction: "allow",
        reason: "terminal-control",
      },
    ]);
    expect(scanner.push("\x1b]52;c;cancelled\x18").decisions).toEqual([]);
    expect(scanner.push("\x9d9;cancelled\x1a").decisions).toEqual([]);
    expect(scanner.push("\x1b]9;message\x07").decisions).toEqual([
      {
        type: "osc",
        command: 9,
        recommendedAction: "suppress",
        reason: "notification",
      },
    ]);
  });

  it("suppresses oversized OSC without retaining its full payload", () => {
    const scanner = createTerminalOutputPolicyScanner();
    const input = `\x1b]52;c;${"x".repeat(8_192)}\x07`;

    expect(scanner.push(input)).toEqual({
      data: input,
      decisions: [
        {
          type: "osc",
          command: 52,
          recommendedAction: "suppress",
          reason: "oversized",
        },
      ],
    });
  });

  it("allows malformed and unknown bounded OSC for emulator compatibility", () => {
    const scanner = createTerminalOutputPolicyScanner();
    const input = "\x1b]unknown;payload\x07\x1b]999;payload\x1b\\";

    expect(scanner.push(input).decisions).toEqual([
      {
        type: "osc",
        command: null,
        recommendedAction: "allow",
        reason: "terminal-control",
      },
      {
        type: "osc",
        command: 999,
        recommendedAction: "allow",
        reason: "terminal-control",
      },
    ]);
  });

  it("reset discards an incomplete OSC, including overflow state", () => {
    const scanner = createTerminalOutputPolicyScanner();
    scanner.push(`\x1b]52;c;${"x".repeat(8_193)}`);

    scanner.reset();

    expect(scanner.push("\x07\x1b]0;title\x07").decisions).toEqual([
      {
        type: "osc",
        command: 0,
        recommendedAction: "allow",
        reason: "terminal-control",
      },
    ]);
  });
});
