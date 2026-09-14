import {
  appendRendererFixtureUpdate,
  createRendererBakeoffFixture,
} from "./rendererBakeoffFixture.js";
import { describe, expect, it, vi } from "vitest";

import { InkRendererFixture } from "./inkRendererFixture.js";
import React from "react";
import { render } from "ink-testing-library";

describe("Ink renderer bakeoff fixture", () => {
  it("renders the bounded information hierarchy at wide and narrow widths", () => {
    const fixture = createRendererBakeoffFixture();
    const wide = render(
      <InkRendererFixture fixture={fixture} width={120} height={34} />,
    );
    const narrow = render(
      <InkRendererFixture fixture={fixture} width={78} height={34} />,
    );

    expect(wide.lastFrame()).toContain("AgentLink · fixture-session");
    expect(wide.lastFrame()).toContain("const sequence = 1000");
    expect(wide.lastFrame()).toContain("Activity shelf");
    expect(wide.lastFrame()).toContain("diff --git a/src/greeting.ts");
    expect(wide.lastFrame()).toContain("Compare both renderers");
    expect(narrow.lastFrame()).toContain("78×34");
    expect(narrow.lastFrame()).toContain("Measure the package closure");

    wide.unmount();
    narrow.unmount();
  });

  it("redraws streaming transcript and concurrent command output deterministically", () => {
    const fixture = createRendererBakeoffFixture();
    const screen = render(
      <InkRendererFixture fixture={fixture} width={120} height={34} />,
    );
    const updated = appendRendererFixtureUpdate(
      fixture,
      " streamed-token",
      "\nPASS renderer fixture",
    );

    screen.rerender(
      <InkRendererFixture fixture={updated} width={120} height={34} />,
    );

    expect(screen.lastFrame()).toContain("streamed-token");
    expect(screen.lastFrame()).toContain("PASS renderer fixture");
    expect(screen.frames.length).toBeGreaterThan(1);
    screen.unmount();
  });

  it("keeps the final slow-stream update visible without unbounding the layout", async () => {
    let fixture = createRendererBakeoffFixture();
    const screen = render(
      <InkRendererFixture fixture={fixture} width={78} height={24} />,
    );

    for (let index = 1; index <= 20; index += 1) {
      fixture = appendRendererFixtureUpdate(
        fixture,
        ` token-${index}`,
        `\nchunk-${index}`,
      );
      screen.rerender(
        <InkRendererFixture fixture={fixture} width={78} height={24} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(screen.lastFrame()).toContain("token-20");
    expect(screen.lastFrame()).toContain("chunk-20");
    expect((screen.lastFrame() ?? "").split("\n")).toHaveLength(24);
    expect(screen.frames.length).toBeGreaterThan(10);
    screen.unmount();
  });

  it("renders wide Unicode safely in the narrow layout", () => {
    const base = createRendererBakeoffFixture();
    const fixture = createRendererBakeoffFixture({
      projection: {
        ...base.projection,
        transcript: base.projection.transcript.map((message, index, messages) =>
          index >= messages.length - 3
            ? {
                ...message,
                text: "Streaming 🙂漢字 café and e\u0301 combining marks",
                streaming: true,
              }
            : message,
        ),
      },
    });
    const screen = render(
      <InkRendererFixture fixture={fixture} width={42} height={18} />,
    );

    expect(screen.lastFrame()).toContain("42×18");
    expect(screen.lastFrame()).toContain("🙂");
    expect(screen.lastFrame()).not.toContain("�");
    screen.unmount();
  });

  it("dispatches focus, command-picker, multiline composer, paste, and send actions", async () => {
    const actions: unknown[] = [];
    const screen = render(
      <InkRendererFixture
        fixture={createRendererBakeoffFixture()}
        width={120}
        height={34}
        onAction={(action) => actions.push(action)}
      />,
    );

    screen.stdin.write("\t");
    await nextInputDispatch();
    screen.stdin.write("/");
    await nextInputDispatch();
    screen.stdin.write("\u001b[200~pasted block\u001b[201~");
    await nextInputDispatch();
    screen.stdin.write("\u001b\r");
    await nextInputDispatch();
    screen.stdin.write("\r");
    await nextInputDispatch();

    expect(actions).toEqual(
      expect.arrayContaining([
        { type: "focus.changed", focus: "activity" },
        { type: "command-picker.toggled", open: true },
        expect.objectContaining({ type: "composer.changed" }),
        expect.objectContaining({ type: "composer.submitted" }),
      ]),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "composer.changed",
          value: expect.stringContaining("pasted block"),
        }),
      ]),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "composer.changed",
          value: expect.stringContaining("pasted block\n"),
        }),
      ]),
    );
    screen.unmount();
  });

  it("closes the command picker before dispatching cancel", async () => {
    vi.useFakeTimers();
    try {
      const actions: unknown[] = [];
      const screen = render(
        <InkRendererFixture
          fixture={createRendererBakeoffFixture({ commandPickerOpen: true })}
          width={120}
          height={34}
          onAction={(action) => actions.push(action)}
        />,
      );

      screen.stdin.write("\u001b");
      await vi.advanceTimersByTimeAsync(20);
      screen.stdin.write("\u001b");
      await vi.advanceTimersByTimeAsync(20);

      expect(actions).toEqual(
        expect.arrayContaining([
          { type: "command-picker.toggled", open: false },
          { type: "turn.cancelled" },
        ]),
      );
      screen.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

function nextInputDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
