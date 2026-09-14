import {
  ActivityShelf,
  buildActivityShelfItems,
  visibleActivityShelfItems,
} from "./ActivityShelf.js";
import { describe, expect, it } from "vitest";

import React from "react";
import { createRendererBakeoffFixture } from "./rendererBakeoffFixture.js";
import { render } from "ink-testing-library";

describe("activity shelf", () => {
  it("projects only relevant activity categories and runtime summaries", () => {
    const projection = {
      ...createRendererBakeoffFixture().projection,
      usage: {
        inputTokens: 12_000,
        outputTokens: 800,
        cacheReadTokens: 2_000,
      },
      execution: {
        limits: {
          maxModelCalls: 0,
          maxToolCalls: 0,
          maxElapsedMs: 0,
          maxToolResultBytes: 0,
        },
        modelCalls: 2,
        toolCalls: 3,
        elapsedMs: 1_500,
        toolResultBytes: 64,
      },
    };

    const items = buildActivityShelfItems(projection);
    expect(items.map((item) => item.id)).toEqual([
      "context",
      "work",
      "commands",
      "approvals",
      "agents",
    ]);
    expect(items.find((item) => item.id === "context")?.summary).toContain(
      "12K in",
    );
    expect(items.find((item) => item.id === "commands")?.summary).toBe(
      "1 running · 1 noteworthy",
    );
    expect(items.find((item) => item.id === "mcp")).toBeUndefined();
    expect(items.find((item) => item.id === "tasks")).toBeUndefined();
  });

  it("shows queued work and active questions as real attention state", () => {
    const projection = {
      ...createRendererBakeoffFixture().projection,
      queuedMessages: ["Run the focused tests", "Update the docs"],
      activeQuestion: "Which model should this session use?",
    };

    const items = buildActivityShelfItems(projection);
    expect(items.find((item) => item.id === "queue")).toMatchObject({
      summary: "2 queued messages",
      details: ["1. Run the focused tests", "2. Update the docs"],
    });
    expect(items.find((item) => item.id === "questions")).toMatchObject({
      summary: "Which model should this session use?",
      details: ["Which model should this session use?"],
      attention: true,
    });
  });

  it("keeps the selected row visible inside a bounded window", () => {
    const items = buildActivityShelfItems(
      createRendererBakeoffFixture().projection,
    );
    const lastIndex = items.length - 1;
    const visible = visibleActivityShelfItems(items, lastIndex, 4);
    expect(visible).toHaveLength(4);
    expect(visible.at(-1)).toMatchObject({
      index: lastIndex,
      item: { id: "agents" },
    });
  });

  it("keeps the final selected section visible at minimum shelf height", () => {
    const screen = render(
      <ActivityShelf
        projection={createRendererBakeoffFixture().projection}
        selectedIndex={3}
        expandedIds={[]}
        focused
        height={4}
      />,
    );

    expect(screen.lastFrame()).toContain("› ▸ Agents");
    screen.unmount();
  });

  it("bounds expanded details to the available shelf rows", () => {
    const screen = render(
      <ActivityShelf
        projection={createRendererBakeoffFixture().projection}
        selectedIndex={3}
        expandedIds={["agents"]}
        focused
        height={5}
      />,
    );

    expect(screen.lastFrame()).toContain("› ▾ Agents");
    expect(screen.lastFrame()).toContain("Review the renderer fixture");
    screen.unmount();
  });

  it("renders expanded details and sanitizes untrusted activity text", () => {
    const projection = {
      ...createRendererBakeoffFixture().projection,
      commands: [
        {
          ...createRendererBakeoffFixture().projection.commands[0]!,
          command: "printf '\u001b[2J'",
        },
      ],
    };
    const screen = render(
      <ActivityShelf
        projection={projection}
        selectedIndex={1}
        expandedIds={["commands"]}
        focused
        height={8}
      />,
    );

    expect(screen.lastFrame()).toContain("Activity (focused) · 4 live");
    expect(screen.lastFrame()).toContain("printf '␛[2J'");
    expect(screen.lastFrame()).not.toContain("printf '\u001b[2J'");
    screen.unmount();
  });
});
