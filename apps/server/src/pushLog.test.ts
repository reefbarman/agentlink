import { afterEach, describe, expect, it } from "vitest";
import { openPushLog, pushLogFile, readPushLog } from "./pushLog.js";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-log-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "push");
}

describe("push log", () => {
  it("records counts per notification, never the message or device", async () => {
    const directory = await tempDir();
    let at = 1_000;
    const log = await openPushLog({ directory, now: () => at });
    await log.record([
      { deviceId: "phone-secret-id", outcome: "sent", status: 201 },
      { deviceId: "laptop", outcome: "failed", status: 500 },
    ]);
    at = 2_000;
    await log.record([]);
    await log.flush();
    const file = pushLogFile(directory);
    expect(await readPushLog(file)).toEqual([
      { at: 1_000, sent: 1, failed: 1, gone: 0 },
      { at: 2_000, sent: 0, failed: 0, gone: 0 },
    ]);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("phone-secret-id");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps the newest entries when it grows, and skips torn lines", async () => {
    const directory = await tempDir();
    let at = 0;
    const log = await openPushLog({
      directory,
      now: () => (at += 1),
      maxEntries: 3,
    });
    for (let index = 0; index < 7; index += 1) {
      await log.record([{ deviceId: "phone", outcome: "sent" }]);
    }
    await log.flush();
    const file = pushLogFile(directory);
    expect((await readPushLog(file)).map((entry) => entry.at)).toEqual([
      5, 6, 7,
    ]);
    await fs.appendFile(file, '{"at":8,"sent"');
    expect(await readPushLog(file)).toHaveLength(3);
    expect(await readPushLog(path.join(directory, "missing.jsonl"))).toEqual(
      [],
    );
  });
});
