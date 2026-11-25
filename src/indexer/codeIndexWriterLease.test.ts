import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CODE_INDEX_WRITER_BUSY_ERROR,
  CODE_INDEX_WRITER_FENCED_ERROR,
  CODE_INDEX_WRITER_LEASE_VERSION,
  acquireCodeIndexWriterLease,
  getCodeIndexWriterLeasePath,
  releaseCodeIndexWriterLease,
  renewCodeIndexWriterLease,
  startCodeIndexWriterHeartbeat,
  withCodeIndexWriterFence,
} from "./codeIndexWriterLease.js";
import { withRetrievalStoreLock } from "../storage/retrieval/retrievalStoreLock.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("codeIndexWriterLease", () => {
  let directory: string;
  let storeRoot: string;
  let now: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-index-writer-lease-"),
    );
    storeRoot = path.join(directory, "store");
    now = 1_000;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const options = (pid: number, alive = true) => ({
    staleMs: 100,
    now: () => now,
    pid,
    isOwnerAlive: () => alive,
  });

  const acquire = (ownerId: string, pid: number, alive = true) =>
    acquireCodeIndexWriterLease({
      storeRoot,
      workspaceScopeId: "workspace:abc123",
      ownerId,
      protocolVersion: "v4",
      options: options(pid, alive),
    });

  it("applies caller lock options to fenced operations", async () => {
    const lease = await acquire("window-1:job-1", 101);
    let finishOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });

    await expect(
      withCodeIndexWriterFence(lease, () => operation, {
        operationTimeoutMs: 50,
      }),
    ).rejects.toThrow("retrieval_store_operation_timeout");

    finishOperation();
    await operation;
  });

  describe("heartbeat", () => {
    const holdLock = async () => {
      let release!: () => void;
      let started!: () => void;
      const isStarted = new Promise<void>((resolve) => (started = resolve));
      const held = withRetrievalStoreLock(storeRoot, async () => {
        started();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await isStarted;
      return async () => {
        release();
        await held;
      };
    };
    const heartbeatAt = () =>
      JSON.parse(
        fs.readFileSync(getCodeIndexWriterLeasePath(storeRoot), "utf8"),
      ).heartbeatAt as number;

    it("renews the lease and reports real fencing", async () => {
      const lease = await acquire("window-1:job-1", 101);
      const onError = vi.fn();
      const heartbeat = startCodeIndexWriterHeartbeat(lease, {
        onError,
        intervalMs: 5,
      });
      await vi.waitFor(() => expect(heartbeatAt()).toBeGreaterThan(1_000));
      expect(onError).not.toHaveBeenCalled();
      await acquire("window-2:job-2", 202, false);
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: CODE_INDEX_WRITER_FENCED_ERROR }),
        ),
      );
      await heartbeat.stop();
    });

    it("stays quiet while this process holds the store lock and after release", async () => {
      const lease = await acquire("window-1:job-1", 101);
      const onError = vi.fn();
      const release = await holdLock();
      const heartbeat = startCodeIndexWriterHeartbeat(lease, {
        onError,
        intervalMs: 5,
        lockOptions: { maxWaitMs: 20, timeoutMs: 20 },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(heartbeatAt()).toBe(1_000);
      await heartbeat.stop();
      await release();
      await releaseCodeIndexWriterLease(lease, options(101));
      expect(onError).not.toHaveBeenCalled();
    });

    it("cancels a renewal that is waiting on another process", async () => {
      const lease = await acquire("window-1:job-1", 101);
      const onError = vi.fn();
      const lockDirectory = `${storeRoot}.lock`;
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(
        path.join(lockDirectory, "other"),
        JSON.stringify({ pid: process.ppid }),
      );
      const heartbeat = startCodeIndexWriterHeartbeat(lease, {
        onError,
        intervalMs: 5,
      });
      // Long enough for a renewal to start waiting; it waits up to 20s.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const startedAt = Date.now();
      await heartbeat.stop();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(onError).not.toHaveBeenCalled();
      fs.rmSync(lockDirectory, { recursive: true });
      await releaseCodeIndexWriterLease(lease, options(101));
    });
  });

  it("persists a monotonic first fence and renews the current owner", async () => {
    const lease = await acquire("window-1:job-1", 101);

    expect(lease).toMatchObject({
      storeRoot,
      workspaceScopeId: "workspace:abc123",
      ownerId: "window-1:job-1",
      fenceToken: "1",
      protocolVersion: "v4",
    });
    const statePath = getCodeIndexWriterLeasePath(storeRoot);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
      version: CODE_INDEX_WRITER_LEASE_VERSION,
      status: "active",
      fenceToken: "1",
      heartbeatAt: 1_000,
    });

    now = 1_050;
    await renewCodeIndexWriterLease(lease, options(101));
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
      status: "active",
      fenceToken: "1",
      heartbeatAt: 1_050,
    });
  });

  it("rejects another writer while a fresh owner is alive", async () => {
    await acquire("window-1:job-1", 101);

    await expect(acquire("window-2:job-2", 202)).rejects.toThrow(
      CODE_INDEX_WRITER_BUSY_ERROR,
    );
  });

  it("increments the persistent fence after clean release", async () => {
    const first = await acquire("window-1:job-1", 101);
    now = 1_010;
    await releaseCodeIndexWriterLease(first, options(101));

    const second = await acquire("window-2:job-2", 202);
    expect(second.fenceToken).toBe("2");
  });

  it("fences a displaced live writer after lease expiry", async () => {
    const first = await acquire("window-1:job-1", 101);
    now = 1_101;
    const second = await acquire("window-2:job-2", 202);

    expect(second.fenceToken).toBe("2");
    await expect(
      withCodeIndexWriterFence(first, async () => "stale mutation"),
    ).rejects.toThrow(CODE_INDEX_WRITER_FENCED_ERROR);
    await expect(
      withCodeIndexWriterFence(second, async () => "successor mutation"),
    ).resolves.toBe("successor mutation");
  });

  it("takes over immediately when the current owner is known dead", async () => {
    await acquire("window-1:job-1", 101);

    const second = await acquire("window-2:job-2", 202, false);
    expect(second.fenceToken).toBe("2");
  });

  it("does not let a displaced owner release its successor", async () => {
    const first = await acquire("window-1:job-1", 101);
    now = 1_101;
    const second = await acquire("window-2:job-2", 202);

    await expect(
      releaseCodeIndexWriterLease(first, options(101)),
    ).rejects.toThrow(CODE_INDEX_WRITER_FENCED_ERROR);
    await expect(
      withCodeIndexWriterFence(second, async () => "current"),
    ).resolves.toBe("current");
  });

  it("fails closed for corrupt or unsupported lease state", async () => {
    fs.mkdirSync(path.dirname(getCodeIndexWriterLeasePath(storeRoot)), {
      recursive: true,
    });
    fs.writeFileSync(
      getCodeIndexWriterLeasePath(storeRoot),
      JSON.stringify({ version: 999, status: "active" }),
      "utf8",
    );

    await expect(acquire("window-1:job-1", 101)).rejects.toThrow(
      "code_index_writer_lease_corrupt",
    );
  });
});
