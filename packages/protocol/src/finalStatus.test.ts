import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DEFAULT_COMPLETED_CONTINUE_ACTION,
  formatAutoContinueModelPrompt,
  getFinalMessageContinueAction,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
  type FinalMessageMarker,
} from "./finalStatus.js";

describe("final status protocol", () => {
  it("keeps structured final markers package-closed", () => {
    expectTypeOf<FinalMessageMarker["result"]>().toMatchTypeOf<
      import("./fleetResult.js").FleetResultEnvelope | undefined
    >();
  });
});

describe("getLatestAutoContinueAction", () => {
  it("never offers a next step on legacy waiting markers", () => {
    const marker: FinalMessageMarker = {
      status: "waiting_for_user",
      source: "tool",
      continueAction: { label: "Next", prompt: "Do available work" },
    };
    expect(getFinalMessageContinueAction(marker)).toBeUndefined();
    expect(
      getLatestAutoContinueAction([
        { id: "waiting", role: "assistant", finalMarker: marker },
      ]),
    ).toBeUndefined();
  });

  it("guides the default continuation from a completed phase back to the full approved plan", () => {
    const { prompt } = DEFAULT_COMPLETED_CONTINUE_ACTION;

    expect(prompt).toContain("Continue working from where you left off");
    expect(prompt).toContain("phase, handover, or scoped subtask");
    expect(prompt).toContain(
      "navigation point—not proof of overall completion",
    );
    expect(prompt).toContain("original user request");
    expect(prompt).toContain("parent/source-of-truth plan");
    expect(prompt).toContain("higher-level plans if nested");
    expect(prompt).toContain("scope the user actually requested");
    expect(prompt).not.toMatch(/approv/i);
    expect(DEFAULT_COMPLETED_CONTINUE_ACTION.prompt).toContain(
      "next explicit unfinished phase, plan item, subtask, or validation step",
    );
    expect(prompt).toContain("missing decision or prerequisite");
    expect(prompt).toContain("Do not invent work or broaden scope");
    expect(prompt).toContain("user's full request is complete");
  });

  it("labels Auto Continue prompts as automated, not user approval", () => {
    const proposed = formatAutoContinueModelPrompt(
      "Run the tests",
      "agent_proposed",
    );
    expect(proposed).toMatch(/^<auto-continue-notice>\n/);
    expect(proposed).toContain("The user did not type it.");
    expect(proposed).toContain("does not approve new scope");
    expect(proposed).toContain("your own plan, not a user instruction");
    expect(proposed).toMatch(
      /<\/auto-continue-notice>\n\nYour proposed next step:\nRun the tests$/,
    );

    const fallback = formatAutoContinueModelPrompt(
      DEFAULT_COMPLETED_CONTINUE_ACTION.prompt,
      "default",
    );
    expect(fallback).toContain("AgentLink's default continuation");
    expect(fallback).not.toContain("Your proposed next step");
    expect(
      fallback.endsWith(
        `</auto-continue-notice>\n\n${DEFAULT_COMPLETED_CONTINUE_ACTION.prompt}`,
      ),
    ).toBe(true);
  });

  it("continues completed markers even when the legacy tool-set suppression field is present", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "completed",
            source: "tool",
            continueActionSuppressed: true,
          },
        },
      ]),
    ).toEqual({
      messageId: "assistant-1",
      ...DEFAULT_COMPLETED_CONTINUE_ACTION,
    });
  });

  it("does not expose consumed completed markers for Auto Continue", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "completed",
            source: "tool",
            continueActionConsumed: true,
          },
        },
      ]),
    ).toBeUndefined();
  });

  it("stops scanning at user messages so older markers are stale", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "completed",
            source: "tool",
          },
        },
        { id: "user-1", role: "user" },
      ]),
    ).toBeUndefined();
  });

  it("does not auto-continue non-completed final markers", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "waiting_for_user",
            source: "tool",
          },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("getLatestFinalMessageMarker", () => {
  it("returns non-completed final markers so callers can explain heuristic stops", () => {
    expect(
      getLatestFinalMessageMarker([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "waiting_for_user",
            source: "tool",
          },
        },
      ]),
    ).toEqual({
      messageId: "assistant-1",
      marker: {
        status: "waiting_for_user",
        source: "tool",
      },
    });
  });
});
