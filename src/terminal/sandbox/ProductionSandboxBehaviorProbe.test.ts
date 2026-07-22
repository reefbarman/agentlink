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
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

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
          helperProtocolVersion: 2,
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
