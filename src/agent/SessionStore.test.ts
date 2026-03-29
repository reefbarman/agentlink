import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "./types.js";
import { SessionStore } from "./SessionStore.js";

describe("SessionStore", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("excludes background sessions from list() but keeps them addressable by id", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));
    const store = new SessionStore(tmpDir);

    const base = {
      mode: "code",
      model: "claude-sonnet-4-6",
      title: "Test Session",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      lastInputTokens: 0,
      lastCacheReadTokens: 0,
      getAllMessages: () => [] as AgentMessage[],
    };

    store.save({
      ...base,
      id: "foreground-1",
      createdAt: 1,
      lastActiveAt: 2,
      background: false,
    });

    store.save({
      ...base,
      id: "background-1",
      createdAt: 3,
      lastActiveAt: 4,
      background: true,
    });

    const listed = store.list();
    expect(listed.map((s) => s.id)).toEqual(["foreground-1"]);
    expect(store.get("background-1")?.background).toBe(true);

    // Verify filtering behavior after reloading from persisted index.
    const reloadedStore = new SessionStore(tmpDir);
    expect(reloadedStore.list().map((s) => s.id)).toEqual(["foreground-1"]);
    expect(reloadedStore.get("background-1")?.background).toBe(true);
  });

  it("migrates persisted titles to strip attachment/file content artifacts", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-session-store-"));

    const historyDir = path.join(tmpDir, ".agentlink", "history");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, "sessions.json"),
      JSON.stringify(
        [
          {
            schemaVersion: 1,
            id: "legacy-1",
            mode: "code",
            model: "claude-sonnet-4-6",
            title: `<file path="src/secret.ts">\n\`\`\`ts\nconst token = "abc123";\n\`\`\`\n</file>\n\nFix auth bug\n[Attached: README.md]`,
            messageCount: 1,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            createdAt: 1,
            lastActiveAt: 2,
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const store = new SessionStore(tmpDir);
    expect(store.list().map((s) => s.title)).toEqual(["Fix auth bug"]);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(historyDir, "sessions.json"), "utf-8"),
    ) as Array<{ title: string }>;
    expect(persisted[0]?.title).toBe("Fix auth bug");
  });
});
