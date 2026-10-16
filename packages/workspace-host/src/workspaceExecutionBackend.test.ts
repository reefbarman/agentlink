import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createLocalWorkspaceExecutionBackend,
  WorkspaceProcessLaunchError,
  type WorkspaceProcessLaunchRequest,
} from "./workspaceExecutionBackend.js";

function request(
  overrides: Partial<WorkspaceProcessLaunchRequest> = {},
): WorkspaceProcessLaunchRequest {
  return {
    schemaVersion: 1,
    operationId: "operation-1",
    ownerId: "owner",
    sessionId: "session",
    turnId: "turn",
    policyFingerprint: "policy",
    operationDigest: "digest",
    executable: process.execPath,
    args: ["-e", ""],
    cwd: os.tmpdir(),
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    ...overrides,
  };
}

describe("createLocalWorkspaceExecutionBackend", () => {
  it("reports output, cwd, environment, and exit code after streams close", async () => {
    const cwd = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "workspace-backend-")),
    );
    try {
      const output: string[] = [];
      const handle = createLocalWorkspaceExecutionBackend().launchProcess({
        request: request({
          cwd,
          args: [
            "-e",
            'process.stdout.write(process.cwd() + ":" + process.env.FIXTURE_VALUE); process.stderr.write("err"); process.exit(3)',
          ],
          environment: { FIXTURE_VALUE: "fixture" },
        }),
        onOutput: (stream, bytes) =>
          output.push(`${stream}:${bytes.toString("utf8")}`),
      });
      await handle.started;
      expect(handle.pid).toEqual(expect.any(Number));
      await expect(handle.exited).resolves.toEqual({ exitCode: 3 });
      expect(output).toContain(`stdout:${cwd}:fixture`);
      expect(output).toContain("stderr:err");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects start with a coded launch error and still settles exit", async () => {
    const handle = createLocalWorkspaceExecutionBackend().launchProcess({
      request: request({ executable: "/nonexistent/agentlink-fixture" }),
      onOutput: () => undefined,
    });
    const error = await handle.started.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceProcessLaunchError);
    expect((error as WorkspaceProcessLaunchError).code).toBe("ENOENT");
    expect(handle.signal("SIGTERM")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "signals the process group",
    async () => {
      const handle = createLocalWorkspaceExecutionBackend().launchProcess({
        request: request({ args: ["-e", "setInterval(() => {}, 1000)"] }),
        onOutput: () => undefined,
      });
      await handle.started;
      expect(handle.signal("SIGTERM")).toBe(true);
      await expect(handle.exited).resolves.toEqual({ signal: "SIGTERM" });
      // Signalling an exited group counts as delivered.
      expect(handle.signal("SIGKILL")).toBe(true);
    },
  );
});
