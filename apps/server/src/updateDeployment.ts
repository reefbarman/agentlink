import type {
  AssistantUpdateOperation,
  AssistantUpdatePhase,
} from "../../../src/shared/assistantUpdates.js";

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Deliberately flat and exact, never names or commands supplied by a browser.
const ASSETS = [
  "install.sh",
  "upgrade.sh",
  "compose.yaml",
  "compose.backup.yaml",
  "compose.browser.yaml",
  "compose.editor.yaml",
  "compose.meridian.yaml",
  "compose.publisher.yaml",
  "compose.runners.yaml",
  "compose.searxng.yaml",
  "compose.worker-egress.yaml",
  "compose.witness.yaml",
  "compose.updater.yaml",
  "compose.update-client.yaml",
  "server.example.json",
] as const;
const REQUIRED = ["install.sh", "upgrade.sh", "compose.yaml"];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const PHASES = new Set<AssistantUpdatePhase>([
  "pulling",
  "draining",
  "backing_up",
  "installing",
  "checking_health",
  "rolling_back",
]);
const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const IMAGE_TARGETS: Record<string, string> = {
  ASSISTANT_IMAGE: "assistant",
  COMMAND_WORKER_IMAGE: "command-worker",
  PUBLISHER_IMAGE: "publisher",
  BACKUP_IMAGE: "backup",
  EDITOR_IMAGE: "editor",
  BROWSER_IMAGE: "browser",
  UPDATER_IMAGE: "updater",
};
interface Metadata {
  schemaVersion: 1;
  updaterProtocol: 1;
  version: string;
  commit: string;
  assets: Record<string, string>;
}
interface Manifest {
  version: string;
  commit: string;
  updater: string;
}

function invalid(code: string): never {
  throw new Error(code);
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function metadata(bytes: Uint8Array): Metadata {
  let value: Metadata;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Metadata;
  } catch {
    return invalid("deployment_metadata_invalid");
  }
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.updaterProtocol !== 1 ||
    typeof value.version !== "string" ||
    typeof value.commit !== "string" ||
    !VERSION.test(value.version) ||
    !COMMIT.test(value.commit) ||
    !value.assets ||
    typeof value.assets !== "object" ||
    Array.isArray(value.assets) ||
    Object.keys(value).sort().join(",") !==
      "assets,commit,schemaVersion,updaterProtocol,version" ||
    !REQUIRED.every((name) => Object.hasOwn(value.assets, name)) ||
    Object.entries(value.assets).some(
      ([name, digest]) =>
        !ASSETS.includes(name as (typeof ASSETS)[number]) ||
        typeof digest !== "string" ||
        !HASH.test(digest),
    )
  ) {
    return invalid("deployment_metadata_invalid");
  }
  return value;
}
function manifest(bytes: Uint8Array): Manifest {
  const values = new Map<string, string>();
  for (const line of Buffer.from(bytes)
    .toString("utf8")
    .trimEnd()
    .split("\n")) {
    const match = /^([A-Z_]+)=(.+)$/.exec(line);
    if (!match || values.has(match[1]!)) invalid("deployment_manifest_invalid");
    const key = match[1]!;
    const value = match[2]!;
    if (key !== "RELEASE_VERSION" && key !== "RELEASE_COMMIT") {
      const target = IMAGE_TARGETS[key];
      if (
        !target ||
        !new RegExp(
          `^ghcr\\.io/reefbarman/agentlink-${target}@sha256:[0-9a-f]{64}$`,
        ).test(value)
      ) {
        invalid("deployment_manifest_invalid");
      }
    }
    values.set(key, value);
  }
  const version = values.get("RELEASE_VERSION") ?? "";
  const commit = values.get("RELEASE_COMMIT") ?? "";
  const updater = values.get("UPDATER_IMAGE") ?? "";
  if (
    !VERSION.test(version) ||
    !COMMIT.test(commit) ||
    ![
      "ASSISTANT_IMAGE",
      "COMMAND_WORKER_IMAGE",
      "PUBLISHER_IMAGE",
      "BACKUP_IMAGE",
      "UPDATER_IMAGE",
    ].every((key) => values.has(key))
  ) {
    invalid("deployment_manifest_invalid");
  }
  return { version, commit, updater };
}
async function fileBytes(file: string, limit = 1024 * 1024): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > limit) invalid("deployment_file_invalid");
  return fs.readFile(file);
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function installed(deployDirectory: string): Promise<Metadata> {
  const current = metadata(
    await fileBytes(
      path.join(deployDirectory, "assistant-deployment.json"),
      64 * 1024,
    ),
  );
  const release = manifest(
    await fileBytes(path.join(deployDirectory, "release.env"), 16 * 1024),
  );
  if (current.version !== release.version || current.commit !== release.commit)
    invalid("deployment_identity_mismatch");
  for (const name of await fs.readdir(deployDirectory)) {
    if (
      name.startsWith("compose") &&
      name.endsWith(".yaml") &&
      !Object.hasOwn(current.assets, name)
    ) {
      invalid("deployment_template_unknown");
    }
  }
  const envPath = path.join(deployDirectory, ".env");
  if (await exists(envPath)) {
    const env = (await fileBytes(envPath, 64 * 1024)).toString("utf8");
    const files = [
      ...env.matchAll(/^\s*(?:export\s+)?COMPOSE_FILE\s*=(.*)$/gm),
    ];
    if (files.length > 1 || /^\s*COMPOSE_PATH_SEPARATOR\s*=/m.test(env))
      invalid("deployment_template_unknown");
    if (files[0]) {
      const raw = files[0][1]!.trim();
      const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
      if (
        !value
          .split(":")
          .every(
            (name) =>
              name.startsWith("compose") &&
              name.endsWith(".yaml") &&
              Object.hasOwn(current.assets, name),
          )
      )
        invalid("deployment_template_unknown");
    }
  }
  for (const [name, digest] of Object.entries(current.assets)) {
    if (name === "compose.updater.yaml") continue;
    const file = path.join(deployDirectory, name);
    if (!(await exists(file)) && !REQUIRED.includes(name)) continue;
    if (hash(await fileBytes(file)) !== digest)
      invalid("deployment_template_modified");
  }
  const config = JSON.parse(
    (await fileBytes(path.join(deployDirectory, "server.json"))).toString(
      "utf8",
    ),
  ) as { schemaVersion?: number };
  if (config.schemaVersion !== 1) invalid("deployment_schema_unsupported");
  return current;
}

async function previousDeployment(deployDirectory: string): Promise<Metadata> {
  const directory = path.join(deployDirectory, ".upgrade-assets-previous");
  const previous = metadata(
    await fileBytes(
      path.join(directory, "assistant-deployment.json"),
      64 * 1024,
    ),
  );
  const release = manifest(
    await fileBytes(
      path.join(deployDirectory, ".release-previous.env"),
      16 * 1024,
    ),
  );
  if (
    previous.version !== release.version ||
    previous.commit !== release.commit
  )
    invalid("deployment_identity_mismatch");
  const names = (await fileBytes(path.join(directory, ".files"), 4096))
    .toString("utf8")
    .trimEnd()
    .split("\n");
  if (
    new Set(names).size !== names.length ||
    ![...REQUIRED, "assistant-deployment.json"].every((name) =>
      names.includes(name),
    )
  )
    invalid("deployment_previous_assets_invalid");
  for (const name of names) {
    if (name === "assistant-deployment.json") continue;
    if (
      !ASSETS.includes(name as (typeof ASSETS)[number]) ||
      name === "compose.updater.yaml"
    )
      invalid("deployment_previous_assets_invalid");
    const file = path.join(directory, name);
    if (!(await exists(file))) {
      if (REQUIRED.includes(name))
        invalid("deployment_previous_assets_invalid");
      continue;
    }
    if (
      !previous.assets[name] ||
      hash(await fileBytes(file)) !== previous.assets[name]
    )
      invalid("deployment_previous_assets_invalid");
  }
  return previous;
}

/** Public status is deliberately path/log free; malformed or legacy installs are unmanaged. */
export async function readInstalledDeploymentState(options: {
  deployDirectory: string;
}): Promise<{
  managed: boolean;
  version: string | null;
  commit: string | null;
  rollbackVersion: string | null;
}> {
  try {
    const current = await installed(options.deployDirectory);
    let rollbackVersion: string | null = null;
    const previous = path.join(
      options.deployDirectory,
      ".release-previous.env",
    );
    const state = path.join(options.deployDirectory, ".upgrade-state");
    if (
      (await exists(previous)) &&
      (await exists(state)) &&
      /(?:^|\n)status=done(?:\n|$)/.test(
        (await fileBytes(state, 4096)).toString("utf8"),
      )
    ) {
      try {
        const prior = await previousDeployment(options.deployDirectory);
        if (prior.version !== current.version) rollbackVersion = prior.version;
      } catch {
        /* An incomplete recovery point must not be advertised. */
      }
    }
    return {
      managed: true,
      version: current.version,
      commit: current.commit,
      rollbackVersion,
    };
  } catch {
    return {
      managed: false,
      version: null,
      commit: null,
      rollbackVersion: null,
    };
  }
}

export type DeploymentExecutor = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; onLine?: (line: string) => void },
) => Promise<void>;

/** Bounded child output is discarded, except explicit phase markers. Never persist logs. */
const execute: DeploymentExecutor = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        LANG: "C.UTF-8",
        ...(process.env.DOCKER_HOST?.startsWith("unix://")
          ? { DOCKER_HOST: process.env.DOCKER_HOST }
          : {}),
      },
    });
    let length = 0;
    let pending = "";
    let failed = false;
    let terminated = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = (signal: NodeJS.Signals = "SIGTERM") => {
      if (failed) return;
      failed = true;
      // Let the installed script's TERM/EXIT traps restore the old deployment.
      // An unresponsive process group has a hard five-minute recovery ceiling.
      signalGroup(signal);
      recoveryTimer = setTimeout(() => signalGroup("SIGKILL"), 5 * 60_000);
      recoveryTimer.unref();
    };
    const onTerminate = (signal: NodeJS.Signals) => {
      terminated = true;
      stop(signal);
    };
    process.on("SIGTERM", onTerminate);
    process.on("SIGINT", onTerminate);
    const timer = setTimeout(stop, options.timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(recoveryTimer);
      process.off("SIGTERM", onTerminate);
      process.off("SIGINT", onTerminate);
    };
    const count = (chunk: Buffer) => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) stop();
    };
    child.stderr.on("data", count);
    child.stdout.on("data", (chunk: Buffer) => {
      count(chunk);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > 4096) pending = "";
      for (const line of lines) if (line.length <= 4096) options.onLine?.(line);
    });
    child.once("error", () => {
      cleanup();
      reject(
        new Error(
          terminated ? "deployment_terminated" : "deployment_executor_failed",
        ),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (terminated) reject(new Error("deployment_terminated"));
      else if (failed || code !== 0)
        reject(new Error("deployment_command_failed"));
      else resolve();
    });
  });

export interface DeploymentUpdateOptions {
  deployDirectory: string;
  updaterDirectory: string;
  operation: AssistantUpdateOperation;
  onProgress: (phase: AssistantUpdatePhase) => Promise<void>;
  request?: typeof fetch;
  run?: DeploymentExecutor;
}

function downloader(request: typeof fetch): (name: string) => Promise<Buffer> {
  let requests = 0;
  const deadline = AbortSignal.timeout(120_000);
  return async (url: string) => {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = new URL(current);
      if (
        parsed.protocol !== "https:" ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        !REDIRECT_HOSTS.has(parsed.hostname)
      )
        invalid("deployment_download_url_invalid");
      if (++requests > 80) invalid("deployment_download_budget_exceeded");
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(15_000)]);
      const response = await request(current, { signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) invalid("deployment_download_redirect_invalid");
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        invalid("deployment_download_failed");
      }
      const limit =
        url.endsWith(".json") || url.endsWith(".env") ? 64 * 1024 : 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body.cancel();
        invalid("deployment_download_too_large");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > limit) invalid("deployment_download_too_large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    }
    return invalid("deployment_download_redirect_invalid");
  };
}

async function replaceOwned(
  file: string,
  bytes: Uint8Array,
  script = false,
): Promise<void> {
  const parent = await fs.stat(path.dirname(file));
  const stat = (await exists(file)) ? await fs.lstat(file) : null;
  if (stat && !stat.isFile()) invalid("deployment_file_invalid");
  const scratch = await fs.mkdtemp(
    path.join(path.dirname(file), ".upgrade-file."),
  );
  const temporary = path.join(scratch, "asset");
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      // The job has CHOWN and DAC_OVERRIDE, not FOWNER. Set mode while the
      // temporary is still owned by the job, then transfer ownership last.
      await handle.chmod(stat ? stat.mode & 0o777 : script ? 0o700 : 0o600);
      await handle.chown(stat?.uid ?? parent.uid, stat?.gid ?? parent.gid);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function updaterConfig(
  options: DeploymentUpdateOptions,
  current: Metadata,
  previous?: Metadata,
): Promise<Buffer | null> {
  const compose = path.join(options.updaterDirectory, "compose.yaml");
  if (!(await exists(compose))) return null;
  if (
    !current.assets["compose.updater.yaml"] ||
    ![
      current.assets["compose.updater.yaml"],
      previous?.assets["compose.updater.yaml"],
    ].includes(hash(await fileBytes(compose)))
  ) {
    invalid("deployment_updater_template_modified");
  }
  const env = await fileBytes(
    path.join(options.updaterDirectory, ".env"),
    64 * 1024,
  );
  const matches =
    env
      .toString("utf8")
      .match(/^[ \t]*(?:export[ \t]+)?UPDATER_IMAGE[ \t]*=.*$/gm) ?? [];
  if (
    matches.length !== 1 ||
    !/^UPDATER_IMAGE=ghcr\.io\/reefbarman\/agentlink-updater@sha256:[0-9a-f]{64}\r?$/.test(
      matches[0]!,
    )
  ) {
    invalid("deployment_updater_config_invalid");
  }
  return env;
}

/** Runs inside an independent, trusted updater job container, not the app/service. */
export async function runDeploymentUpdate(
  options: DeploymentUpdateOptions,
): Promise<void> {
  return publicOperation(() => updateDeployment(options));
}

async function publicOperation(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && /^deployment_[a-z_]+$/.test(error.message))
      throw error;
    invalid("deployment_update_failed");
  }
}

async function updateDeployment(
  options: DeploymentUpdateOptions,
): Promise<void> {
  if (options.operation.kind === "rollback")
    return runDeploymentRollback(options);
  if (!VERSION.test(options.operation.targetVersion))
    invalid("deployment_version_invalid");
  const current = await installed(options.deployDirectory);
  if (current.version !== options.operation.fromVersion)
    invalid("deployment_version_changed");
  const oldUpdaterEnv = await updaterConfig(options, current);
  const oldUpdaterCompose = oldUpdaterEnv
    ? await fileBytes(path.join(options.updaterDirectory, "compose.yaml"))
    : null;
  await options.onProgress("downloading");
  const read = downloader(options.request ?? fetch);
  const base = `https://github.com/reefbarman/agentlink/releases/download/assistant-v${options.operation.targetVersion}/`;
  const metadataBytes = await read(`${base}assistant-deployment.json`);
  const next = metadata(metadataBytes);
  const manifestBytes = await read(`${base}assistant-release.env`);
  const release = manifest(manifestBytes);
  if (
    next.version !== options.operation.targetVersion ||
    release.version !== next.version ||
    release.commit !== next.commit
  ) {
    invalid("deployment_identity_mismatch");
  }
  const assets = new Map<string, Buffer>();
  for (const [name, digest] of Object.entries(next.assets)) {
    const bytes = await read(`${base}${name}`);
    if (hash(bytes) !== digest) invalid("deployment_asset_hash_mismatch");
    assets.set(name, bytes);
  }
  await options.onProgress("validating");
  for (const name of Object.keys(current.assets)) {
    if (
      name !== "compose.updater.yaml" &&
      (await exists(path.join(options.deployDirectory, name))) &&
      !assets.has(name)
    ) {
      invalid("deployment_template_set_incompatible");
    }
  }
  if (oldUpdaterEnv && !assets.has("compose.updater.yaml"))
    invalid("deployment_updater_asset_missing");
  if (!assets.has("server.example.json"))
    invalid("deployment_schema_unsupported");
  if (assets.has("server.example.json")) {
    let example: { schemaVersion?: number };
    try {
      example = JSON.parse(
        assets.get("server.example.json")!.toString("utf8"),
      ) as typeof example;
    } catch {
      return invalid("deployment_schema_unsupported");
    }
    if (example.schemaVersion !== 1) invalid("deployment_schema_unsupported");
  }
  // Recheck the baseline after network I/O, before any deployment/Docker effects.
  const baseline = await installed(options.deployDirectory);
  if (JSON.stringify(baseline) !== JSON.stringify(current))
    invalid("deployment_version_changed");
  await updaterConfig(options, current);
  // No deployment or Docker effects until all downloaded content is verified.
  const stage = await fs.mkdtemp(
    path.join(options.deployDirectory, ".upgrade-staging."),
  );
  const trusted = path.join(stage, "trusted-upgrade.sh");
  const run = options.run ?? execute;
  let progress = Promise.resolve();
  let appInstalled = false;
  const command = async (
    args: readonly string[],
    installsApp = false,
    recovering = false,
  ) => {
    let commandFailed = false;
    let progressFailed = false;
    try {
      await run(
        "bash",
        [trusted, "--deploy", options.deployDirectory, ...args],
        {
          cwd: options.deployDirectory,
          timeoutMs: 45 * 60_000,
          onLine: (line) => {
            const phase = line.replace(
              /^AGENTLINK_UPDATE_PHASE=/,
              "",
            ) as AssistantUpdatePhase;
            if (
              line.startsWith("AGENTLINK_UPDATE_PHASE=") &&
              PHASES.has(phase)
            ) {
              progress = progress
                .then(() => options.onProgress(phase))
                .catch(() => {
                  progressFailed = true;
                });
            }
          },
        },
      );
      if (installsApp) appInstalled = true;
    } catch (error) {
      if (error instanceof Error && error.message === "deployment_terminated") {
        await progress;
        throw error;
      }
      commandFailed = true;
    }
    await progress;
    if (commandFailed) invalid("deployment_command_failed");
    if (progressFailed && !recovering) invalid("deployment_progress_failed");
  };
  let updaterChanged = false;
  const previousUpdater = path.join(
    options.deployDirectory,
    ".upgrade-updater-previous",
  );
  try {
    await fs.writeFile(
      trusted,
      await fileBytes(path.join(options.deployDirectory, "upgrade.sh")),
      { mode: 0o700 },
    );
    for (const [name, bytes] of assets)
      await fs.writeFile(path.join(stage, name), bytes, { mode: 0o600 });
    await fs.writeFile(
      path.join(stage, "assistant-deployment.json"),
      metadataBytes,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(stage, "assistant-release.env"),
      manifestBytes,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(stage, ".asset-list"),
      [
        ...assets.entries(),
        ["assistant-deployment.json", metadataBytes] as const,
      ]
        .map(([name, bytes]) => `${hash(bytes)} ${name}\n`)
        .join(""),
      { mode: 0o600 },
    );
    await command([
      "--release-manifest",
      path.join(stage, "assistant-release.env"),
      "--validate-release",
      "--release-assets",
      stage,
    ]);
    // Pull standalone updater ahead of downtime, but do not restart it yet.
    if (oldUpdaterEnv) {
      await options.onProgress("pulling");
      await run("docker", ["pull", release.updater], {
        cwd: options.deployDirectory,
        timeoutMs: 10 * 60_000,
      });
    }
    await command(
      [
        "--release-manifest",
        path.join(stage, "assistant-release.env"),
        "--release-assets",
        stage,
      ],
      true,
    );
    // Do not overwrite the previous successful updater recovery point if pulling,
    // draining or app startup failed before the new app was installed.
    if (oldUpdaterEnv && oldUpdaterCompose) {
      await fs.rm(previousUpdater, { recursive: true, force: true });
      await fs.mkdir(previousUpdater, { mode: 0o700 });
      await fs.writeFile(
        path.join(previousUpdater, "compose.yaml"),
        oldUpdaterCompose,
        { mode: 0o600 },
      );
      await fs.writeFile(path.join(previousUpdater, ".env"), oldUpdaterEnv, {
        mode: 0o600,
      });
    }
    // Caller persists reconnecting before the long-lived service may disappear.
    await options.onProgress("reconnecting");
    if (oldUpdaterEnv) {
      updaterChanged = true;
      await replaceOwned(
        path.join(options.updaterDirectory, "compose.yaml"),
        assets.get("compose.updater.yaml")!,
      );
      await replaceOwned(
        path.join(options.updaterDirectory, ".env"),
        Buffer.from(
          oldUpdaterEnv
            .toString("utf8")
            .replace(
              /^UPDATER_IMAGE=[^\r\n]*/m,
              `UPDATER_IMAGE=${release.updater}`,
            ),
        ),
      );
      await run(
        "docker",
        ["compose", "--project-name", "agentlink-updater", "up", "-d"],
        {
          cwd: options.updaterDirectory,
          timeoutMs: 3 * 60_000,
        },
      );
    }
  } catch (error) {
    // The active child's traps already had their recovery window. Never resume
    // deployment or restart the updater after the job was asked to terminate.
    if (error instanceof Error && error.message === "deployment_terminated")
      throw error;
    if (appInstalled) {
      // Progress persistence must not prevent safety recovery.
      await options.onProgress("rolling_back").catch(() => {});
      let recoveryFailed = false;
      try {
        await command(["rollback"], false, true);
      } catch (error) {
        if (error instanceof Error && error.message === "deployment_terminated")
          throw error;
        recoveryFailed = true;
      }
      if (updaterChanged && oldUpdaterEnv) {
        try {
          await replaceOwned(
            path.join(options.updaterDirectory, "compose.yaml"),
            oldUpdaterCompose!,
          );
          await replaceOwned(
            path.join(options.updaterDirectory, ".env"),
            oldUpdaterEnv,
          );
          await run(
            "docker",
            ["compose", "--project-name", "agentlink-updater", "up", "-d"],
            {
              cwd: options.updaterDirectory,
              timeoutMs: 3 * 60_000,
            },
          );
        } catch {
          recoveryFailed = true;
        }
      }
      if (recoveryFailed) invalid("deployment_rollback_failed");
    }
    invalid("deployment_update_failed");
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function runDeploymentRollback(
  options: DeploymentUpdateOptions,
): Promise<void> {
  return publicOperation(() => rollbackDeployment(options));
}

async function rollbackDeployment(
  options: DeploymentUpdateOptions,
): Promise<void> {
  const current = await installed(options.deployDirectory);
  if (current.version !== options.operation.fromVersion)
    invalid("deployment_version_changed");
  const state = await readInstalledDeploymentState(options);
  if (state.rollbackVersion !== options.operation.targetVersion)
    invalid("deployment_rollback_unavailable");
  const oldMetadata = await previousDeployment(options.deployDirectory);
  const oldUpdaterEnv = await updaterConfig(options, current, oldMetadata);
  const previous = path.join(
    options.deployDirectory,
    ".upgrade-updater-previous",
  );
  let previousCompose: Buffer | null = null;
  let previousEnv: Buffer | null = null;
  if (oldUpdaterEnv) {
    previousCompose = await fileBytes(path.join(previous, "compose.yaml"));
    previousEnv = await fileBytes(path.join(previous, ".env"), 64 * 1024);
    if (hash(previousCompose) !== oldMetadata.assets["compose.updater.yaml"])
      invalid("deployment_updater_template_modified");
    const previousManifest = manifest(
      await fileBytes(
        path.join(options.deployDirectory, ".release-previous.env"),
        16 * 1024,
      ),
    );
    const imageLines =
      previousEnv
        .toString("utf8")
        .match(/^[ \t]*(?:export[ \t]+)?UPDATER_IMAGE[ \t]*=.*$/gm) ?? [];
    if (
      imageLines.length !== 1 ||
      imageLines[0]!.replace(/\r$/, "") !==
        `UPDATER_IMAGE=${previousManifest.updater}`
    )
      invalid("deployment_updater_config_invalid");
  }
  const stage = await fs.mkdtemp(
    path.join(options.deployDirectory, ".upgrade-staging."),
  );
  const run = options.run ?? execute;
  try {
    const trusted = path.join(stage, "trusted-upgrade.sh");
    await fs.writeFile(
      trusted,
      await fileBytes(path.join(options.deployDirectory, "upgrade.sh")),
      { mode: 0o700 },
    );
    await options.onProgress("rolling_back");
    await run(
      "bash",
      [trusted, "--deploy", options.deployDirectory, "rollback"],
      { cwd: options.deployDirectory, timeoutMs: 45 * 60_000 },
    );
    await options.onProgress("reconnecting");
    if (previousCompose && previousEnv) {
      await replaceOwned(
        path.join(options.updaterDirectory, "compose.yaml"),
        previousCompose,
      );
      await replaceOwned(
        path.join(options.updaterDirectory, ".env"),
        previousEnv,
      );
      await run(
        "docker",
        ["compose", "--project-name", "agentlink-updater", "up", "-d"],
        { cwd: options.updaterDirectory, timeoutMs: 3 * 60_000 },
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message === "deployment_terminated")
      throw error;
    invalid("deployment_rollback_failed");
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
