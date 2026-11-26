// Vitest setup file: turns fsync into a no-op inside the test process.
//
// Production code fsyncs each atomic write so saved state survives power loss.
// On macOS, Node's fsync is F_FULLFSYNC: it waits for the drive to flush and
// queues behind every other flush on the machine, so tests that save state
// spend most of their time waiting for the disk, and parallel test files slow
// each other down. No test can observe power-loss durability, so skipping the
// flush loses no coverage. Writes, renames and their ordering are unchanged.
//
// Child processes that tests start still fsync for real.
// AGENTLINK_TEST_REAL_FSYNC=1 restores the real calls.

import { beforeAll } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

if (process.env.AGENTLINK_TEST_REAL_FSYNC !== "1") {
  const flushLater = (
    _fd: number,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => {
    queueMicrotask(() => callback(null));
  };
  Object.assign(fs, {
    fsyncSync: () => undefined,
    fdatasyncSync: () => undefined,
    fsync: flushLater,
    fdatasync: flushLater,
  });
  syncBuiltinESMExports();

  // FileHandle is not exported, so reach its prototype through an open handle.
  // This runs before each test file's own hooks and tests.
  beforeAll(async () => {
    const handle = await fs.promises.open(process.execPath, "r");
    try {
      Object.assign(Object.getPrototypeOf(handle), {
        sync: async () => undefined,
        datasync: async () => undefined,
      });
    } finally {
      await handle.close();
    }
  });
}
