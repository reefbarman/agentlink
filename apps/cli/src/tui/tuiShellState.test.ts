import { describe, expect, it } from "vitest";
import {
  initialTuiShellState,
  maxTranscriptOffset,
  reduceTuiShellState,
  selectedPickerItem,
  visibleTranscript,
} from "./tuiShellState.js";

import { createRendererBakeoffFixture } from "./rendererBakeoffFixture.js";
import { parseTuiCommand } from "./tuiCommand.js";

describe("TUI shell state", () => {
  it("tracks command and file pickers independently of the session projection", () => {
    let state = reduceTuiShellState(initialTuiShellState(), {
      type: "composer.changed",
      value: "/se",
    });
    expect(state.picker).toMatchObject({ kind: "commands", query: "/se" });
    expect(selectedPickerItem(state)?.id).toBe("/sessions");

    state = reduceTuiShellState(state, {
      type: "composer.changed",
      value: "Review @src/tu",
    });
    state = reduceTuiShellState(state, {
      type: "picker.refreshed",
      items: [
        {
          id: "src/tui/InkChatApp.tsx",
          label: "src/tui/InkChatApp.tsx",
          detail: "project file",
          insertText: "src/tui/InkChatApp.tsx",
        },
      ],
    });
    expect(state.picker).toMatchObject({ kind: "files", query: "src/tu" });
  });

  it("navigates and expands bounded activity shelf rows", () => {
    let state = initialTuiShellState();
    state = reduceTuiShellState(state, {
      type: "activity.moved",
      offset: -1,
      itemCount: 9,
    });
    expect(state.activitySelectedIndex).toBe(8);
    state = reduceTuiShellState(state, {
      type: "activity.toggled",
      itemId: "agents",
    });
    expect(state.expandedActivityIds).toEqual(["agents"]);
    state = reduceTuiShellState(state, {
      type: "activity.moved",
      offset: 1,
      itemCount: 9,
    });
    expect(state.activitySelectedIndex).toBe(0);
    expect(state.expandedActivityIds).toEqual([]);
    state = reduceTuiShellState(state, {
      type: "activity.toggled",
      itemId: "context",
    });
    state = reduceTuiShellState(state, { type: "session.changed" });
    expect(state.activitySelectedIndex).toBe(0);
    expect(state.expandedActivityIds).toEqual([]);
    expect(state.followOutput).toBe(true);
    state = reduceTuiShellState(state, { type: "activity.first" });
    expect(state.activitySelectedIndex).toBe(0);
    state = reduceTuiShellState(state, {
      type: "activity.last",
      itemCount: 9,
    });
    expect(state.activitySelectedIndex).toBe(8);
  });

  it("bounds history and restores the draft after navigation", () => {
    let state = initialTuiShellState();
    state = reduceTuiShellState(state, {
      type: "composer.submitted",
      value: "first",
    });
    state = reduceTuiShellState(state, {
      type: "composer.submitted",
      value: "second",
    });
    state = reduceTuiShellState(state, {
      type: "composer.changed",
      value: "draft",
    });
    state = reduceTuiShellState(state, { type: "history.previous" });
    expect(state.composer).toBe("second");
    state = reduceTuiShellState(state, { type: "history.previous" });
    expect(state.composer).toBe("first");
    state = reduceTuiShellState(state, { type: "history.next" });
    state = reduceTuiShellState(state, { type: "history.next" });
    expect(state.composer).toBe("draft");
  });

  it("scrolls a row-bounded transcript and returns to live following", () => {
    const projection = createRendererBakeoffFixture().projection;
    const viewportRows = 12;
    const width = 60;
    const maxOffset = maxTranscriptOffset(projection, viewportRows, width);
    let state = initialTuiShellState();
    expect(
      visibleTranscript(projection, state, viewportRows, width).at(-1)?.id,
    ).toBe("fixture-message-1000");
    state = reduceTuiShellState(state, {
      type: "scroll.by",
      rows: 10,
      maxOffset,
    });
    expect(
      visibleTranscript(projection, state, viewportRows, width).at(-1)?.id,
    ).not.toBe("fixture-message-1000");
    state = reduceTuiShellState(state, {
      type: "scroll.top",
      maxOffset,
    });
    expect(
      visibleTranscript(projection, state, viewportRows, width).at(0)?.id,
    ).toBe("fixture-message-1");
    state = reduceTuiShellState(state, { type: "scroll.bottom" });
    expect(state.followOutput).toBe(true);
    expect(
      visibleTranscript(projection, state, viewportRows, width).at(-1)?.id,
    ).toBe("fixture-message-1000");
  });

  it("scrolls within an oversized message one row at a time", () => {
    const fixture = createRendererBakeoffFixture().projection;
    const projection = {
      ...fixture,
      transcript: [
        {
          id: "long-user",
          role: "user" as const,
          text: Array.from({ length: 20 }, (_, index) => `row-${index}`).join(
            "\n",
          ),
          streaming: false,
        },
        {
          id: "latest-assistant",
          role: "assistant" as const,
          text: "latest",
          streaming: false,
        },
      ],
    };
    const viewportRows = 4;
    const width = 20;
    const maxOffset = maxTranscriptOffset(projection, viewportRows, width);
    const bottom = visibleTranscript(
      projection,
      initialTuiShellState(),
      viewportRows,
      width,
    );
    const oneRowUpState = reduceTuiShellState(initialTuiShellState(), {
      type: "scroll.by",
      rows: 1,
      maxOffset,
    });
    const oneRowUp = visibleTranscript(
      projection,
      oneRowUpState,
      viewportRows,
      width,
    );

    expect(bottom.at(-1)?.id).toBe("latest-assistant");
    expect(oneRowUp.map((message) => message.id)).toContain("long-user");
    expect(
      oneRowUp.find((message) => message.id === "long-user")?.text,
    ).toContain("row-19");
  });
});

describe("TUI commands", () => {
  it("includes the review and selector controls in command completion", () => {
    let state = reduceTuiShellState(initialTuiShellState(), {
      type: "composer.changed",
      value: "/",
    });
    expect(state.picker?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "/sessions",
        "/model",
        "/reasoning",
        "/mode",
        "/processes",
        "/agents",
        "/approvals",
        "/help",
      ]),
    );

    state = reduceTuiShellState(state, {
      type: "composer.changed",
      value: "/rea",
    });
    expect(selectedPickerItem(state)?.id).toBe("/reasoning");
  });

  it("parses session selection and rejects incomplete commands", () => {
    expect(parseTuiCommand("/sessions session-2")).toEqual({
      type: "session-select",
      sessionId: "session-2",
    });
    expect(() => parseTuiCommand("/output")).toThrow(
      "/output requires a command ID",
    );
    expect(parseTuiCommand("normal prompt")).toBeUndefined();
  });
});
