import { afterEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import { openSessionApprovalModes } from "./SessionApprovalModes.js";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempFile() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "approval-modes-"));
  cleanup.push(() =>
    fs.rm(parent, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  return path.join(parent, "settings", "approval-modes.json");
}

describe("session approval modes", () => {
  it("defaults to autonomous and persists only sessions that ask", async () => {
    const file = await tempFile();
    const modes = await openSessionApprovalModes({ file });
    expect(modes.get("home", "a")).toBe("autonomous");
    await modes.set("home", "a", "ask");
    await modes.set("home", "b", "ask");
    await modes.set("home", "b", "autonomous");
    expect(modes.get("home", "a")).toBe("ask");
    expect(modes.get("other", "a")).toBe("autonomous");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      schemaVersion: 1,
      ask: ["home/a"],
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const reopened = await openSessionApprovalModes({ file });
    expect(reopened.get("home", "a")).toBe("ask");
    expect(reopened.get("home", "b")).toBe("autonomous");
  });

  it("marks asking sessions as reviewers in memory only", async () => {
    const file = await tempFile();
    const modes = await openSessionApprovalModes({ file });
    expect(() => modes.markReviewer("home", "a")).toThrow(
      "reviewer_session_must_ask",
    );
    await modes.set("home", "a", "ask");
    modes.markReviewer("home", "a");
    expect(modes.isReviewer("home", "a")).toBe(true);
    expect(modes.isReviewer("other", "a")).toBe(false);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      schemaVersion: 1,
      ask: ["home/a"],
    });
    // After a restart the session still asks, but is no longer a reviewer.
    const reopened = await openSessionApprovalModes({ file });
    expect(reopened.get("home", "a")).toBe("ask");
    expect(reopened.isReviewer("home", "a")).toBe(false);
    // Becoming autonomous clears the mark.
    await modes.set("home", "a", "autonomous");
    expect(modes.isReviewer("home", "a")).toBe(false);
  });

  it("keeps asking when a write fails, and refuses an unreadable file", async () => {
    const file = await tempFile();
    const modes = await openSessionApprovalModes({ file });
    // A directory where the file should be makes every write fail.
    await fs.mkdir(file, { recursive: true });
    await expect(modes.set("home", "a", "ask")).rejects.toThrow();
    expect(modes.get("home", "a")).toBe("ask");
    // A retry writes again rather than reporting an unsaved mode as saved.
    await expect(modes.set("home", "a", "ask")).rejects.toThrow();
    await expect(modes.set("home", "a", "autonomous")).rejects.toThrow();
    expect(modes.get("home", "a")).toBe("ask");
    await fs.rm(file, { recursive: true });
    await modes.set("home", "a", "ask");
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      schemaVersion: 1,
      ask: ["home/a"],
    });
    await fs.rm(file);

    await fs.writeFile(file, "{not json");
    await expect(openSessionApprovalModes({ file })).rejects.toThrow(
      "Session approval modes are unreadable",
    );
  });
});
