import { describe, expect, it } from "vitest";

import { ProductUpdateStatusStore } from "./productUpdateStatus.js";
import type { ReleaseUpdateState } from "../../updates/releaseUpdateTypes.js";

const state: ReleaseUpdateState = {
  identity: {
    product: "desktop",
    version: "0.3.0",
    target: "darwin-arm64",
    development: false,
  },
  status: "available",
  automaticChecks: true,
  lastAttemptAt: 100,
  checkedAt: 100,
  retryAt: null,
  candidate: {
    version: "0.4.0",
    tag: "desktop-v0.4.0",
    channel: "preview",
    target: "darwin-arm64",
    releaseUrl:
      "https://github.com/reefbarman/agentlink/releases/tag/desktop-v0.4.0",
    instructionsUrl:
      "https://github.com/reefbarman/agentlink/blob/main/resources/builtin-skills/documentation/references/getting-started.md",
  },
  dismissedVersion: null,
  stale: false,
};

describe("ProductUpdateStatusStore", () => {
  it("binds a validated snapshot to its owner generation", () => {
    const store = new ProductUpdateStatusStore();
    expect(
      store.publish("owner-a", "generation-1", state, undefined, 100),
    ).toMatchObject({
      hostId: "owner-a",
      generationId: "generation-1",
      state,
    });
    expect(store.get("owner-a", "generation-2", 100)).toBeUndefined();
    expect(
      store.publish(
        "owner-a",
        "generation-1",
        {
          ...state,
          candidate: {
            ...state.candidate!,
            releaseUrl: "https://evil.example/release",
          },
        },
        undefined,
        100,
      ),
    ).toBeUndefined();
  });

  it("coalesces checks, acknowledges only the matching request, and expires requests", () => {
    const store = new ProductUpdateStatusStore();
    const request = store.requestCheck("owner-a", "generation-1", 100, 45_000);
    expect(store.requestCheck("owner-a", "generation-1", 200)).toBe(request);
    store.publish("owner-a", "generation-1", state, "wrong-request", 300);
    expect(store.getPending("owner-a", "generation-1", 300)).toMatchObject({
      requestId: request.requestId,
      status: "checking",
    });
    store.publish("owner-a", "generation-1", state, request.requestId, 400);
    expect(store.getPending("owner-a", "generation-1", 400)).toBeUndefined();
    store.publish("owner-a", "generation-1", state, undefined, 401);
    expect(store.get("owner-a", "generation-1", 401)?.requestId).toBe(
      request.requestId,
    );

    const next = store.requestCheck("owner-a", "generation-1", 500, 45_000);
    expect(store.getPending("owner-a", "generation-1", 45_500)).toBeUndefined();
    expect(next.status).toBe("expired");
    expect(store.get("owner-a", "generation-1", 45_500)?.state.status).toBe(
      "unavailable",
    );
    store.publish("owner-a", "generation-1", state, next.requestId, 45_501);
    expect(store.get("owner-a", "generation-1", 45_501)?.state.status).toBe(
      "unavailable",
    );
  });

  it("drops snapshots and pending requests when an owner generation is replaced", () => {
    const store = new ProductUpdateStatusStore();
    store.publish("owner-a", "generation-1", state);
    store.requestCheck("owner-a", "generation-1");
    store.publish("owner-a", "generation-2", state);
    store.removeOwner("owner-a", "generation-1");
    expect(store.get("owner-a", "generation-1")).toBeUndefined();
    expect(store.get("owner-a", "generation-2")).toBeDefined();
    expect(store.getPending("owner-a", "generation-1")).toBeUndefined();
  });
});
