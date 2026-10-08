import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { homedir } from "node:os";
import {
  acquireInstallLock,
  downloadReleaseUpdate,
  type ReleaseInstallState,
} from "../../../src/updates/releaseInstall.js";
import type {
  ReleaseUpdateCandidate,
  ReleaseUpdateIdentity,
} from "../../../src/updates/releaseUpdateTypes.js";

const execFile = promisify(execFileCallback);
const requiredFiles = [
  "bin/agentlink",
  "node/bin/node",
  "dist/agentlink.js",
] as const;

export interface CliPreviewLayout {
  readonly bundleRoot: string;
  readonly libraryRoot: string;
  readonly binDirectory: string;
  readonly launcher: string;
}

export async function recognizeCliPreviewLayout(
  executablePath: string,
  home = homedir(),
): Promise<CliPreviewLayout> {
  const [resolvedExecutable, libraryRoot, binDirectory] = await Promise.all([
    realpath(executablePath),
    realpath(path.join(home, ".local", "lib", "agentlink")),
    realpath(path.join(home, ".local", "bin")),
  ]).catch(() => {
    throw new Error(
      "Self-update is available only for unsigned CLI preview installs with the supported launcher. Update this install manually.",
    );
  });
  const bundleRoot = path.resolve(resolvedExecutable, "../../..");
  const launcher = path.join(binDirectory, "agentlink");
  const bundleName = path.basename(bundleRoot);
  const previewDirectory = path.dirname(bundleRoot);
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !/^agentlink-cli-darwin-arm64$/u.test(bundleName) ||
    path.basename(previewDirectory) === "cli" ||
    !/^cli-preview\.[^/]+$/u.test(path.basename(previewDirectory)) ||
    path.dirname(previewDirectory) !== libraryRoot
  ) {
    throw new Error(
      "Self-update is available only for unsigned CLI preview installs. Rebuild source or update this install manually.",
    );
  }
  const [resolvedBundle, launcherStats] = await Promise.all([
    realpath(bundleRoot),
    lstat(launcher),
  ]).catch(() => {
    throw new Error(
      "This CLI is not installed with the supported preview launcher. Update it manually.",
    );
  });
  if (!launcherStats.isSymbolicLink())
    throw new Error(
      "The CLI launcher is not a symlink. Update this install manually.",
    );
  const resolvedLauncher = await realpath(launcher);
  if (resolvedLauncher !== path.join(resolvedBundle, "bin", "agentlink")) {
    throw new Error(
      "The CLI launcher no longer points to this running bundle. Restart agentlink before updating again; no launcher was replaced.",
    );
  }
  return { bundleRoot: resolvedBundle, libraryRoot, binDirectory, launcher };
}

export function validateArchiveListing(
  names: readonly string[],
  verbose: readonly string[],
): void {
  if (!names.length || names.length !== verbose.length)
    throw new Error("CLI update archive has an invalid inventory.");
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!.replace(/\/$/u, "");
    const type = verbose[index]![0];
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      !["-", "d"].includes(type ?? "")
    ) {
      throw new Error(`Unsafe CLI update archive entry: ${names[index]}`);
    }
  }
}

export async function verifyCliUpdateBundle(
  root: string,
  candidateVersion: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(root, "bundle-manifest.json"), "utf8"),
  ) as {
    schemaVersion?: unknown;
    platform?: unknown;
    version?: unknown;
    signing?: unknown;
    files?: unknown;
  };
  if (manifest.schemaVersion !== 1)
    throw new Error("Unknown CLI bundle manifest version. Update manually.");
  if (
    manifest.platform !== "darwin-arm64" ||
    manifest.version !== candidateVersion ||
    manifest.signing !== "unsigned" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    throw new Error("CLI update bundle manifest does not match this release.");
  }
  const declared = manifest.files as Record<string, unknown>;
  const inventory: string[] = [];
  const walk = async (relative = ""): Promise<void> => {
    const directory = path.join(root, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error(`Unexpected CLI bundle entry: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (name !== "bundle-manifest.json") inventory.push(name);
    }
  };
  await walk();
  const declaredNames = Object.keys(declared);
  if (
    requiredFiles.some((name) => !inventory.includes(name)) ||
    inventory.sort().join("\n") !== declaredNames.sort().join("\n")
  ) {
    throw new Error("CLI update bundle inventory does not match its manifest.");
  }
  for (const name of inventory) {
    const expected = declared[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/iu.test(expected))
      throw new Error(`Invalid CLI bundle manifest hash: ${name}`);
    const actual = createHash("sha256")
      .update(await readFile(path.join(root, name)))
      .digest("hex");
    if (actual !== expected.toLowerCase())
      throw new Error(`CLI bundle SHA-256 mismatch: ${name}`);
  }
}

export async function installCliReleaseUpdate(
  identity: ReleaseUpdateIdentity,
  candidate: ReleaseUpdateCandidate,
  options: {
    home?: string;
    executablePath?: string;
    onState?: (state: ReleaseInstallState) => void;
    request?: typeof fetch;
  } = {},
): Promise<void> {
  const layout = await recognizeCliPreviewLayout(
    options.executablePath ?? process.execPath,
    options.home,
  );
  const releaseLock = await acquireInstallLock(layout.libraryRoot);
  let stagingRoot: string | undefined;
  let stagedDestination: string | undefined;
  let activated = false;
  let artifact: string | undefined;
  try {
    const artifactDirectory = path.join(
      options.home ?? homedir(),
      ".local",
      "lib",
      "agentlink",
      "updates",
    );
    artifact = await downloadReleaseUpdate(identity, candidate, {
      directory: artifactDirectory,
      onState: options.onState,
      request: options.request,
    });
    options.onState?.({ phase: "installing", version: candidate.version });
    stagingRoot = await mkdtemp(path.join(layout.libraryRoot, "cli-preview."));
    const [{ stdout: namesText }, { stdout: verboseText }] = await Promise.all([
      execFile("tar", ["-tzf", artifact]),
      execFile("tar", ["-tvzf", artifact]),
    ]);
    validateArchiveListing(
      namesText.split(/\r?\n/u).filter(Boolean),
      verboseText.split(/\r?\n/u).filter(Boolean),
    );
    await execFile("tar", [
      "-xzf",
      artifact,
      "-C",
      stagingRoot,
      "--no-same-owner",
    ]);
    const expectedBundleName = "agentlink-cli-darwin-arm64";
    const stagingEntries = await readdir(stagingRoot);
    if (
      stagingEntries.length !== 1 ||
      stagingEntries[0] !== expectedBundleName ||
      !(await lstat(path.join(stagingRoot, expectedBundleName))).isDirectory()
    ) {
      throw new Error("CLI update archive has unexpected top-level entries.");
    }
    const newBundle = path.join(stagingRoot, expectedBundleName);
    await verifyCliUpdateBundle(newBundle, candidate.version);
    const versionResult = await execFile(
      path.join(newBundle, "bin", "agentlink"),
      ["--version"],
      { timeout: 30_000 },
    );
    if (versionResult.stdout.trim() !== candidate.version)
      throw new Error("Installed CLI does not report the expected version.");

    const destination = path.join(
      layout.libraryRoot,
      `cli-preview.${candidate.version}-${Date.now()}`,
    );
    await rename(stagingRoot, destination);
    stagingRoot = undefined;
    stagedDestination = destination;
    const currentLayout = await recognizeCliPreviewLayout(
      options.executablePath ?? process.execPath,
      options.home,
    );
    if (currentLayout.bundleRoot !== layout.bundleRoot)
      throw new Error("The active CLI launcher changed during installation.");
    const temporaryLauncher = path.join(
      layout.binDirectory,
      `.agentlink-${process.pid}-${Date.now()}`,
    );
    try {
      await symlink(
        path.join(
          destination,
          "agentlink-cli-darwin-arm64",
          "bin",
          "agentlink",
        ),
        temporaryLauncher,
      );
      await rename(temporaryLauncher, layout.launcher);
      activated = true;
    } catch (error) {
      await rm(temporaryLauncher, { force: true });
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    options.onState?.({
      phase: "installed",
      version: candidate.version,
      message: `Installed ${candidate.version}. This session keeps running ${identity.version}; restart agentlink to use the update.`,
    });
  } catch (error) {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    if (stagedDestination && !activated)
      await rm(stagedDestination, { recursive: true, force: true });
    options.onState?.({
      phase: "failed",
      version: candidate.version,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (artifact) await rm(artifact, { force: true }).catch(() => undefined);
    await releaseLock();
  }
}
