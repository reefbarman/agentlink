import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Coordination between everything that changes a managed deployment: the
 * update worker (browser updates and rollbacks) and the installer's local
 * `enable`, `disable`, `uninstall`, `resume` and `recover` commands.
 *
 * Both files live in the updater directory, outside the deploy directory,
 * so restoring or moving the deployment cannot erase them:
 *
 * - `.deployment-mutation-lock/` is held (an exclusive `mkdir`) for a whole
 *   transaction. Its `owner` file names who holds it (`kind=update` or
 *   `kind=capability`/`uninstall`/...). It is never removed automatically: a
 *   lock left by an interrupted writer is an operator recovery case.
 * - `.lifecycle-state.json` is the installer's journal of a capability or
 *   uninstall transaction. Anything but a settled status blocks updates
 *   until `install.sh recover` (or `resume` after an uninstall) settles it.
 *
 * The installer (Bash) writes the same files with the same meaning; keep
 * both sides in step. Release metadata advertises the contract as
 * `lifecycleProtocol: 1`.
 */

export const DEPLOYMENT_MUTATION_LOCK = ".deployment-mutation-lock";
export const LIFECYCLE_STATE_FILE = ".lifecycle-state.json";
export const LIFECYCLE_PROTOCOL = 1;

/** Journal statuses after which another transaction may start. */
const SETTLED = new Set(["completed", "rolled-back", "recovered", "resumed"]);
const MAX_STATE_BYTES = 4096;

export type LifecycleBlocker =
  /** Another transaction holds the guard, or an interrupted one left it. */
  | "deployment_lifecycle_locked"
  /** A capability change or uninstall is unfinished, failed or uninstalled. */
  | "deployment_lifecycle_pending"
  /** The journal cannot be read: never assume it is settled. */
  | "deployment_lifecycle_unknown";

async function journalBlocker(
  updaterDirectory: string,
): Promise<LifecycleBlocker | undefined> {
  const file = path.join(updaterDirectory, LIFECYCLE_STATE_FILE);
  let raw: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
      return "deployment_lifecycle_unknown";
    }
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "deployment_lifecycle_unknown";
  }
  let status: unknown;
  try {
    const value = JSON.parse(raw) as {
      schemaVersion?: unknown;
      status?: unknown;
    };
    if (value?.schemaVersion !== 1) return "deployment_lifecycle_unknown";
    status = value.status;
  } catch {
    return "deployment_lifecycle_unknown";
  }
  return typeof status === "string" && SETTLED.has(status)
    ? undefined
    : "deployment_lifecycle_pending";
}

/** Why a new deployment transaction must not start now, if it must not. */
export async function lifecycleBlocker(
  updaterDirectory: string,
): Promise<LifecycleBlocker | undefined> {
  try {
    await fs.lstat(path.join(updaterDirectory, DEPLOYMENT_MUTATION_LOCK));
    return "deployment_lifecycle_locked";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "deployment_lifecycle_unknown";
    }
  }
  return journalBlocker(updaterDirectory);
}

/**
 * Hold the deployment guard for `action`. Refuses (throws the blocker code)
 * if the guard is held or the journal is unsettled. The guard is released
 * when `action` settles, unless it throws an error `keepGuard` says left the
 * deployment unrecovered: that, like a killed process, leaves the guard in
 * place for operator recovery.
 */
export async function withDeploymentMutationLock<T>(
  updaterDirectory: string,
  owner: { readonly kind: "update"; readonly id: string },
  action: () => Promise<T>,
  options: { readonly keepGuard?: (error: unknown) => boolean } = {},
): Promise<T> {
  const pending = await journalBlocker(updaterDirectory);
  if (pending) throw new Error(pending);
  const lock = path.join(updaterDirectory, DEPLOYMENT_MUTATION_LOCK);
  try {
    // Readable by the owner's installer, which runs as a normal user.
    await fs.mkdir(lock, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("deployment_lifecycle_locked");
    }
    throw error;
  }
  let keep = false;
  try {
    if (!/^[0-9a-f-]{36}$/u.test(owner.id)) {
      throw new Error("deployment_lifecycle_owner_invalid");
    }
    await fs.writeFile(
      path.join(lock, "owner"),
      `kind=${owner.kind}\nid=${owner.id}\nstarted=${Math.floor(Date.now() / 1000)}\n`,
      { mode: 0o644, flag: "wx" },
    );
    // Recheck under the guard: an installer may have journalled just before.
    const raced = await journalBlocker(updaterDirectory);
    if (raced) throw new Error(raced);
    try {
      return await action();
    } catch (error) {
      keep = options.keepGuard?.(error) === true;
      throw error;
    }
  } finally {
    if (!keep) {
      await fs.rm(path.join(lock, "owner"), { force: true });
      await fs.rmdir(lock).catch(() => undefined);
    }
  }
}
