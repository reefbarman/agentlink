import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { withFileLocks } from "./fileLock.js";

let pathSequence = 0;

function uniquePath(label: string): string {
  pathSequence += 1;
  return path.join(
    os.tmpdir(),
    `agentlink-file-lock-${process.pid}-${pathSequence}-${label}`,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("withFileLocks", () => {
  it("acquires duplicate paths once and runs the callback once", async () => {
    const filePath = uniquePath("duplicate");
    const entered = deferred<void>();
    const release = deferred<void>();
    const callback = vi.fn(async () => {
      entered.resolve(undefined);
      await release.promise;
      return "completed";
    });

    const operation = withFileLocks([filePath, filePath, filePath], callback);

    await entered.promise;
    release.resolve(undefined);

    await expect(operation).resolves.toBe("completed");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("serializes reverse-order overlapping sets without deadlock", async () => {
    const fileA = uniquePath("overlap-a");
    const fileB = uniquePath("overlap-b");
    const blockerEntered = deferred<void>();
    const releaseBlocker = deferred<void>();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const blocker = withFileLocks([fileA], async () => {
      blockerEntered.resolve(undefined);
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;

    const first = withFileLocks([fileA, fileB], async () => {
      events.push("first:start");
      await releaseFirst.promise;
      events.push("first:end");
    });
    const second = withFileLocks([fileB, fileA], async () => {
      events.push("second:start", "second:end");
    });

    releaseBlocker.resolve(undefined);
    await expect.poll(() => events).toEqual(["first:start"]);

    releaseFirst.resolve(undefined);
    await Promise.all([blocker, first, second]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("allows non-overlapping lock sets to proceed independently", async () => {
    const fileA = uniquePath("independent-a");
    const fileB = uniquePath("independent-b");
    const fileC = uniquePath("independent-c");
    const fileD = uniquePath("independent-d");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();

    const first = withFileLocks([fileA, fileB], async () => {
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;

    await expect(
      withFileLocks([fileC, fileD], async () => "second"),
    ).resolves.toBe("second");

    releaseFirst.resolve(undefined);
    await expect(first).resolves.toBe("first");
  });

  it("releases every lock when the callback throws", async () => {
    const fileA = uniquePath("throw-a");
    const fileB = uniquePath("throw-b");
    const error = new Error("callback failed");

    await expect(
      withFileLocks([fileA, fileB], async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    await expect(
      withFileLocks([fileB, fileA], async () => "reacquired"),
    ).resolves.toBe("reacquired");
  });
});
