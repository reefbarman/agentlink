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
  withCodeIndexWriterFence,
} from "./codeIndexWriterLease.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
