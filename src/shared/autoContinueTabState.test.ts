import {
  AutoContinueTabStateCache,
  createAutoContinueTabState,
} from "./autoContinueTabState.js";
import { describe, expect, it } from "vitest";

describe("AutoContinueTabStateCache", () => {
  it("restores each tab's Auto Continue setting independently", () => {
    const cache = new AutoContinueTabStateCache();
    const first = createAutoContinueTabState("session-1");
    first.enabled = true;
    first.status = "Auto Continue enabled.";
    first.continuedMessageIds.add("message-1");
    first.count = 1;

    cache.save("tab-1", first);

    expect(cache.restore("tab-2", "session-2")).toEqual(
      createAutoContinueTabState("session-2"),
    );
    expect(cache.restore("tab-1", "session-1")).toEqual(first);
  });

  it("keeps the setting but resets turn progress when a tab starts a new session", () => {
    const cache = new AutoContinueTabStateCache();
    const state = createAutoContinueTabState("session-1");
    state.enabled = true;
    state.status = "Auto Continue sent 1/10.";
    state.continuedMessageIds.add("message-1");
    state.count = 1;
    state.pendingUserMessageId = "user-1";
    cache.save("tab-1", state);

    expect(cache.restore("tab-1", "session-2")).toEqual({
      enabled: true,
      status: "",
      sessionId: "session-2",
      mode: null,
      reasoningEffort: null,
      continuedMessageIds: new Set(),
      count: 0,
      pendingUserMessageId: null,
    });
  });
});
