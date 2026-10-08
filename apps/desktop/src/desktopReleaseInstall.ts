import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  downloadReleaseUpdate,
  type ReleaseInstallState,
} from "../../../src/updates/releaseInstall.js";
import type {
  ReleaseUpdateCandidate,
  ReleaseUpdateIdentity,
} from "../../../src/updates/releaseUpdateTypes.js";
import { compareReleaseVersions } from "../../../src/updates/releaseSelection.js";
import {
  buildDesktopUpdateApplyScript,
  type DesktopPendingUpdate,
} from "./desktopUpdateApply.js";

const execFileAsync = promisify(execFile);
export type DesktopUpdateCommand = (
  file: string,
  args: string[],
) => Promise<string>;
export const runDesktopUpdateCommand: DesktopUpdateCommand = async (
  file,
  args,
) => {
  const result = await execFileAsync(file, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return `${result.stdout}\n${result.stderr}`.trim();
};

export function desktopBundlePath(executable: string): string {
  const suffix = "/Contents/MacOS/AgentLink";
  if (
    !executable.endsWith(suffix) ||
    !executable.slice(0, -suffix.length).endsWith(".app")
  ) {
    throw new Error(
      "Self-update is unavailable for this app layout. Rebuild with npm run desktop:install.",
    );
  }
  return executable.slice(0, -suffix.length);
}

async function requireUnsigned(
  bundle: string,
  run: DesktopUpdateCommand,
): Promise<void> {
  // codesign exits unsuccessfully for the intentionally unsigned CI previews.
  let signature: string;
  try {
    signature = await run("/usr/bin/codesign", ["-dv", bundle]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (
      typeof stderr !== "string" ||
      !/not signed at all|invalid signature|code object is not signed/i.test(
        stderr,
      )
    )
      throw error;
    signature = stderr;
  }
  const team = signature.match(/^TeamIdentifier=(.+)$/m)?.[1].trim();
  if (team && team !== "not set") {
    throw new Error(
      "Locally Team ID-signed apps cannot self-update. Rebuild with npm run desktop:install to preserve signing and Keychain access.",
    );
  }
}

export async function checkDesktopUpdatePreconditions(options: {
  packaged: boolean;
  executable: string;
  platform?: string;
  run?: DesktopUpdateCommand;
  writable?: (file: string) => Promise<void>;
}): Promise<string> {
  if (!options.packaged)
    throw new Error(
      "Source builds must be updated from source with npm run desktop:install.",
    );
  if ((options.platform ?? process.platform) !== "darwin")
    throw new Error("Desktop self-update currently supports macOS only.");
  const bundle = desktopBundlePath(options.executable);
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) {
    throw new Error(
      "Move AgentLink into a writable Applications folder before updating. Disk images and translocated apps cannot self-update.",
    );
  }
  const writable = options.writable ?? ((file) => access(file, constants.W_OK));
  try {
    await writable(bundle);
    await writable(path.dirname(bundle));
  } catch {
    throw new Error(
      "The app and its parent folder must be writable. Update manually, no administrator password will be requested.",
    );
  }
  await requireUnsigned(bundle, options.run ?? runDesktopUpdateCommand);
  return bundle;
}

export async function verifyDesktopUpdateBundle(
  bundle: string,
  version: string,
  arch: string,
  run = runDesktopUpdateCommand,
): Promise<void> {
  if (!(await lstat(bundle)).isDirectory())
    throw new Error("The staged app is not a regular directory.");
  for (const directory of [
    path.join(bundle, "Contents"),
    path.join(bundle, "Contents/MacOS"),
  ]) {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("The staged app contains a redirected bundle directory.");
  }
  const plist = path.join(bundle, "Contents/Info.plist");
  if (!(await lstat(plist)).isFile())
    throw new Error("The staged app metadata is not a regular file.");
  const identifier = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    plist,
  ]);
  const bundleVersion = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plist,
  ]);
  if (identifier !== "com.agentlink.desktop" || bundleVersion !== version)
    throw new Error(
      "The staged app identifier or version does not match the verified release.",
    );
  const executable = path.join(bundle, "Contents/MacOS/AgentLink");
  if (!(await lstat(executable)).isFile())
    throw new Error("The staged executable is not a regular file.");
  const architectures = await run("/usr/bin/lipo", ["-archs", executable]);
  if (!architectures.split(/\s+/).includes(arch === "x64" ? "x86_64" : arch))
    throw new Error("The staged app does not support this Mac's architecture.");
  await requireUnsigned(bundle, run);
}

export async function drainDesktopUpdateHelper(options: {
  executable: string;
  helperPid: number;
  shutdown(): Promise<unknown>;
  run?: DesktopUpdateCommand;
}): Promise<void> {
  let executable: string;
  try {
    executable = await (options.run ?? runDesktopUpdateCommand)("/bin/ps", [
      "-p",
      String(options.helperPid),
      "-o",
      "comm=",
    ]);
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    // A previous restart attempt may have drained the helper before spawn failed.
    if (result.code === 1 && result.stdout === "" && result.stderr === "")
      return;
    throw error;
  }
  if (executable !== options.executable)
    throw new Error(
      "The discovered helper is not owned by this Desktop app. Update manually.",
    );
  await options.shutdown();
}

export interface DesktopReleaseInstallOptions {
  packaged: boolean;
  executable: string;
  userData: string;
  identity: ReleaseUpdateIdentity;
  getCandidate(): Promise<ReleaseUpdateCandidate | undefined>;
  confirmInstall(version: string): Promise<boolean>;
  confirmRestart(version: string): Promise<boolean>;
  drainHelper(): Promise<void>;
  quit(): void;
  onState(state: ReleaseInstallState): void;
  log(message: string): void;
  run?: DesktopUpdateCommand;
  download?: typeof downloadReleaseUpdate;
  launchApply?: (script: string) => Promise<void>;
}

export class DesktopReleaseInstaller {
  private state: ReleaseInstallState = { phase: "idle" };
  private pending: DesktopPendingUpdate | undefined;
  private busy = false;
  private applying = false;
  private recoveryBlocked = false;
  private readonly directory: string;
  private readonly run: DesktopUpdateCommand;

  constructor(private readonly options: DesktopReleaseInstallOptions) {
    this.directory = path.join(options.userData, "updates");
    this.run = options.run ?? runDesktopUpdateCommand;
  }

  snapshot(): ReleaseInstallState {
    return { ...this.state };
  }

  private report(state: ReleaseInstallState): void {
    this.state = state;
    this.options.onState(this.snapshot());
  }

  private async fingerprint(
    bundle: string,
  ): Promise<DesktopPendingUpdate["destinationFingerprint"]> {
    const stats = await lstat(bundle, { bigint: true });
    if (!stats.isDirectory())
      throw new Error("The installed app is not a regular directory.");
    return {
      inode: stats.ino.toString(),
      version: await this.run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        path.join(bundle, "Contents/Info.plist"),
      ]),
    };
  }

  private recordPath(name: string): string {
    return path.join(this.directory, name);
  }

  private async savePending(pending: DesktopPendingUpdate): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = this.recordPath("pending-update.json");
    await writeFile(`${file}.partial`, JSON.stringify(pending), {
      mode: 0o600,
    });
    await rename(`${file}.partial`, file);
  }

  private validatePending(value: unknown): DesktopPendingUpdate {
    const pending = value as DesktopPendingUpdate;
    const destination = desktopBundlePath(this.options.executable);
    const stageRoot =
      typeof pending?.staged === "string" ? path.dirname(pending.staged) : "";
    if (
      !pending ||
      !/^\d+\.\d+\.\d+$/.test(pending.version) ||
      pending.destination !== destination ||
      path.dirname(stageRoot) !== path.dirname(destination) ||
      !/^\.agentlink-update-[a-zA-Z0-9]+$/.test(path.basename(stageRoot)) ||
      pending.staged !== path.join(stageRoot, "AgentLink.app") ||
      pending.backup !== path.join(stageRoot, "previous.app") ||
      !/^\d+$/.test(pending.destinationFingerprint?.inode) ||
      typeof pending.destinationFingerprint?.version !== "string"
    ) {
      throw new Error(
        "The pending update record is invalid. Update manually; recovery files were retained.",
      );
    }
    return pending;
  }

  private async retirePending(pending: DesktopPendingUpdate): Promise<boolean> {
    try {
      await lstat(pending.backup);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const current = await this.fingerprint(pending.destination);
    if (current.version !== this.options.identity.version) return false;
    const root = path.dirname(pending.staged);
    if (!(await lstat(root)).isDirectory()) return false;
    // Archive records with staging instead of deleting files that may aid recovery.
    await rename(
      this.recordPath("pending-update.json"),
      path.join(root, "pending-update.json"),
    );
    this.pending = undefined;
    this.recoveryBlocked = false;
    await rename(
      this.recordPath("apply-result.json"),
      path.join(root, "apply-result.json"),
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.options.log(`retired update; recovery files retained at ${root}`);
    return true;
  }

  async reconcile(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.recordPath("pending-update.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const pending = this.validatePending(JSON.parse(raw));
      this.pending = pending;
      const root = path.dirname(pending.staged);
      if (!(await lstat(root)).isDirectory())
        throw new Error("Update staging is not a regular directory.");
      if (this.options.identity.version === pending.version) {
        await verifyDesktopUpdateBundle(
          pending.destination,
          pending.version,
          process.arch,
          this.run,
        );
        await rm(root, { recursive: true });
        await rm(this.recordPath("pending-update.json"));
        await rm(this.recordPath("apply-result.json"), { force: true });
        this.pending = undefined;
        this.report({
          phase: "installed",
          version: pending.version,
          message: `Updated to ${pending.version}.`,
        });
        return;
      }
      let result: { status?: string; message?: string } | undefined;
      try {
        result = JSON.parse(
          await readFile(this.recordPath("apply-result.json"), "utf8"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        result ||
        compareReleaseVersions(
          pending.version,
          this.options.identity.version,
        ) <= 0
      ) {
        const retired = await this.retirePending(pending);
        const message = result
          ? `The update did not start successfully (${result.message ?? result.status}).`
          : "The staged update is no longer newer than the running app.";
        if (!retired)
          throw new Error(`${message} Recovery backup: ${pending.backup}`);
        this.report({
          phase: "failed",
          message: `${message} Recovery files retained at ${root}. You can install a fresh update.`,
        });
        return;
      }
      const current = await this.fingerprint(pending.destination);
      if (
        current.inode !== pending.destinationFingerprint.inode ||
        current.version !== pending.destinationFingerprint.version
      ) {
        if (!(await this.retirePending(pending)))
          throw new Error(
            `The installed app changed. Recovery backup: ${pending.backup}`,
          );
        this.report({
          phase: "failed",
          message: `The installed app changed. The staged update was retired; recovery files retained at ${root}.`,
        });
        return;
      }
      await verifyDesktopUpdateBundle(
        pending.staged,
        pending.version,
        process.arch,
        this.run,
      );
      this.report({
        phase: "ready_to_restart",
        version: pending.version,
        message:
          "Restart to update. Restart interrupts Desktop agent sessions.",
      });
    } catch (error) {
      this.recoveryBlocked = true;
      this.options.log(
        `update reconciliation failed; retaining recovery files: ${String(error)}`,
      );
      this.report({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async install(): Promise<ReleaseInstallState> {
    if (this.busy || this.pending || this.recoveryBlocked)
      return this.snapshot();
    this.busy = true;
    let stageRoot: string | undefined;
    let stageCleanupSafe = true;
    let dmg: string | undefined;
    try {
      let destination: string;
      try {
        destination = await checkDesktopUpdatePreconditions({
          packaged: this.options.packaged,
          executable: this.options.executable,
          run: this.run,
        });
      } catch (error) {
        this.report({
          phase: "blocked",
          message: error instanceof Error ? error.message : String(error),
        });
        return this.snapshot();
      }
      const originalFingerprint = await this.fingerprint(destination);
      if (originalFingerprint.version !== this.options.identity.version)
        throw new Error(
          "The installed app differs from the running version. Restart Desktop before updating.",
        );
      const candidate = await this.options.getCandidate();
      if (!candidate)
        throw new Error("No compatible Desktop update is available.");
      if (!(await this.options.confirmInstall(candidate.version)))
        return this.snapshot();
      this.report({ phase: "preparing", version: candidate.version });
      dmg = await (this.options.download ?? downloadReleaseUpdate)(
        this.options.identity,
        candidate,
        {
          directory: path.join(this.directory, "downloads"),
          onState: (state) => this.report(state),
        },
      );
      if (!dmg.endsWith(".dmg"))
        throw new Error("The verified release artifact is not a disk image.");
      this.report({ phase: "installing", version: candidate.version });
      stageRoot = await mkdtemp(
        path.join(path.dirname(destination), ".agentlink-update-"),
      );
      const mount = path.join(stageRoot, "mount");
      await mkdir(mount);
      let stageError: unknown;
      stageCleanupSafe = false;
      try {
        await this.run("/usr/bin/hdiutil", [
          "attach",
          "-nobrowse",
          "-noautoopen",
          "-readonly",
          "-mountpoint",
          mount,
          dmg,
        ]);
        await this.run("/usr/bin/ditto", [
          path.join(mount, "AgentLink.app"),
          path.join(stageRoot, "AgentLink.app"),
        ]);
      } catch (error) {
        stageError = error;
      }
      // Attach can mount before failing. Detach without hiding the original error.
      try {
        await this.run("/usr/bin/hdiutil", ["detach", mount]);
        stageCleanupSafe = true;
      } catch {
        try {
          await this.run("/usr/bin/hdiutil", ["detach", "-force", mount]);
          stageCleanupSafe = true;
        } catch (error) {
          this.options.log(`update image detach failed: ${String(error)}`);
          stageError ??= error;
        }
      }
      if (stageError) throw stageError;
      await rm(mount, { recursive: true });
      const staged = path.join(stageRoot, "AgentLink.app");
      await verifyDesktopUpdateBundle(
        staged,
        candidate.version,
        process.arch,
        this.run,
      );
      if ((await lstat(staged)).dev !== (await lstat(destination)).dev)
        throw new Error(
          "The staged app must be on the installed app's filesystem.",
        );
      const pending: DesktopPendingUpdate = {
        version: candidate.version,
        staged,
        destination,
        destinationFingerprint: originalFingerprint,
        backup: path.join(stageRoot, "previous.app"),
      };
      await rm(this.recordPath("apply-result.json"), { force: true });
      await this.savePending(pending);
      this.pending = pending;
      this.report({
        phase: "ready_to_restart",
        version: pending.version,
        message:
          "Restart to update. Restart interrupts Desktop agent sessions.",
      });
    } catch (error) {
      this.report({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      if (stageRoot && stageCleanupSafe && !this.pending) {
        await rm(stageRoot, { recursive: true, force: true }).catch((error) =>
          this.options.log(
            `update staging cleanup failed at ${stageRoot}: ${String(error)}`,
          ),
        );
      } else if (stageRoot) {
        this.options.log(`update staging retained at ${stageRoot}`);
      }
    } finally {
      if (dmg)
        await rm(dmg, { force: true }).catch((error) =>
          this.options.log(`download cleanup failed: ${String(error)}`),
        );
      this.busy = false;
    }
    if (this.pending) await this.restart();
    return this.snapshot();
  }

  async restart(): Promise<ReleaseInstallState> {
    if (
      this.busy ||
      this.applying ||
      !this.pending ||
      this.state.phase !== "ready_to_restart"
    )
      return this.snapshot();
    this.busy = true;
    const pending = this.pending;
    let retryable = false;
    try {
      if (!(await this.options.confirmRestart(pending.version)))
        return this.snapshot();
      await checkDesktopUpdatePreconditions({
        packaged: this.options.packaged,
        executable: this.options.executable,
        run: this.run,
      });
      if (!(await lstat(path.dirname(pending.staged))).isDirectory())
        throw new Error("Update staging is not a regular directory.");
      await verifyDesktopUpdateBundle(
        pending.staged,
        pending.version,
        process.arch,
        this.run,
      );
      if (
        (await lstat(pending.staged)).dev !==
        (await lstat(pending.destination)).dev
      )
        throw new Error(
          "The staging filesystem changed. Update manually; recovery files were retained.",
        );
      const fingerprint = await this.fingerprint(pending.destination);
      if (
        fingerprint.inode !== pending.destinationFingerprint.inode ||
        fingerprint.version !== pending.destinationFingerprint.version
      )
        throw new Error(
          "The installed app changed since staging. Update manually; recovery files were retained.",
        );
      const script = path.join(path.dirname(pending.staged), "apply-update.sh");
      await rm(script, { force: true });
      await writeFile(
        script,
        buildDesktopUpdateApplyScript({
          pending,
          appPid: process.pid,
          resultPath: this.recordPath("apply-result.json"),
        }),
        { mode: 0o700, flag: "wx" },
      );
      retryable = true;
      await this.options.drainHelper();
      if (this.options.launchApply) await this.options.launchApply(script);
      else
        await new Promise<void>((resolve, reject) => {
          const child = spawn("/bin/sh", [script], {
            detached: true,
            stdio: "ignore",
            cwd: "/",
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
      retryable = false;
      this.applying = true;
      this.options.quit();
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (!retryable) {
        try {
          if (await this.retirePending(pending))
            message += ` Recovery files retained at ${path.dirname(pending.staged)}. You can install a fresh update.`;
        } catch (cause) {
          this.recoveryBlocked = true;
          this.options.log(`update recovery record retained: ${String(cause)}`);
        }
      }
      this.report({
        phase: retryable ? "ready_to_restart" : "failed",
        version: pending.version,
        message: retryable
          ? `Restart could not begin: ${message} Retry Restart to update, or quit and reopen Desktop.`
          : message,
      });
      this.options.log(
        `update restart failed; retaining backup ${pending.backup}: ${String(error)}`,
      );
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }
}
