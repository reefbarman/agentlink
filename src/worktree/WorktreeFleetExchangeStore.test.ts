import { mkdtemp } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { WorktreeFleetExchangeStore } from "./WorktreeFleetExchangeStore.js";

describe("WorktreeFleetExchangeStore", () => {
  it("round-trips supervision, usage, result, and cancellation state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "worktree-exchange-"));
    let now = 10;
    const store = new WorktreeFleetExchangeStore(root, () => now);
    const created = await store.create({
      id: "exchange-1",
      parentFleetSessionId: "parent-1",
      sourceWorkspacePath: "/repo",
    });
    expect(created.status).toBe("launching");
    now = 20;
    await store.update(created.id, {
      status: "completed",
      childSessionId: "child-1",
      resultText: "done",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(await store.read(created.id)).toEqual(
      expect.objectContaining({
        status: "completed",
        childSessionId: "child-1",
        resultText: "done",
        updatedAt: 20,
      }),
    );
    now = 30;
    expect(await store.requestCancel(created.id)).toEqual(
      expect.objectContaining({ cancelRequestedAt: 30 }),
    );
  });
});
