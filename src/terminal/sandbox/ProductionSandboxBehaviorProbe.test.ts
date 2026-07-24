import {
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  createNodeSandboxHelperTransportFactory,
} from "./NodeSandboxHelperTransport.js";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createProductionSandboxBehaviorProbe,
  createProductionSandboxRuntimeFingerprint,
} from "./ProductionSandboxBehaviorProbe.js";
import { describe, expect, it } from "vitest";

import { BaselineSandboxLaunchAuthorizer } from "./BaselineSandboxLaunchAuthorizer.js";
import { SandboxBehaviorAttestationService } from "./SandboxBehaviorAttestationService.js";
import { SandboxHelperClient } from "./SandboxHelperClient.js";
import { SandboxTerminalCoordinator } from "./SandboxTerminalCoordinator.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForProcessGroupExit(pgid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForHelperClose(
  helper: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (helper.exitCode !== null || helper.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => helper.once("close", () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("production sandbox helper did not close")),
        5_000,
      ),
    ),
  ]);
}

async function readSpawnedPid(filePath: string): Promise<number | undefined> {
  try {
    const value = Number.parseInt(await readFile(filePath, "utf8"), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "al-production-probe-"));
  const nodeExecutable = path.join(root, "node");
  const helperPath = path.join(root, SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH);
  const nodePtyRoot = path.join(
    root,
    "dist",
    "sandbox-runtime",
    "node_modules",
    "node-pty",
  );
  const nativeAsset = path.join(nodePtyRoot, "build", "Release", "pty.node");
  await Promise.all([
    mkdir(path.dirname(helperPath), { recursive: true }),
    mkdir(path.dirname(nativeAsset), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(nodeExecutable, "node-runtime", { mode: 0o755 }),
    writeFile(helperPath, "production-helper"),
    writeFile(
      path.join(nodePtyRoot, "package.json"),
      JSON.stringify({ name: "node-pty", version: "1.2.3" }),
    ),
    writeFile(nativeAsset, "native-asset"),
  ]);
  await chmod(nodeExecutable, 0o755);
  return {
    root,
    nodeExecutable,
    helperPath,
    nativeAsset,
    async fingerprint() {
      return createProductionSandboxRuntimeFingerprint({
        extensionRoot: root,
        extensionVersion: "1.2.3",
        nodeExecutable,
        platform: "darwin",
        architecture: "arm64",
      });
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("createProductionSandboxRuntimeFingerprint", () => {
  it("binds helper, native assets, runtime identity, and public metadata", async () => {
    const test = await fixture();
    try {
      const first = await test.fingerprint();
      expect(first).toMatchObject({
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        metadata: {
          extensionVersion: "1.2.3",
          profileId: "workspace-write",
          helperProtocolVersion: 3,
          backend: "seatbelt",
          platform: "darwin",
          architecture: "arm64",
        },
      });

      await writeFile(test.helperPath, "changed-production-helper");
      const helperChanged = await test.fingerprint();
      expect(helperChanged.digest).not.toBe(first.digest);

      await writeFile(test.nativeAsset, "changed-native-asset");
      const nativeChanged = await test.fingerprint();
      expect(nativeChanged.digest).not.toBe(helperChanged.digest);

      await writeFile(test.nodeExecutable, "changed-node-runtime", {
        mode: 0o755,
      });
      const runtimeChanged = await test.fingerprint();
      expect(runtimeChanged.digest).not.toBe(nativeChanged.digest);
    } finally {
      await test.dispose();
    }
  });

  it("fails closed when packaged native assets are absent", async () => {
    const test = await fixture();
    try {
      await rm(test.nativeAsset);
      await expect(test.fingerprint()).rejects.toThrow(
        "Packaged node-pty native assets are missing",
      );
    } finally {
      await test.dispose();
    }
  });

  it("rejects unsupported hosts before issuing a fingerprint", async () => {
    const test = await fixture();
    try {
      await expect(
        createProductionSandboxRuntimeFingerprint({
          extensionRoot: test.root,
          extensionVersion: "1.2.3",
          nodeExecutable: test.nodeExecutable,
          platform: "linux",
          architecture: "x64",
        }),
      ).rejects.toThrow("supports local macOS arm64/x64 only");
    } finally {
      await test.dispose();
    }
  });

  it.runIf(
    process.platform === "darwin" &&
      process.env.AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION === "1",
  )(
    "copies a canonical host-owned inline file through the production sandbox",
    async () => {
      const extensionRoot = process.cwd();
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "al-inline-production-")),
      );
      const workspace = path.join(root, "workspace");
      const inlineRoot = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "agentlink-cmd-production-")),
      );
      const inlinePath = path.join(inlineRoot, "input.txt");
      const outputPath = path.join(workspace, "output.txt");
      await mkdir(workspace);
      await writeFile(inlinePath, "sandbox inline smoke\n", { mode: 0o600 });
      const content = await readFile(inlinePath);
      const runtime = new SandboxHelperClient(
        createNodeSandboxHelperTransportFactory({
          extensionRoot,
          nodeExecutable: process.execPath,
        }),
      );
      const coordinator = new SandboxTerminalCoordinator({
        runtime,
        authorizer: new BaselineSandboxLaunchAuthorizer({
          workspaceRoots: [workspace],
          trustedRuntimeRoots: [path.dirname(process.execPath)],
        }),
        initialCwd: workspace,
      });
      try {
        const result = await coordinator.executeCommand({
          owner: undefined,
          command: `/bin/cp '${inlinePath}' '${outputPath}'`,
          cwd: workspace,
          sandboxSessionId: "production-inline-test",
          sandboxInlineFiles: [
            {
              name: "input",
              path: inlinePath,
              bytes: content.byteLength,
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          ],
        });
        expect(result).toMatchObject({ exit_code: 0, output: "" });
        await expect(readFile(outputPath, "utf8")).resolves.toBe(
          "sandbox inline smoke\n",
        );
      } finally {
        coordinator.dispose();
        await rm(root, { recursive: true, force: true });
        await rm(inlineRoot, { recursive: true, force: true });
      }
    },
    35_000,
  );

  it.runIf(
    process.platform === "darwin" &&
      process.env.AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION === "1",
  )(
    "cleans owned descendants across production helper lifecycle paths",
    async () => {
      const extensionRoot = process.cwd();
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "al-helper-lifecycle-")),
      );
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const authorizer = new BaselineSandboxLaunchAuthorizer({
        workspaceRoots: [workspace],
        trustedRuntimeRoots: [path.dirname(process.execPath)],
      });
      const lifecycleScript = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGINT\\", () => {}); process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "fs.writeFileSync(process.argv[1], String(child.pid));",
        'process.stdout.write("lifecycle-ready\\n");',
        "setInterval(() => {}, 1000);",
      ].join("");

      async function run(
        action: "interrupt" | "terminate" | "dispose" | "helper-close",
      ): Promise<void> {
        const pidFile = path.join(workspace, `${action}-${randomUUID()}.pid`);
        const helpers: ChildProcessWithoutNullStreams[] = [];
        const runtime = new SandboxHelperClient(
          createNodeSandboxHelperTransportFactory({
            extensionRoot,
            nodeExecutable: process.execPath,
            spawn: (command, args, options) => {
              const child = spawn(command, [...args], {
                ...options,
                stdio: ["pipe", "pipe", "pipe"],
              });
              helpers.push(child);
              return child;
            },
          }),
        );
        const authorized = await authorizer.authorize({
          options: {
            owner: undefined,
            command: [
              shellQuote(process.execPath),
              "-e",
              shellQuote(lifecycleScript),
              shellQuote(pidFile),
            ].join(" "),
            cwd: workspace,
            sandboxSessionId: `production-lifecycle-${action}`,
          },
          channelId: `lifecycle-${action}-${randomUUID()}`,
          commandId: `command-${randomUUID()}`,
          generation: 1,
          dimensions: { columns: 100, rows: 30 },
        });
        const command = runtime.launch(authorized.helperRequest);
        let output = "";
        const subscription = command.onEvent((event) => {
          if (event.type === "data") output += event.data;
        });
        try {
          const ready = await command.ready;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (output.includes("lifecycle-ready")) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(output).toContain("lifecycle-ready");
          const descendantPid = await readSpawnedPid(pidFile);
          expect(descendantPid).toBeDefined();

          if (action === "interrupt") {
            expect(command.interrupt()).toBe(true);
            await expect(command.completion).resolves.toMatchObject({
              exitCode: 130,
              signal: 2,
            });
          } else if (action === "terminate") {
            expect(command.terminate()).toBe(true);
            await expect(command.completion).resolves.toMatchObject({
              timedOut: false,
            });
          } else if (action === "dispose") {
            runtime.dispose();
            await expect(command.completion).rejects.toThrow("disposed");
          } else {
            expect(helpers).toHaveLength(1);
            helpers[0].kill("SIGTERM");
            await expect(command.completion).rejects.toThrow(
              "closed before command completion",
            );
          }

          expect(helpers).toHaveLength(1);
          await waitForHelperClose(helpers[0]);
          expect(await waitForProcessGroupExit(ready.pgid)).toBe(true);
          expect(await waitForProcessExit(descendantPid as number)).toBe(true);
        } finally {
          subscription.dispose();
          command.dispose();
          runtime.dispose();
          authorized.finalize?.();
          for (const helper of helpers) {
            if (helper.exitCode === null && helper.signalCode === null) {
              helper.kill("SIGKILL");
            }
          }
        }
      }

      try {
        for (const action of [
          "interrupt",
          "terminate",
          "dispose",
          "helper-close",
        ] as const) {
          await run(action);
        }

        for (let iteration = 0; iteration < 5; iteration += 1) {
          const pidFile = path.join(workspace, `startup-${iteration}.pid`);
          const helpers: ChildProcessWithoutNullStreams[] = [];
          const runtime = new SandboxHelperClient(
            createNodeSandboxHelperTransportFactory({
              extensionRoot,
              nodeExecutable: process.execPath,
              spawn: (command, args, options) => {
                const child = spawn(command, [...args], {
                  ...options,
                  stdio: ["pipe", "pipe", "pipe"],
                });
                helpers.push(child);
                return child;
              },
            }),
          );
          const authorized = await authorizer.authorize({
            options: {
              owner: undefined,
              command: [
                shellQuote(process.execPath),
                "-e",
                shellQuote(lifecycleScript),
                shellQuote(pidFile),
              ].join(" "),
              cwd: workspace,
              sandboxSessionId: "production-startup-cancel",
            },
            channelId: `startup-${randomUUID()}`,
            commandId: `command-${randomUUID()}`,
            generation: 1,
            dimensions: { columns: 100, rows: 30 },
          });
          const command = runtime.launch(authorized.helperRequest);
          command.dispose();
          await expect(command.ready).rejects.toThrow("disposed");
          await expect(command.completion).rejects.toThrow("disposed");
          expect(helpers).toHaveLength(1);
          await waitForHelperClose(helpers[0]);
          const descendantPid = await readSpawnedPid(pidFile);
          if (descendantPid !== undefined) {
            expect(await waitForProcessExit(descendantPid)).toBe(true);
          }
          runtime.dispose();
          authorized.finalize?.();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.runIf(
    process.platform === "darwin" &&
      process.env.AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION === "1",
  )(
    "attests the staged production helper and runtime behavior",
    async () => {
      const extensionRoot = process.cwd();
      const fingerprint = await createProductionSandboxRuntimeFingerprint({
        extensionRoot,
        extensionVersion: "integration-test",
        nodeExecutable: process.execPath,
      });
      const productionProbe = createProductionSandboxBehaviorProbe({
        extensionRoot,
        nodeExecutable: process.execPath,
      });
      let probeOutput = "";
      const service = new SandboxBehaviorAttestationService({
        probe: {
          run: (request) =>
            productionProbe.run({
              ...request,
              recordOutput: (output) => {
                request.recordOutput(output);
                probeOutput +=
                  typeof output === "string"
                    ? output
                    : Buffer.from(output).toString("utf8");
              },
            }),
        },
        timeoutMs: 30_000,
      });
      try {
        const result = await service.attest(fingerprint);
        if (!result.verified) {
          throw new Error(
            `Production sandbox attestation failed: ${result.failureCode}\n${probeOutput}`,
          );
        }
        expect(result.summary).toMatchObject({
          runtimeFingerprint: fingerprint.digest,
          metadata: fingerprint.metadata,
        });
      } finally {
        service.dispose();
      }
    },
    35_000,
  );
});
