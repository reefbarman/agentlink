import type { WorkspaceProjectIdentity } from "./projectIdentity.js";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = "workspace-owners.json";
const LOCK_FILE = "workspace-owners.lock";
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5_000;
const SELF_PROCESS_START_IDENTITY = `node-process:${Math.round(
  Date.now() - process.uptime() * 1_000,
)}`;
const execFileAsync = promisify(execFile);

interface ProcessOwner {
  readonly ownerNonce: string;
  readonly hostname: string;
  readonly pid: number;
  readonly processStartIdentity?: string;
}

interface WorkspaceOwner extends ProcessOwner {
  readonly root: string;
  readonly filesystemIdentity: {
    readonly device: string;
    readonly inode: string;
  };
}

interface WorkspaceOwnersFile {
  readonly version: typeof REGISTRY_VERSION;
  readonly owners: readonly WorkspaceOwner[];
}

interface WorkspaceOwnersLock extends ProcessOwner {
  readonly version: typeof REGISTRY_VERSION;
}

export interface WorkspaceOwnershipHandle {
  readonly identity: WorkspaceProjectIdentity;
  readonly ownerNonce: string;
  release(): Promise<void>;
}

export class WorkspaceOwnershipConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceOwnershipConflictError";
  }
}

/**
 * Acquires exclusive CLI writer ownership for a canonical workspace identity.
 * The caller must release the returned handle when its session ends.
 */
export async function acquireWorkspaceOwnership(
  identity: WorkspaceProjectIdentity,
  dataRoot: string,
): Promise<WorkspaceOwnershipHandle> {
  assertAbsoluteDataRoot(dataRoot);
  assertCanonicalRoot(identity.root);
  await prepareDataRoot(dataRoot);

  const processOwner = await createProcessOwner();
  const lock = await acquireRegistryLock(dataRoot, processOwner);
  try {
    const registry = await readRegistry(dataRoot);
    const retainedOwners: WorkspaceOwner[] = [];

    for (const owner of registry.owners) {
      if (!workspaceIdentitiesConflict(identity, owner)) {
        retainedOwners.push(owner);
        continue;
      }

      const state = await resolveOwnerState(owner);
      if (state !== "dead") {
        throw new WorkspaceOwnershipConflictError(
          `Workspace writer ownership conflicts with ${owner.root} (${describeOwnerState(state)})`,
        );
      }
    }

    const owner: WorkspaceOwner = {
      ...processOwner,
      root: identity.root,
      filesystemIdentity: { ...identity.filesystemIdentity },
    };
    await publishRegistry(dataRoot, {
      version: REGISTRY_VERSION,
      owners: [...retainedOwners, owner],
    });
    let released = false;
    return {
      identity,
      ownerNonce: processOwner.ownerNonce,
      async release(): Promise<void> {
        if (released) return;
        const releaseLock = await acquireRegistryLock(
          dataRoot,
          await createProcessOwner(),
        );
        try {
          const current = await readRegistry(dataRoot);
          const owners = current.owners.filter(
            (candidate) => candidate.ownerNonce !== processOwner.ownerNonce,
          );
          if (owners.length !== current.owners.length) {
            await publishRegistry(dataRoot, {
              version: REGISTRY_VERSION,
              owners,
            });
          }
          released = true;
        } finally {
          await releaseRegistryLock(releaseLock);
        }
      },
    };
  } finally {
    await releaseRegistryLock(lock);
  }
}

function assertAbsoluteDataRoot(dataRoot: string): void {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("Workspace ownership dataRoot must be an absolute path");
  }
}

function assertCanonicalRoot(root: string): void {
  if (!path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new Error(
      "Workspace ownership requires a canonical absolute project root",
    );
  }
}

async function prepareDataRoot(dataRoot: string): Promise<void> {
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(dataRoot, 0o700);
}

async function createProcessOwner(): Promise<ProcessOwner> {
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  return {
    ownerNonce: randomUUID(),
    hostname: os.hostname(),
    pid: process.pid,
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
  };
}

interface HeldLock {
  readonly path: string;
  readonly ownerNonce: string;
}

async function acquireRegistryLock(
  dataRoot: string,
  owner: ProcessOwner,
): Promise<HeldLock> {
  const lockPath = path.join(dataRoot, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = await fs.open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        const lock: WorkspaceOwnersLock = {
          version: REGISTRY_VERSION,
          ...owner,
        };
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path: lockPath, ownerNonce: owner.ownerNonce };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }

    let existing: WorkspaceOwnersLock;
    try {
      existing = await readLock(lockPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    const state = await resolveOwnerState(existing);
    if (state === "dead") {
      await removeDeadLock(lockPath, existing.ownerNonce);
      continue;
    }
    if (state !== "live") {
      throw new WorkspaceOwnershipConflictError(
        `Workspace ownership registry is locked (${describeOwnerState(state)})`,
      );
    }
    if (Date.now() >= deadline) {
      throw new WorkspaceOwnershipConflictError(
        "Workspace ownership registry is locked by a live process",
      );
    }
    await delay(LOCK_RETRY_MS);
  }
}

async function readLock(lockPath: string): Promise<WorkspaceOwnersLock> {
  const text = await fs.readFile(lockPath, "utf8");
  const value: unknown = parseJson(text, "workspace ownership lock");
  if (!isProcessOwner(value) || value.version !== REGISTRY_VERSION) {
    throw new WorkspaceOwnershipConflictError(
      "Workspace ownership lock is invalid and cannot be safely recovered",
    );
  }
  return {
    version: REGISTRY_VERSION,
    ownerNonce: value.ownerNonce,
    hostname: value.hostname,
    pid: value.pid,
    ...(value.processStartIdentity === undefined
      ? {}
      : { processStartIdentity: value.processStartIdentity }),
  };
}

async function removeDeadLock(
  lockPath: string,
  expectedNonce: string,
): Promise<void> {
  let current: WorkspaceOwnersLock;
  try {
    current = await readLock(lockPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (current.ownerNonce !== expectedNonce) {
    throw new WorkspaceOwnershipConflictError(
      "Workspace ownership lock changed while being recovered",
    );
  }
  await fs.unlink(lockPath).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
}

async function releaseRegistryLock(lock: HeldLock): Promise<void> {
  let current: WorkspaceOwnersLock;
  try {
    current = await readLock(lock.path);
  } catch {
    return;
  }
  if (current.ownerNonce !== lock.ownerNonce) return;
  await fs.unlink(lock.path).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
  });
}

async function readRegistry(dataRoot: string): Promise<WorkspaceOwnersFile> {
  const registryPath = path.join(dataRoot, REGISTRY_FILE);
  let text: string;
  try {
    text = await fs.readFile(registryPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { version: REGISTRY_VERSION, owners: [] };
    }
    throw error;
  }

  const value: unknown = parseJson(text, "workspace ownership registry");
  if (!isWorkspaceOwnersFile(value)) {
    throw new WorkspaceOwnershipConflictError(
      "Workspace ownership registry is invalid and cannot be safely resolved",
    );
  }
  return value;
}

async function publishRegistry(
  dataRoot: string,
  registry: WorkspaceOwnersFile,
): Promise<void> {
  const destination = path.join(dataRoot, REGISTRY_FILE);
  const temporary = path.join(
    dataRoot,
    `.${REGISTRY_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
    await syncDirectory(dataRoot);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type OwnerState = "dead" | "live" | "foreign-host" | "ambiguous";

async function resolveOwnerState(owner: ProcessOwner): Promise<OwnerState> {
  if (owner.hostname !== os.hostname()) return "foreign-host";

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) return "dead";
    if (hasCode(error, "EPERM")) return "live";
    return "ambiguous";
  }

  if (owner.processStartIdentity === undefined) return "live";
  const observed = await readProcessStartIdentity(owner.pid);
  if (observed === undefined) return "ambiguous";
  if (
    processStartIdentityKind(observed) !==
    processStartIdentityKind(owner.processStartIdentity)
  ) {
    return "ambiguous";
  }
  return observed === owner.processStartIdentity ? "live" : "dead";
}

async function readProcessStartIdentity(
  pid: number,
): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const fields = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      return startTicks === undefined ? undefined : `linux-proc:${startTicks}`;
    } catch {
      return undefined;
    }
  }

  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const { stdout } = await execFileAsync("ps", [
        "-o",
        "lstart=",
        "-p",
        String(pid),
      ]);
      const started = stdout.trim();
      if (started.length > 0) return `${process.platform}-ps:${started}`;
    } catch {
      // Fall through to the self-process identity when available.
    }
  }

  return pid === process.pid ? SELF_PROCESS_START_IDENTITY : undefined;
}

function processStartIdentityKind(identity: string): string {
  const separator = identity.indexOf(":");
  return separator < 0 ? identity : identity.slice(0, separator);
}

function workspaceIdentitiesConflict(
  requested: WorkspaceProjectIdentity,
  existing: WorkspaceOwner,
): boolean {
  if (
    requested.filesystemIdentity.device ===
      existing.filesystemIdentity.device &&
    requested.filesystemIdentity.inode === existing.filesystemIdentity.inode
  ) {
    return true;
  }
  return rootsOverlap(requested.root, existing.root);
}

function rootsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isWorkspaceOwnersFile(value: unknown): value is WorkspaceOwnersFile {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION) return false;
  return Array.isArray(value.owners) && value.owners.every(isWorkspaceOwner);
}

function isWorkspaceOwner(value: unknown): value is WorkspaceOwner {
  return (
    isProcessOwner(value) &&
    typeof value.root === "string" &&
    path.isAbsolute(value.root) &&
    isRecord(value.filesystemIdentity) &&
    typeof value.filesystemIdentity.device === "string" &&
    typeof value.filesystemIdentity.inode === "string"
  );
}

function isProcessOwner(
  value: unknown,
): value is ProcessOwner & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.ownerNonce === "string" &&
    value.ownerNonce.length > 0 &&
    typeof value.hostname === "string" &&
    value.hostname.length > 0 &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    (value.processStartIdentity === undefined ||
      typeof value.processStartIdentity === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(text: string, description: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceOwnershipConflictError(
      `Invalid ${description} cannot be safely resolved`,
    );
  }
}

function describeOwnerState(state: Exclude<OwnerState, "dead">): string {
  switch (state) {
    case "live":
      return "owner process is live";
    case "foreign-host":
      return "owner belongs to another host";
    case "ambiguous":
      return "owner liveness is ambiguous";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
