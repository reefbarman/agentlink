import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCredentialsHelperEntry } from "./credentialsHelperClient.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createCredentialsHelperEntry", () => {
  it("waits for a timed-out helper to exit before rejecting", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-helper-timeout-"),
    );
    temporaryRoots.push(root);
    const helperPath = path.join(root, "slow-helper");
    await fs.writeFile(
      helperPath,
      `#!/bin/sh
trap 'sleep 0.2; exit 0' TERM
while :; do sleep 1; done
`,
      { mode: 0o755 },
    );
    const entry = createCredentialsHelperEntry({
      helperPath,
      service: "test-service",
      account: "test-account",
      label: "Test credential",
      timeoutMs: 500,
    });
    const startedAt = Date.now();
    await expect(entry.getPassword()).rejects.toThrow(
      "agentlink_credentials_helper_timeout",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
  });
});
