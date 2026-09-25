import { describe, expect, it } from "vitest";

import { McpOperationRegistry } from "./mcpOperationRegistry.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("McpOperationRegistry", () => {
  it("routes to one owner across concurrent operations on the same server", async () => {
    const registry = new McpOperationRegistry<string>();
    const first = deferred();
    const second = deferred();
    const a = registry.run("records", "turn-a", undefined, () => first.promise);
    const b = registry.run(
      "records",
      "turn-a",
      undefined,
      () => second.promise,
    );

    const claim = registry.claim("records");
    expect(claim?.owner).toBe("turn-a");
    first.resolve();
    await a;
    expect(claim?.signal.aborted).toBe(false);
    expect(registry.claim("records")?.owner).toBe("turn-a");
    second.resolve();
    await b;
    expect(claim?.signal.aborted).toBe(true);
    expect(registry.claim("records")).toBeUndefined();
  });

  it("retires an owner's claims immediately without affecting another owner", async () => {
    const registry = new McpOperationRegistry<string>();
    const done = deferred();
    const a = registry.run("records", "turn-a", undefined, () => done.promise);
    const b = registry.run("other", "turn-b", undefined, () => done.promise);
    const claim = registry.claim("records");
    registry.cancelOwner("turn-a");
    expect(claim?.signal.aborted).toBe(true);
    expect(registry.claim("records")).toBeUndefined();
    expect(registry.claim("other")?.owner).toBe("turn-b");
    done.resolve();
    await Promise.all([a, b]);
  });

  it("returns no claim when operations from different owners are live", async () => {
    const registry = new McpOperationRegistry<string>();
    const done = deferred();
    const a = registry.run("records", "turn-a", undefined, () => done.promise);
    const b = registry.run("records", "turn-b", undefined, () => done.promise);
    const other = registry.run(
      "other",
      "turn-b",
      undefined,
      () => done.promise,
    );

    expect(registry.claim("records")).toBeUndefined();
    expect(registry.claim("other")?.owner).toBe("turn-b");
    done.resolve();
    await Promise.all([a, b, other]);
  });

  it("ignores cancelled operations and aborts the claim when the last one cancels", async () => {
    const registry = new McpOperationRegistry<string>();
    const done = deferred();
    const cancelled = new AbortController();
    const live = new AbortController();
    const a = registry.run(
      "records",
      "turn-a",
      cancelled.signal,
      () => done.promise,
    );
    const b = registry.run(
      "records",
      "turn-b",
      live.signal,
      () => done.promise,
    );

    expect(registry.claim("records")).toBeUndefined();
    cancelled.abort();
    const claim = registry.claim("records");
    expect(claim?.owner).toBe("turn-b");
    live.abort();
    expect(claim?.signal.aborted).toBe(true);
    expect(registry.claim("records")).toBeUndefined();
    done.resolve();
    await Promise.all([a, b]);
  });
});
