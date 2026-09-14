import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  type WorkspaceCommandLaunch,
  WorkspaceCommandSupervisor,
} from "./commandSupervisor.js";

async function fixture(options: { maxRetainedOutputBytes?: number } = {}) {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-command-supervisor-"),
  );
  const supervisor = await WorkspaceCommandSupervisor.create({
    stateDirectory: path.join(parent, "state"),
    ownerId: "owner-a",
    terminationGraceMs: 50,
    ...options,
  });
  let command = 0;
  const launch = (
    script: string,
    overrides: Partial<WorkspaceCommandLaunch> = {},
  ): WorkspaceCommandLaunch => ({
    schemaVersion: 1,
    commandId: `command-${++command}`,
    ownerId: "owner-a",
    sessionId: "session-a",
    turnId: "turn-a",
    command: script,
    executable: process.execPath,
    args: ["-e", script],
    cwd: parent,
    environmentKeys: ["PATH"],
    environmentDigest: "environment-digest",
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    mode: "foreground",
    timeoutMs: 5_000,
    concurrentEditingAcknowledged: false,
    policyFingerprint: "policy-a",
    operationDigest: `digest-${command}`,
    ...overrides,
  });
  return { parent, supervisor, launch };
}

describe("WorkspaceCommandSupervisor", () => {
  it("retains interleaved output and truthful successful and nonzero exits", async () => {
    const test = await fixture();
    try {
      const success = await test.supervisor.launchForeground(
        test.launch(
          'process.stdout.write("out\\n"); process.stderr.write("err\\n")',
        ),
      );
      expect(success).toMatchObject({ state: "completed", exitCode: 0 });
      const observed = test.supervisor.observe(success.commandId, {
        ownerId: "owner-a",
        sessionId: "session-a",
      });
      expect(observed.output.map((chunk) => chunk.text).join("")).toContain(
        "out\n",
      );
      expect(observed.output.map((chunk) => chunk.text).join("")).toContain(
        "err\n",
      );

      const failed = await test.supervisor.launchForeground(
        test.launch("process.exit(7)"),
      );
      expect(failed).toMatchObject({ state: "failed", exitCode: 7 });
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("bounds retained output and exposes truncation offsets", async () => {
    const test = await fixture({ maxRetainedOutputBytes: 5 });
    try {
      const record = await test.supervisor.launchForeground(
        test.launch('process.stdout.write("abcdefghij")'),
      );
      const observed = test.supervisor.observe(
        record.commandId,
        { ownerId: "owner-a" },
        { offset: 0, limitBytes: 100 },
      );
      expect(observed).toMatchObject({
        truncatedBeforeOffset: true,
        requestedOffset: 0,
        nextOffset: 10,
        record: { outputDroppedBytes: 5, outputStartOffset: 5 },
      });
      expect(observed.output.map((chunk) => chunk.text).join("")).toBe("fghij");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("does not split retained UTF-8 output at observation boundaries", async () => {
    const test = await fixture();
    try {
      const record = await test.supervisor.launchForeground(
        test.launch('process.stdout.write("A€B")'),
      );
      const first = test.supervisor.observe(
        record.commandId,
        { ownerId: "owner-a" },
        { offset: 0, limitBytes: 2 },
      );
      expect(first.output.map((chunk) => chunk.text).join("")).toBe("A");
      expect(first.nextOffset).toBe(1);
      const second = test.supervisor.observe(
        record.commandId,
        { ownerId: "owner-a" },
        { offset: first.nextOffset, limitBytes: 4 },
      );
      expect(second.output.map((chunk) => chunk.text).join("")).toBe("€B");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("does not withhold ordinary live background output behind secret redaction", async () => {
    const test = await fixture();
    try {
      const launched = await test.supervisor.launchBackground(
        test.launch(
          'process.stdout.write("listening on 3000\\n"); setInterval(() => {}, 100)',
          {
            mode: "background",
            environmentKeys: ["API_TOKEN"],
            environment: { API_TOKEN: "a-very-long-secret-token-value" },
            concurrentEditingAcknowledged: true,
          },
        ),
      );
      await vi.waitFor(() =>
        expect(
          test.supervisor
            .observe(launched.commandId, { ownerId: "owner-a" })
            .output.map((chunk) => chunk.text)
            .join(""),
        ).toBe("listening on 3000\n"),
      );
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("does not redact short non-secret environment values", async () => {
    const test = await fixture();
    try {
      const record = await test.supervisor.launchForeground(
        test.launch('process.stdout.write("false safe output")', {
          environmentKeys: ["NPM_TOKEN"],
          environment: { NPM_TOKEN: "false" },
        }),
      );
      expect(
        test.supervisor
          .observe(record.commandId, { ownerId: "owner-a" })
          .output.map((chunk) => chunk.text)
          .join(""),
      ).toBe("false safe output");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("observes and stops a host-owned background process", async () => {
    const test = await fixture();
    try {
      const launched = await test.supervisor.launchBackground(
        test.launch(
          'process.stdout.write("ready\\n"); setInterval(() => {}, 100)',
          {
            mode: "background",
            concurrentEditingAcknowledged: true,
          },
        ),
      );
      expect(launched.state).toBe("running");
      expect(test.supervisor.list({ ownerId: "owner-a" })).toContainEqual(
        expect.objectContaining({
          commandId: launched.commandId,
          state: "running",
        }),
      );
      await vi.waitFor(() =>
        expect(
          test.supervisor
            .observe(launched.commandId, { ownerId: "owner-a" })
            .output.map((chunk) => chunk.text)
            .join(""),
        ).toContain("ready"),
      );
      await expect(
        test.supervisor.stop(launched.commandId, { ownerId: "owner-a" }),
      ).resolves.toMatchObject({ state: "cancelled" });
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("reports timeout and abort cancellation", async () => {
    const test = await fixture();
    try {
      await expect(
        test.supervisor.launchForeground(
          test.launch("setInterval(() => {}, 100)", { timeoutMs: 20 }),
        ),
      ).resolves.toMatchObject({ state: "timed_out" });

      const controller = new AbortController();
      const running = test.supervisor.launchForeground(
        test.launch("setInterval(() => {}, 100)"),
        controller.signal,
      );
      setTimeout(() => controller.abort(), 20);
      await expect(running).resolves.toMatchObject({ state: "cancelled" });
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("marks persisted running records interrupted without reconnecting", async () => {
    const test = await fixture();
    const launched = await test.supervisor.launchBackground(
      test.launch("setInterval(() => {}, 100)", {
        mode: "background",
        concurrentEditingAcknowledged: true,
      }),
    );
    const statePath = path.join(test.parent, "state", "commands.json");
    const copiedRoot = path.join(test.parent, "copied");
    await fs.mkdir(copiedRoot);
    await fs.copyFile(statePath, path.join(copiedRoot, "commands.json"));
    const reopened = await WorkspaceCommandSupervisor.create({
      stateDirectory: copiedRoot,
      ownerId: "owner-a",
    });
    try {
      expect(reopened.list({ ownerId: "owner-a" })).toContainEqual(
        expect.objectContaining({
          commandId: launched.commandId,
          state: "interrupted",
        }),
      );
    } finally {
      await reopened.close();
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("fails closed for cross-owner and cross-session observation", async () => {
    const test = await fixture();
    try {
      const record = await test.supervisor.launchForeground(
        test.launch('process.stdout.write("ok")'),
      );
      expect(() =>
        test.supervisor.observe(record.commandId, { ownerId: "owner-b" }),
      ).toThrow("command_not_owned");
      expect(() =>
        test.supervisor.observe(record.commandId, {
          ownerId: "owner-a",
          sessionId: "session-b",
        }),
      ).toThrow("command_not_owned");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("fully redacts self-overlapping credential values", async () => {
    const test = await fixture();
    try {
      const record = await test.supervisor.launchForeground(
        test.launch("process.stdout.write(process.env.API_TOKEN)", {
          environmentKeys: ["API_TOKEN"],
          environment: { API_TOKEN: "aaaaaaaaaaaa" },
        }),
      );
      expect(
        test.supervisor
          .observe(record.commandId, { ownerId: "owner-a" })
          .output.map((chunk) => chunk.text)
          .join(""),
      ).toBe("************");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("redacts credential environment values from retained output and durable state", async () => {
    const test = await fixture();
    try {
      const record = await test.supervisor.launchForeground(
        test.launch(
          "process.stdout.write(process.env.API_TOKEN.slice(0, 4)); setTimeout(() => process.stdout.write(process.env.API_TOKEN.slice(4)), 10)",
          {
            environmentKeys: ["API_TOKEN"],
            environment: { API_TOKEN: "split-secret-value" },
          },
        ),
      );
      const output = test.supervisor
        .observe(record.commandId, { ownerId: "owner-a" })
        .output.map((chunk) => chunk.text)
        .join("");
      expect(output).not.toContain("split-secret-value");
      expect(output).toBe("******************");
      const state = await fs.readFile(
        path.join(test.parent, "state", "commands.json"),
        "utf8",
      );
      expect(state).not.toContain("split-secret-value");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("refuses an unacknowledged background launch and never persists env values", async () => {
    const test = await fixture();
    try {
      await expect(
        test.supervisor.launchBackground(
          test.launch("process.exit(0)", {
            mode: "background",
            environmentKeys: ["SECRET"],
            environment: { SECRET: "do-not-persist" },
          }),
        ),
      ).rejects.toThrow("background_concurrent_editing_not_acknowledged");
      const completed = await test.supervisor.launchForeground(
        test.launch("process.exit(0)", {
          environmentKeys: ["SECRET"],
          environment: { SECRET: "do-not-persist" },
        }),
      );
      expect(completed.environmentKeys).toEqual(["SECRET"]);
      const state = await fs.readFile(
        path.join(test.parent, "state", "commands.json"),
        "utf8",
      );
      expect(state).not.toContain("do-not-persist");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });
});
