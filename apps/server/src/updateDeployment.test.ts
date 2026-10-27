import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantUpdateOperation,
  AssistantUpdatePhase,
} from "../../../src/shared/assistantUpdates.js";
import {
  readInstalledDeploymentState,
  runDeploymentRollback,
  runDeploymentUpdate,
  type DeploymentExecutor,
} from "./updateDeployment.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
  for (const dir of cleanup.splice(0))
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const commit = "a".repeat(40);
const updaterImage = `ghcr.io/reefbarman/agentlink-updater@sha256:${"b".repeat(64)}`;
function manifest(version: string) {
  return (
    `RELEASE_VERSION=${version}\nRELEASE_COMMIT=${commit}\n` +
    ["assistant", "command-worker", "publisher", "backup", "updater"]
      .map(
        (target) =>
          `${target.replaceAll("-", "_").toUpperCase()}_IMAGE=ghcr.io/reefbarman/agentlink-${target}@sha256:${"b".repeat(64)}\n`,
      )
      .join("")
  );
}
function metadata(
  version: string,
  assets: Record<string, string>,
  lifecycle = false,
) {
  return JSON.stringify({
    schemaVersion: 1,
    updaterProtocol: 1,
    ...(lifecycle ? { lifecycleProtocol: 1 } : {}),
    version,
    commit,
    assets: Object.fromEntries(
      Object.entries(assets).map(([name, content]) => [name, digest(content)]),
    ),
  });
}
const OPTIONAL_ENV =
  "PRIVATE=do-not-touch\nCOMPOSE_FILE=compose.yaml:compose.runners.yaml:compose.editor.yaml:compose.browser.yaml\n";
async function fixture(standalone = false, optional = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-worker-"));
  cleanup.push(root);
  const deployDirectory = path.join(root, "deploy");
  const updaterDirectory = path.join(root, "updater");
  await fs.mkdir(deployDirectory);
  await fs.mkdir(updaterDirectory);
  const oldAssets: Record<string, string> = {
    "install.sh": "old installer\n",
    "upgrade.sh": "trusted installed upgrade\n",
    "compose.yaml":
      "services: {assistant: {image: 'agentlink-assistant:local'}}\n",
    "server.example.json": '{"schemaVersion":1}\n',
    "compose.update-client.yaml":
      "services: {assistant: {networks: [updater-control]}}\n",
  };
  if (optional) {
    // Installed by `install.sh enable editor` / `enable browser`.
    oldAssets["compose.runners.yaml"] = "services: {runner-manager: {}}\n";
    oldAssets["compose.editor.yaml"] = "services: {editor-proxy: {}}\n";
    oldAssets["compose.browser.yaml"] = "services: {browser-pool: {}}\n";
  }
  if (standalone)
    oldAssets["compose.updater.yaml"] =
      "services: {updater: {image: '${UPDATER_IMAGE}'}}\n";
  for (const [name, content] of Object.entries(oldAssets)) {
    if (name !== "compose.updater.yaml")
      await fs.writeFile(path.join(deployDirectory, name), content, {
        mode: 0o600,
      });
  }
  const oldUpdaterEnv = `# keep this byte-for-byte\r\nUPDATER_IMAGE=ghcr.io/reefbarman/agentlink-updater@sha256:${"c".repeat(64)}\r\nTOKEN_FILE=/run/secrets/updater\r\n`;
  if (standalone) {
    await fs.writeFile(
      path.join(updaterDirectory, "compose.yaml"),
      oldAssets["compose.updater.yaml"]!,
      { mode: 0o640 },
    );
    await fs.writeFile(path.join(updaterDirectory, ".env"), oldUpdaterEnv, {
      mode: 0o600,
    });
  }
  await fs.writeFile(
    path.join(deployDirectory, "assistant-deployment.json"),
    metadata("1.2.3", oldAssets),
  );
  await fs.writeFile(
    path.join(deployDirectory, "release.env"),
    manifest("1.2.3"),
  );
  await fs.writeFile(
    path.join(deployDirectory, "server.json"),
    '{"schemaVersion":1,"private":"do not touch"}\n',
  );
  await fs.writeFile(
    path.join(deployDirectory, ".env"),
    optional ? OPTIONAL_ENV : "PRIVATE=do-not-touch\n",
  );
  const nextAssets: Record<string, string> = {
    ...oldAssets,
    "upgrade.sh": "downloaded script must NOT execute this time\n",
    "install.sh": "new installer\n",
  };
  if (standalone) nextAssets["compose.updater.yaml"] += "# next template\n";
  const downloads: Record<string, string> = {
    ...nextAssets,
    // The next release honours the lifecycle guard; the installed one predates it.
    "assistant-deployment.json": metadata("1.3.0", nextAssets, true),
    "assistant-release.env": manifest("1.3.0"),
  };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(url).toMatch(
      /^https:\/\/github\.com\/reefbarman\/agentlink\/releases\/download\/assistant-v1\.3\.0\/[a-z.-]+$/,
    );
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const name = url.slice(url.lastIndexOf("/") + 1);
    return new Response(downloads[name] ?? "missing", {
      status: downloads[name] ? 200 : 404,
    });
  });
  const operation: AssistantUpdateOperation = {
    id: "fixed-id",
    kind: "update",
    fromVersion: "1.2.3",
    targetVersion: "1.3.0",
    phase: "queued",
    startedAt: 1,
    updatedAt: 1,
  };
  const phases: AssistantUpdatePhase[] = [];
  const onProgress = vi.fn(async (phase: AssistantUpdatePhase) => {
    phases.push(phase);
  });
  const run = vi.fn<DeploymentExecutor>(async (executable, args, options) => {
    if (executable === "bash") {
      expect(await fs.readFile(args[0]!, "utf8")).toBe(oldAssets["upgrade.sh"]);
      if (!args.includes("--validate-release")) {
        for (const phase of [
          "pulling",
          "draining",
          "backing_up",
          "installing",
          "checking_health",
        ]) {
          options.onLine?.(`AGENTLINK_UPDATE_PHASE=${phase}`);
        }
        options.onLine?.("secret raw log that must never be published");
      }
    }
  });
  return {
    deployDirectory,
    updaterDirectory,
    request,
    run,
    operation,
    onProgress,
    root,
    oldAssets,
    nextAssets,
    downloads,
    phases,
    oldUpdaterEnv,
  };
}

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    kill: vi.fn(() => true),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

describe("deployment executor", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s to the active process group and awaits recovery without restarting the updater",
    async (signal) => {
      const fx = await fixture(true);
      const child = fakeChild();
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const listeners = {
        SIGTERM: process.listeners("SIGTERM"),
        SIGINT: process.listeners("SIGINT"),
      };
      vi.mocked(spawn).mockImplementation((executable, args) => {
        const active =
          executable === "bash" && !args?.includes("--validate-release");
        const spawned = active ? child : fakeChild();
        if (!active) queueMicrotask(() => spawned.emit("close", 0));
        return spawned as unknown as ReturnType<typeof spawn>;
      });
      let settled = false;
      const result = runDeploymentUpdate({ ...fx, run: undefined });
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = expect(result).rejects.toThrow("deployment_terminated");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
      const handler = process
        .listeners(signal)
        .find((listener) => !listeners[signal].includes(listener));
      expect(handler).toBeDefined();
      // Invoke only the worker's handler, not the test runner's signal handlers.
      handler!(signal);
      expect(kill).toHaveBeenCalledWith(-child.pid, signal);
      await Promise.resolve();
      expect(settled).toBe(false);
      child.emit("close", 0);
      await rejected;
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(fx.phases).not.toContain("reconnecting");
      expect(
        await fs.readFile(path.join(fx.updaterDirectory, ".env"), "utf8"),
      ).toBe(fx.oldUpdaterEnv);
      expect(process.listeners("SIGTERM")).toEqual(listeners.SIGTERM);
      expect(process.listeners("SIGINT")).toEqual(listeners.SIGINT);
    },
  );

  it("retains the configured Unix Docker socket without passing arbitrary environment variables", async () => {
    const fx = await fixture();
    vi.stubEnv("DOCKER_HOST", "unix:///run/agentlink/docker.sock");
    vi.stubEnv("PRIVATE_TOKEN", "not-for-child");
    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const listeners = [
      process.listeners("SIGTERM"),
      process.listeners("SIGINT"),
    ];
    await runDeploymentUpdate({ ...fx, run: undefined });
    for (const [, , options] of vi.mocked(spawn).mock.calls) {
      expect(options?.env).toEqual({
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        LANG: "C.UTF-8",
        DOCKER_HOST: "unix:///run/agentlink/docker.sock",
      });
    }
    expect(process.listeners("SIGTERM")).toEqual(listeners[0]);
    expect(process.listeners("SIGINT")).toEqual(listeners[1]);
  });

  it("preserves timeout TERM and bounded recovery KILL", async () => {
    const fx = await fixture();
    const child = fakeChild();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    vi.useFakeTimers();
    const result = runDeploymentUpdate({ ...fx, run: undefined });
    const rejected = expect(result).rejects.toThrow("deployment_update_failed");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(kill).toHaveBeenLastCalledWith(-child.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(kill).toHaveBeenLastCalledWith(-child.pid, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await rejected;
  });

  it("unregisters signal handlers when spawning fails", async () => {
    const fx = await fixture();
    const listeners = [
      process.listeners("SIGTERM"),
      process.listeners("SIGINT"),
    ];
    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await expect(
      runDeploymentUpdate({ ...fx, run: undefined }),
    ).rejects.toThrow("deployment_update_failed");
    expect(process.listeners("SIGTERM")).toEqual(listeners[0]);
    expect(process.listeners("SIGINT")).toEqual(listeners[1]);
  });
});

describe("deployment worker", () => {
  it("reports validated installed identity, while legacy and modified installs are unmanaged", async () => {
    const fx = await fixture();
    expect(await readInstalledDeploymentState(fx)).toEqual({
      managed: true,
      version: "1.2.3",
      commit,
      rollbackVersion: null,
    });
    await fs.appendFile(
      path.join(fx.deployDirectory, "compose.yaml"),
      "local edit",
    );
    expect(await readInstalledDeploymentState(fx)).toMatchObject({
      managed: false,
    });
    await fs.rm(path.join(fx.deployDirectory, "assistant-deployment.json"));
    expect(await readInstalledDeploymentState(fx)).toMatchObject({
      managed: false,
    });
  });

  it("downloads fixed official assets, executes only installed trusted script and awaits progress", async () => {
    const fx = await fixture();
    await runDeploymentUpdate(fx);
    expect(fx.request).toHaveBeenCalledTimes(
      Object.keys(fx.nextAssets).length + 2,
    );
    expect(fx.run).toHaveBeenCalledTimes(2);
    expect(fx.run.mock.calls[0]![1]).toContain("--validate-release");
    expect(fx.run.mock.calls[1]![1]).toContain("--release-assets");
    expect(fx.phases).toEqual([
      "downloading",
      "validating",
      "pulling",
      "draining",
      "backing_up",
      "installing",
      "checking_health",
      "reconnecting",
    ]);
    expect(
      (await fs.readdir(fx.deployDirectory)).filter((name) =>
        name.startsWith(".upgrade-staging."),
      ),
    ).toEqual([]);
    expect(
      await fs.readFile(path.join(fx.deployDirectory, ".env"), "utf8"),
    ).toBe("PRIVATE=do-not-touch\n");
  });

  it("changes standalone updater last after durable reconnecting, preserving env bytes, mode and owner", async () => {
    const fx = await fixture(true);
    const before = await fs.stat(path.join(fx.updaterDirectory, ".env"));
    fx.onProgress.mockImplementation(async (phase) => {
      fx.phases.push(phase);
      if (phase === "reconnecting") {
        expect(
          await fs.readFile(path.join(fx.updaterDirectory, ".env"), "utf8"),
        ).toBe(fx.oldUpdaterEnv);
        await Promise.resolve();
      }
    });
    await runDeploymentUpdate(fx);
    expect(fx.run.mock.calls.at(-1)?.[1]).toEqual([
      "compose",
      "--project-name",
      "agentlink-updater",
      "up",
      "-d",
    ]);
    expect(fx.run.mock.calls.at(-1)?.[2].cwd).toBe(fx.updaterDirectory);
    expect(
      await fs.readFile(path.join(fx.updaterDirectory, ".env"), "utf8"),
    ).toBe(
      fx.oldUpdaterEnv.replace(
        /^UPDATER_IMAGE=[^\r\n]*/m,
        `UPDATER_IMAGE=${updaterImage}`,
      ),
    );
    const after = await fs.stat(path.join(fx.updaterDirectory, ".env"));
    expect([after.mode, after.uid, after.gid]).toEqual([
      before.mode,
      before.uid,
      before.gid,
    ]);
    expect(
      (await fs.stat(path.join(fx.updaterDirectory, "compose.yaml"))).mode &
        0o777,
    ).toBe(0o640);
  });

  it("sets mode before handing ownership away, without requiring the FOWNER capability", async () => {
    const fx = await fixture(true);
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes(".upgrade-file.")) {
        let transferred = false;
        const chmod = handle.chmod.bind(handle);
        const chown = handle.chown.bind(handle);
        handle.chmod = async (...values) => {
          expect(transferred).toBe(false);
          return chmod(...values);
        };
        handle.chown = async (...values) => {
          transferred = true;
          return chown(...values);
        };
      }
      return handle;
    });
    try {
      await runDeploymentUpdate(fx);
    } finally {
      open.mockRestore();
    }
  });

  it.each([
    "hash",
    "metadata schema",
    "protocol",
    "lifecycle protocol",
    "version",
    "commit",
    "unknown template",
    "manifest",
    "server schema",
  ])(
    "refuses invalid %s before command or deployment effects",
    async (failure) => {
      const fx = await fixture();
      const doc = JSON.parse(fx.downloads["assistant-deployment.json"]!);
      if (failure === "hash") fx.downloads["upgrade.sh"] += "tampered";
      if (failure === "metadata schema") doc.schemaVersion = 2;
      if (failure === "protocol") doc.updaterProtocol = 2;
      if (failure === "lifecycle protocol") doc.lifecycleProtocol = 2;
      if (failure === "version") doc.version = "9.9.9";
      if (failure === "commit") doc.commit = "e".repeat(40);
      if (failure === "unknown template")
        doc.assets["compose.evil.yaml"] = "e".repeat(64);
      if (failure === "manifest")
        fx.downloads["assistant-release.env"] += "UPDATER_IMAGE=evil\n";
      if (failure === "server schema") {
        fx.downloads["server.example.json"] = '{"schemaVersion":2}';
        doc.assets["server.example.json"] = digest(
          fx.downloads["server.example.json"],
        );
      }
      fx.downloads["assistant-deployment.json"] = JSON.stringify(doc);
      await expect(runDeploymentUpdate(fx)).rejects.toThrow();
      expect(fx.run).not.toHaveBeenCalled();
      expect(
        (await fs.readdir(fx.deployDirectory)).some((name) =>
          name.startsWith(".upgrade-"),
        ),
      ).toBe(false);
      expect(
        await fs.readFile(path.join(fx.deployDirectory, "upgrade.sh"), "utf8"),
      ).toBe(fx.oldAssets["upgrade.sh"]);
    },
  );

  it.each(["modified", "unknown", "schema", "stale version"])(
    "refuses installed %s before download",
    async (failure) => {
      const fx = await fixture();
      if (failure === "modified")
        await fs.appendFile(
          path.join(fx.deployDirectory, "compose.yaml"),
          "edit",
        );
      if (failure === "unknown")
        await fs.writeFile(
          path.join(fx.deployDirectory, "compose.custom.yaml"),
          "custom",
        );
      if (failure === "schema")
        await fs.writeFile(
          path.join(fx.deployDirectory, "server.json"),
          '{"schemaVersion":2}',
        );
      if (failure === "stale version") fx.operation.fromVersion = "0.0.1";
      await expect(runDeploymentUpdate(fx)).rejects.toThrow();
      expect(fx.request).not.toHaveBeenCalled();
      expect(fx.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://github.com/evil",
    "https://evil.example/download",
    "https://user@github.com/evil",
    "https://github.com:444/evil",
  ])("rejects unsafe redirects: %s", async (location) => {
    const fx = await fixture();
    fx.request.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_download_url_invalid",
    );
    expect(fx.request).toHaveBeenCalledTimes(1);
    expect(fx.run).not.toHaveBeenCalled();
  });

  it("bounds redirects, content length and streamed bytes before commands", async () => {
    const fx = await fixture();
    fx.request.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://objects.githubusercontent.com/redirect",
          },
        }),
    );
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_download_redirect_invalid",
    );
    expect(fx.request).toHaveBeenCalledTimes(4);
    fx.request.mockImplementation(
      async () =>
        new Response("too large", {
          headers: { "content-length": "999999999" },
        }),
    );
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_download_too_large",
    );
    fx.request.mockImplementation(async () => new Response("a".repeat(65537)));
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_download_too_large",
    );
    expect(fx.run).not.toHaveBeenCalled();
  });

  it("restores standalone updater env/template and rolls back app when updater restart fails", async () => {
    const fx = await fixture(true);
    let restart = 0;
    fx.run.mockImplementation(async (executable, args) => {
      if (executable === "docker" && args[0] === "compose" && ++restart === 1)
        throw new Error("secret output");
    });
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_update_failed",
    );
    expect(
      fx.run.mock.calls.some(([, args]) => args.includes("rollback")),
    ).toBe(true);
    expect(
      await fs.readFile(path.join(fx.updaterDirectory, ".env"), "utf8"),
    ).toBe(fx.oldUpdaterEnv);
    expect(
      await fs.readFile(path.join(fx.updaterDirectory, "compose.yaml"), "utf8"),
    ).toBe(fx.oldAssets["compose.updater.yaml"]);
  });

  it("does not swallow termination during updater restart or start more recovery commands", async () => {
    const fx = await fixture(true);
    fx.run.mockImplementation(async (executable, args) => {
      if (executable === "docker" && args[0] === "compose")
        throw new Error("deployment_terminated");
    });
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_terminated",
    );
    expect(fx.run).toHaveBeenCalledTimes(4);
    expect(
      fx.run.mock.calls.some(([, args]) => args.includes("rollback")),
    ).toBe(false);
  });

  it("does not restart the updater if termination interrupts app recovery", async () => {
    const fx = await fixture(true);
    fx.run.mockImplementation(async (executable, args) => {
      if (executable === "docker" && args[0] === "compose")
        throw new Error("restart failed");
      if (args.includes("rollback")) throw new Error("deployment_terminated");
    });
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_terminated",
    );
    expect(
      fx.run.mock.calls.filter(
        ([executable, args]) =>
          executable === "docker" && args[0] === "compose",
      ),
    ).toHaveLength(1);
  });

  it("recovers even if progress persistence fails after the app command succeeded", async () => {
    const fx = await fixture(true);
    fx.onProgress.mockImplementation(async (phase) => {
      if (phase === "installing" || phase === "rolling_back")
        throw new Error("persistence offline");
    });
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_update_failed",
    );
    expect(
      fx.run.mock.calls.some(([, args]) => args.includes("rollback")),
    ).toBe(true);
    expect(
      await fs.readFile(path.join(fx.updaterDirectory, ".env"), "utf8"),
    ).toBe(fx.oldUpdaterEnv);
  });

  it("restores updater files independently when app rollback fails", async () => {
    const fx = await fixture(true);
    let restart = 0;
    fx.run.mockImplementation(async (executable, args) => {
      if (executable === "docker" && args[0] === "compose" && ++restart === 1)
        throw new Error("restart failed");
      if (args.includes("rollback")) throw new Error("app rollback failed");
    });
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_rollback_failed",
    );
    expect(
      await fs.readFile(path.join(fx.updaterDirectory, ".env"), "utf8"),
    ).toBe(fx.oldUpdaterEnv);
    expect(
      await fs.readFile(path.join(fx.updaterDirectory, "compose.yaml"), "utf8"),
    ).toBe(fx.oldAssets["compose.updater.yaml"]);
  });

  it("keeps the previous successful updater recovery point if app installation fails", async () => {
    const fx = await fixture(true);
    const previous = path.join(fx.deployDirectory, ".upgrade-updater-previous");
    await fs.mkdir(previous);
    await fs.writeFile(
      path.join(previous, "compose.yaml"),
      "previous-successful-update",
    );
    fx.run.mockImplementation(async (executable, args) => {
      if (executable === "bash" && !args.includes("--validate-release"))
        throw new Error("app startup failed");
    });
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_update_failed",
    );
    expect(await fs.readFile(path.join(previous, "compose.yaml"), "utf8")).toBe(
      "previous-successful-update",
    );
  });

  it.each([false, true])(
    "keeps the optional-feature selection through an update (features on: %s)",
    async (optional) => {
      const fx = await fixture(true, optional);
      const env = await fs.readFile(path.join(fx.deployDirectory, ".env"));
      const config = await fs.readFile(
        path.join(fx.deployDirectory, "server.json"),
      );
      expect((await readInstalledDeploymentState(fx)).managed).toBe(true);
      await runDeploymentUpdate(fx);
      // Every installed feature template is fetched from the next release.
      for (const name of Object.keys(fx.oldAssets))
        expect(fx.request).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/${name.replace(/\./g, "\\.")}$`)),
          expect.anything(),
        );
      expect(await fs.readFile(path.join(fx.deployDirectory, ".env"))).toEqual(
        env,
      );
      expect(
        await fs.readFile(path.join(fx.deployDirectory, "server.json")),
      ).toEqual(config);
    },
  );

  it("refuses custom COMPOSE_FILE paths before fetching or execution", async () => {
    const fx = await fixture();
    await fs.writeFile(
      path.join(fx.deployDirectory, ".env"),
      "COMPOSE_FILE=compose.yaml:custom.yml\n",
    );
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      "deployment_template_unknown",
    );
    expect(fx.request).not.toHaveBeenCalled();
    expect(fx.run).not.toHaveBeenCalled();
  });

  it("sanitises request errors instead of exposing URLs, credentials or raw logs", async () => {
    const fx = await fixture();
    fx.request.mockRejectedValue(
      new Error("secret-token in https://example.invalid/private"),
    );
    await expect(runDeploymentUpdate(fx)).rejects.toThrow(
      /^deployment_update_failed$/,
    );
  });

  /** A completed update from 1.1.0 that can be rolled back. */
  async function rollbackFixture(optional = false) {
    const fx = await fixture(true, optional);
    const previous = path.join(fx.deployDirectory, ".upgrade-updater-previous");
    const assetsPrevious = path.join(
      fx.deployDirectory,
      ".upgrade-assets-previous",
    );
    await fs.mkdir(previous);
    await fs.mkdir(assetsPrevious);
    const priorNames = Object.keys(fx.oldAssets).filter(
      (name) => name !== "compose.updater.yaml",
    );
    for (const name of priorNames)
      await fs.writeFile(path.join(assetsPrevious, name), fx.oldAssets[name]!);
    await fs.writeFile(
      path.join(assetsPrevious, ".files"),
      [...priorNames, "assistant-deployment.json"].join("\n") + "\n",
    );
    await fs.writeFile(
      path.join(previous, "compose.yaml"),
      fx.oldAssets["compose.updater.yaml"]!,
    );
    await fs.writeFile(path.join(previous, ".env"), fx.oldUpdaterEnv);
    await fs.writeFile(
      path.join(assetsPrevious, "assistant-deployment.json"),
      metadata("1.1.0", fx.oldAssets),
    );
    await fs.writeFile(
      path.join(fx.deployDirectory, ".release-previous.env"),
      manifest("1.1.0").replace(updaterImage, previousUpdaterImage),
    );
    await fs.writeFile(
      path.join(fx.deployDirectory, ".upgrade-state"),
      "status=done\n",
    );
    fx.operation.kind = "rollback";
    fx.operation.targetVersion = "1.1.0";
    return fx;
  }
  const previousUpdaterImage = `ghcr.io/reefbarman/agentlink-updater@sha256:${"c".repeat(64)}`;
  const docker = (fx: Awaited<ReturnType<typeof fixture>>) =>
    fx.run.mock.calls
      .filter(([executable]) => executable === "docker")
      .map(([, args]) => args.join(" "));

  it("checks the previous updater image before anything stops, pulling it by digest if missing", async () => {
    const fx = await rollbackFixture();
    fx.run.mockImplementation(async (executable, args) => {
      if (executable === "docker" && args[0] === "image")
        throw new Error("No such image");
    });
    await runDeploymentRollback(fx);
    expect(docker(fx).slice(0, 2)).toEqual([
      `image inspect ${previousUpdaterImage}`,
      `pull ${previousUpdaterImage}`,
    ]);
    const order = fx.run.mock.calls.map(([executable]) => executable);
    expect(order.indexOf("bash")).toBeGreaterThan(1);
  });

  it("refuses a rollback whose previous updater image is unavailable, with nothing stopped", async () => {
    const fx = await rollbackFixture();
    fx.run.mockImplementation(async (executable) => {
      if (executable === "docker") throw new Error("pull access denied");
    });
    await expect(runDeploymentRollback(fx)).rejects.toThrow(
      /^deployment_rollback_updater_unavailable$/,
    );
    expect(
      fx.run.mock.calls.some(([executable]) => executable === "bash"),
    ).toBe(false);
    expect(docker(fx)).toEqual([
      `image inspect ${previousUpdaterImage}`,
      `pull ${previousUpdaterImage}`,
    ]);
    expect(fx.phases).toEqual([]);
  });

  it("offers no rollback once a feature change retired it", async () => {
    const fx = await rollbackFixture();
    expect((await readInstalledDeploymentState(fx)).rollbackVersion).toBe(
      "1.1.0",
    );
    await fs.writeFile(
      path.join(fx.deployDirectory, ".upgrade-state"),
      "status=retired\n",
    );
    expect((await readInstalledDeploymentState(fx)).rollbackVersion).toBeNull();
    await expect(runDeploymentRollback(fx)).rejects.toThrow(
      /^deployment_rollback_unavailable$/,
    );
    expect(fx.run).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "restores previous standalone updater only after explicit rollback and reconnecting (features on: %s)",
    async (optional) => {
      const fx = await rollbackFixture(optional);
      const env = await fs.readFile(path.join(fx.deployDirectory, ".env"));
      expect((await readInstalledDeploymentState(fx)).rollbackVersion).toBe(
        "1.1.0",
      );
      await runDeploymentRollback(fx);
      expect(fx.request).not.toHaveBeenCalled();
      expect(fx.phases).toEqual(["rolling_back", "reconnecting"]);
      // The image is already here: checked, not pulled.
      expect(docker(fx)[0]).toBe(`image inspect ${previousUpdaterImage}`);
      expect(docker(fx).some((call) => call.startsWith("pull"))).toBe(false);
      expect(
        fx.run.mock.calls.find(([executable]) => executable === "bash")![1],
      ).toContain("rollback");
      expect(fx.run.mock.calls.at(-1)?.[0]).toBe("docker");
      expect(await fs.readFile(path.join(fx.deployDirectory, ".env"))).toEqual(
        env,
      );
    },
  );
});
