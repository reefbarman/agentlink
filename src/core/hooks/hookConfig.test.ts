import { describe, expect, it } from "vitest";

import { HOOK_EVENT_NAMES } from "./contracts";
import { parseHookSources } from "./hookConfig";

describe("parseHookSources", () => {
  it("supports all lifecycle events and preserves additive source order", () => {
    const hooks = Object.fromEntries(
      HOOK_EVENT_NAMES.map((event) => [
        event,
        [
          {
            matcher: "Read|Write",
            hooks: [{ type: "command", command: `echo ${event}` }],
          },
        ],
      ]),
    );
    const result = parseHookSources([
      { id: "first", content: JSON.stringify({ hooks }) },
      {
        id: "second",
        content: JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "echo later" }] },
            ],
          },
        }),
      },
    ]);

    expect(result.handlers).toHaveLength(13);
    expect(result.handlers.map((handler) => handler.declarationIndex)).toEqual(
      Array.from({ length: 13 }, (_, index) => index),
    );
    expect(result.handlers.at(-1)?.source.id).toBe("second");
    expect(
      result.handlers
        .find((handler) => handler.event === "PreToolUse")
        ?.matcher.test("Read"),
    ).toBe(true);
    expect(
      result.handlers
        .find((handler) => handler.event === "PreToolUse")
        ?.matcher.test("Reader"),
    ).toBe(false);
    expect(
      result.handlers
        .find((handler) => handler.event === "Stop")
        ?.matcher.test("anything"),
    ).toBe(true);
  });

  it("uses all-match and regex semantics and diagnoses unsupported handlers", () => {
    const result = parseHookSources([
      {
        id: "config",
        content: JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "echo all" }],
              },
              {
                matcher: "^mcp__.+$",
                hooks: [{ type: "command", command: "echo regex" }],
              },
              {
                matcher: "*",
                hooks: [
                  { type: "mcp_tool" },
                  { type: "prompt" },
                  { type: "agent" },
                ],
              },
              { matcher: "[", hooks: [{ type: "command", command: "bad" }] },
            ],
          },
        }),
      },
    ]);

    expect(result.handlers[0]?.matcher.test(undefined)).toBe(true);
    expect(result.handlers[1]?.matcher.test("mcp__server__tool")).toBe(true);
    expect(result.handlers).toHaveLength(5);
    expect(
      result.diagnostics.filter(
        (item) => item.code === "hook_handler_unsupported",
      ),
    ).toHaveLength(3);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "hook_matcher_regex_invalid" }),
    );
  });

  it("produces stable executable hashes, source keys, and plugin metadata", () => {
    const definition = {
      id: "plugin-a",
      kind: "plugin" as const,
      reviewed: true,
      plugin: { root: "/plugin", data: "/data", env: { A: "${PLUGIN_ROOT}" } },
      content: JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/a.js" }],
            },
          ],
        },
      }),
    };
    const first = parseHookSources([definition]).handlers[0];
    const second = parseHookSources([definition]).handlers[0];
    const moved = parseHookSources([{ ...definition, id: "plugin-b" }])
      .handlers[0];

    expect(first?.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first?.hash).toBe(second?.hash);
    expect(first?.key).toBe(second?.key);
    expect(first?.key).not.toBe(moved?.key);
    expect(first?.source.reviewed).toBe(true);
    expect(first?.source.replacements).toEqual({
      "${PLUGIN_ROOT}": "/plugin",
      "${PLUGIN_DATA}": "/data",
      "${CLAUDE_PLUGIN_ROOT}": "/plugin",
      "${CLAUDE_PLUGIN_DATA}": "/data",
    });
  });
});
