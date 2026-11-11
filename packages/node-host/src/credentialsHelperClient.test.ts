import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCredentialsHelperEntry } from "./credentialsHelperClient.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createCredentialsHelperEntry", () => {
  it("waits for a timed-out helper to exit before rejecting", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    const entry = createCredentialsHelperEntry({
      helperPath: "slow-helper",
      service: "test-service",
      account: "test-account",
      label: "Test credential",
      timeoutMs: 500,
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    });
    let settled = false;
    const result = entry.getPassword().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    child.emit("close");
    await expect(result).resolves.toMatchObject({
      message: "agentlink_credentials_helper_timeout",
    });
    expect(settled).toBe(true);
  });
});
