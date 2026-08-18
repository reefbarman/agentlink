import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentPluginStore,
  digestAgentPluginTree,
  emptyAgentPluginRegistry,
  type AgentPluginRegistry,
  type ProcessInstanceInspector,
} from "./AgentPluginStore.js";

const now = new Date("2026-08-14T00:00:00.000Z");

function processInspector(
  processes: Readonly<Record<number, string | undefined>> = {
    [process.pid]: "current-process",
  },
): ProcessInstanceInspector {
  return {
    async current() {
      return { pid: process.pid, processStartFingerprint: "current-process" };
    },
    async inspect(pid) {
      if (!Object.hasOwn(processes, pid)) return { status: "dead" };
      const fingerprint = processes[pid];
      return fingerprint
        ? { status: "alive", processStartFingerprint: fingerprint }
        : { status: "unverifiable", reason: "injected unverifiable owner" };
    },
  };
}

async function writeRegistry(
  root: string,
  registry: Readonly<AgentPluginRegistry>,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "registry.json"),
    `${JSON.stringify(registry)}\n`,
  );
}

async function writePackage(root: string, text = "hello"): Promise<void> {
  await fs.mkdir(path.join(root, "skills", "helper"), { recursive: true });
  await fs.writeFile(path.join(root, "plugin.json"), '{"name":"fixture"}\n');
  await fs.writeFile(path.join(root, "skills", "helper", "SKILL.md"), text);
}

describe("AgentPluginStore", () => {
  let directory: string;
  let root: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugin-store-"));
    root = path.join(directory, ".agentlink", "plugins");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("serializes mutations and rejects a stale expected revision", async () => {
    const left = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
      now: () => now,
    });
    const right = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
      now: () => now,
    });

    const initial = await left.readRegistry();
    const first = await left.mutateRegistry({
      expectedRevision: initial.revision,
      apply: (registry) => ({
        registry: { ...registry, purgeRequestedAt: now.toISOString() },
        result: "left",
      }),
    });

    await expect(
      right.mutateRegistry({
        expectedRevision: initial.revision,
        apply: (registry) => ({ registry, result: "right" }),
      }),
    ).rejects.toMatchObject({
      code: "registry_revision_conflict",
    });
    expect((await right.checkForUpdates()).revision).toBe(
      first.registry.revision,
    );
  });

  it("never steals a matching live lock owner", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "registry.lock"),
      `${JSON.stringify({
        token: "live-token",
        pid: 4123,
        processStartFingerprint: "live-start",
        createdAt: now.toISOString(),
      })}\n`,
    );
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector({
        [process.pid]: "current-process",
        4123: "live-start",
      }),
      lockWaitMs: 10,
      lockRetryMs: 1,
    });

    await expect(
      store.mutateRegistry({
        expectedRevision: 0,
        apply: (registry) => ({ registry, result: undefined }),
      }),
    ).rejects.toMatchObject({
      code: "registry_lock_busy",
    });
    await expect(fs.readFile(store.lockPath, "utf8")).resolves.toContain(
      "live-token",
    );
  });

  it("reclaims the same PID only when its start fingerprint differs", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "registry.lock"),
      `${JSON.stringify({
        token: "stale-token",
        pid: 4123,
        processStartFingerprint: "old-start",
        createdAt: now.toISOString(),
      })}\n`,
    );
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector({
        [process.pid]: "current-process",
        4123: "new-start",
      }),
      now: () => now,
    });

    const result = await store.mutateRegistry({
      expectedRevision: 0,
      apply: (registry) => ({ registry, result: "committed" }),
    });

    expect(result.result).toBe("committed");
    await expect(fs.stat(store.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed for malformed and unsupported registries", async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "registry.json"), '{"revision":1,}\n');
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
    });
    await expect(store.readRegistry()).rejects.toMatchObject({
      code: "registry_corrupt",
    });

    await writeRegistry(root, {
      ...emptyAgentPluginRegistry(),
      schemaVersion: 2 as 1,
    });
    await expect(store.readRegistry()).rejects.toMatchObject({
      code: "registry_schema_unsupported",
    });
  });

  it("rejects drive-relative Git provenance and retains SSH transport users", async () => {
    const digest = "a".repeat(64);
    const install = {
      installInstanceId: "git-plugin",
      scope: { kind: "global" as const },
      manifestName: "git-plugin",
      manifestSchema:
        "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      currentDigest: digest,
      source: {
        kind: "git" as const,
        remote: "C:foo",
        commit: "b".repeat(40),
      },
      enabled: false,
      installedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      policy: {},
    };
    await writeRegistry(root, {
      ...emptyAgentPluginRegistry(),
      revision: 1,
      installs: { "git-plugin": install },
    });
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
    });

    await expect(store.readRegistry()).rejects.toMatchObject({
      code: "registry_corrupt",
    });

    await writeRegistry(root, {
      ...emptyAgentPluginRegistry(),
      revision: 1,
      installs: {
        "git-plugin": {
          ...install,
          source: {
            ...install.source,
            remote: "ssh://git@git.example.net/team/plugin.git",
          },
        },
      },
    });
    await expect(store.readRegistry()).resolves.toMatchObject({
      installs: {
        "git-plugin": {
          source: {
            kind: "git",
            remote: "ssh://git@git.example.net/team/plugin.git",
          },
        },
      },
    });
  });

  it("registers exact live-host markers and defers purge while a host is live", async () => {
    const referencedDigest = "a".repeat(64);
    const unreferencedDigest = "b".repeat(64);
    const referencedPath = path.join(
      root,
      "packages",
      "fixture-install",
      referencedDigest,
    );
    const unreferencedPath = path.join(
      root,
      "packages",
      "fixture-install",
      unreferencedDigest,
    );
    await fs.mkdir(referencedPath, { recursive: true });
    await fs.mkdir(unreferencedPath, { recursive: true });
    await writeRegistry(root, {
      ...emptyAgentPluginRegistry(),
      revision: 1,
      purgeRequestedAt: now.toISOString(),
      liveHosts: {
        other: {
          token: "other",
          pid: 4123,
          processStartFingerprint: "other-live",
          createdAt: now.toISOString(),
        },
      },
    });
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector({
        [process.pid]: "current-process",
        4123: "other-live",
      }),
      now: () => now,
      randomToken: () => "current-marker",
    });

    const initialized = await store.initializeHost();

    expect(initialized.purgeRequestedAt).toBe(now.toISOString());
    expect(initialized.liveHosts).toMatchObject({
      other: { processStartFingerprint: "other-live" },
      "current-marker": { processStartFingerprint: "current-process" },
    });
    await expect(fs.stat(unreferencedPath)).resolves.toBeDefined();
    await store.dispose();
    const afterDispose = await store.readRegistry();
    expect(afterDispose.liveHosts["current-marker"]).toBeUndefined();
    expect(afterDispose.liveHosts.other).toBeDefined();
  });

  it("falls back to explicit refreshes when the registry watcher fails", async () => {
    let closeCalls = 0;
    const watcher = Object.assign(new EventEmitter(), {
      close: () => {
        closeCalls += 1;
      },
    });
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
      now: () => now,
      randomToken: () => "watcher-host",
      watchRegistryDirectory: () => watcher,
    });
    await store.initializeHost();

    expect(watcher.listenerCount("error")).toBe(1);
    watcher.emit("error", new Error("EMFILE"));
    expect(closeCalls).toBe(1);
    await expect(store.checkForUpdates()).resolves.toMatchObject({
      liveHosts: { "watcher-host": { token: "watcher-host" } },
    });
    await store.dispose();
    expect(closeCalls).toBe(1);
  });

  it("purges only unreferenced generations before registering the first live host", async () => {
    const referencedDigest = "a".repeat(64);
    const unreferencedDigest = "b".repeat(64);
    const referencedPath = path.join(
      root,
      "packages",
      "fixture-install",
      referencedDigest,
    );
    const unreferencedPath = path.join(
      root,
      "packages",
      "fixture-install",
      unreferencedDigest,
    );
    await fs.mkdir(referencedPath, { recursive: true });
    await fs.mkdir(unreferencedPath, { recursive: true });
    await writeRegistry(root, {
      ...emptyAgentPluginRegistry(),
      revision: 1,
      purgeRequestedAt: now.toISOString(),
      installs: {
        "fixture-install": {
          installInstanceId: "fixture-install",
          scope: { kind: "global" },
          manifestName: "fixture",
          manifestSchema: "schema",
          currentDigest: referencedDigest,
          source: {
            kind: "local-directory",
            label: "fixture",
            sourceDigest: referencedDigest,
          },
          enabled: false,
          installedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          policy: {},
        },
      },
    });
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
      now: () => now,
      randomToken: () => "first-host",
    });

    const initialized = await store.initializeHost();

    expect(initialized.purgeRequestedAt).toBeUndefined();
    await expect(fs.stat(referencedPath)).resolves.toBeDefined();
    await expect(fs.stat(unreferencedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await store.dispose();
  });

  it("copies and verifies staged packages when the store is on another filesystem", async () => {
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
      randomToken: () => "cross-device-transfer",
      renameStagedPackage: async () => {
        throw Object.assign(new Error("cross-device link not permitted"), {
          code: "EXDEV",
        });
      },
    });
    const staged = path.join(directory, "staged-cross-device");
    await writePackage(staged);
    const digest = await digestAgentPluginTree(staged);

    const committed = await store.commitPackage({
      installInstanceId: "cross-device-install",
      stagedDirectory: staged,
      expectedDigest: digest,
    });

    expect(committed).toMatchObject({ digest, reused: false });
    await expect(digestAgentPluginTree(committed.packagePath)).resolves.toBe(
      digest,
    );
    await expect(fs.stat(staged)).resolves.toBeDefined();
    await expect(
      fs.stat(`${committed.packagePath}.incoming-cross-device-transfer`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses verified immutable generations and rejects corrupt existing bytes", async () => {
    const store = new AgentPluginStore({
      rootPath: root,
      processInspector: processInspector(),
    });
    const staged = path.join(directory, "staged-one");
    await writePackage(staged);
    const digest = await digestAgentPluginTree(staged);
    const committed = await store.commitPackage({
      installInstanceId: "fixture-install",
      stagedDirectory: staged,
      expectedDigest: digest,
    });
    expect(committed.reused).toBe(false);

    const duplicate = path.join(directory, "staged-two");
    await writePackage(duplicate);
    await expect(
      store.commitPackage({
        installInstanceId: "fixture-install",
        stagedDirectory: duplicate,
        expectedDigest: digest,
      }),
    ).resolves.toMatchObject({ reused: true, digest });

    await fs.writeFile(
      path.join(committed.packagePath, "plugin.json"),
      "corrupt",
    );
    const third = path.join(directory, "staged-three");
    await writePackage(third);
    await expect(
      store.commitPackage({
        installInstanceId: "fixture-install",
        stagedDirectory: third,
        expectedDigest: digest,
      }),
    ).rejects.toMatchObject({
      code: "package_corrupt",
    });
  });
});
