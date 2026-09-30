import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  CODE_RETRIEVAL_STORES_DIRECTORY,
  getCodeWorkspaceScopeId,
} from "./codeRetrievalIdentity.js";

import { canonicalizePath } from "../util/canonicalPath.js";
import { connect } from "@lancedb/lancedb";
import { getCodeIndexWriterLeasePath } from "./codeIndexWriterLease.js";
import { withRetrievalStoreLock } from "../storage/retrieval/retrievalStoreLock.js";

const STORE_ID_PATTERN = /^workspace-[a-f0-9]{24}$/;
const MAX_SIZE_ENTRIES = 1_000_000;
const MAX_SIZE_DEPTH = 64;
const OPTIMIZE_RETENTION_MS = 60 * 60 * 1_000;

export interface IndexStorageEntry {
  id: string;
  storeRoot: string;
  workspaceRoot?: string;
  bytes: number;
  blockedReason?: string;
}

interface WorkspaceMetadata {
  version: 1;
  workspaceRoot: string;
}

export async function listIndexStorage(
  globalStoragePath: string,
  knownWorkspaceRoots: string[],
): Promise<IndexStorageEntry[]> {
  const generationRoot = path.join(
    globalStoragePath,
    CODE_RETRIEVAL_STORES_DIRECTORY,
  );
  const stores = await fs
    .readdir(generationRoot, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const knownRootsById = new Map(
    knownWorkspaceRoots.map((root) => [storeIdForRoot(root), root]),
  );
  const results: IndexStorageEntry[] = [];
  for (const item of stores) {
    if (!STORE_ID_PATTERN.test(item.name) || item.isSymbolicLink()) continue;
    const storeRoot = path.join(generationRoot, item.name);
    try {
      const stat = await fs.lstat(storeRoot);
      if (!stat.isDirectory()) continue;
      const workspaceRoot = await readWorkspaceRoot(
        storeRoot,
        knownRootsById.get(item.name),
      );
      const bytes = await measureTree(storeRoot);
      const metadataStat = await fs
        .lstat(`${storeRoot}.workspace.json`)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      const metadataBytes = metadataStat?.isFile() ? metadataStat.size : 0;
      const identity = await inspectStore(
        globalStoragePath,
        item.name,
        knownWorkspaceRoots,
      );
      results.push({
        id: item.name,
        storeRoot,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        bytes: bytes + metadataBytes,
        ...(identity.blockedReason
          ? { blockedReason: identity.blockedReason }
          : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return results.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
}

export async function removeIndexStorage(
  globalStoragePath: string,
  entryId: string,
  protectedWorkspaceRoots: string[],
): Promise<void> {
  const storeRoot = resolveStoreRoot(globalStoragePath, entryId);
  await assertNoSymlinkPath(globalStoragePath, storeRoot);
  return withRetrievalStoreLock(storeRoot, async () => {
    const identity = await inspectStore(
      globalStoragePath,
      entryId,
      protectedWorkspaceRoots,
    );
    if (identity.blockedReason) throw new Error(identity.blockedReason);
    const cachePaths = await matchingCachePaths(globalStoragePath, entryId);
    for (const cachePath of cachePaths.sort((a, b) => {
      const vectorCache = (value: string) => /[a-f0-9]{16}\.json$/.test(value);
      return Number(vectorCache(b)) - Number(vectorCache(a));
    })) {
      await fs.rm(cachePath, { force: true });
    }
    await fs.rm(`${storeRoot}.workspace.json`, { force: true });
    await fs.rm(storeRoot, { recursive: true, force: false });
  });
}

export async function maintainIndexStorage(
  globalStoragePath: string,
  entryId: string,
  protectedWorkspaceRoots: string[],
): Promise<{ bytesReclaimed?: number }> {
  const storeRoot = resolveStoreRoot(globalStoragePath, entryId);
  await assertNoSymlinkPath(globalStoragePath, storeRoot);
  return withRetrievalStoreLock(storeRoot, async () => {
    const identity = await inspectStore(
      globalStoragePath,
      entryId,
      protectedWorkspaceRoots,
    );
    if (identity.blockedReason) throw new Error(identity.blockedReason);
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    const tables: Awaited<
      ReturnType<Awaited<ReturnType<typeof connect>>["openTable"]>
    >[] = [];
    try {
      connection = await connect(storeRoot);
      for (const name of await connection.tableNames())
        tables.push(await connection.openTable(name));
      let bytesReclaimed = 0;
      for (const table of tables) {
        const outcome = await table.optimize({
          cleanupOlderThan: new Date(Date.now() - OPTIMIZE_RETENTION_MS),
          deleteUnverified: false,
        });
        bytesReclaimed += outcome.prune.bytesRemoved;
      }
      return bytesReclaimed > 0 ? { bytesReclaimed } : {};
    } finally {
      for (const table of tables) table.close();
      await connection?.close();
    }
  });
}

async function inspectStore(
  globalStoragePath: string,
  entryId: string,
  protectedWorkspaceRoots: string[],
): Promise<{ workspaceRoot?: string; blockedReason?: string }> {
  const storeRoot = resolveStoreRoot(globalStoragePath, entryId);
  await assertNoSymlinkPath(globalStoragePath, storeRoot);
  const stat = await fs.lstat(storeRoot);
  if (!stat.isDirectory()) throw new Error("index_storage_not_directory");
  const knownRoot = protectedWorkspaceRoots.find(
    (root) => storeIdForRoot(root) === entryId,
  );
  const metadata = await readWorkspaceMetadata(storeRoot);

  if (
    metadata === "invalid" ||
    (metadata && knownRoot && canonical(metadata) !== canonical(knownRoot))
  ) {
    return { blockedReason: "index_storage_unknown_identity" };
  }
  const workspaceRoot =
    metadata && metadata !== "invalid" ? metadata : knownRoot;
  if (metadata && storeIdForRoot(metadata) !== entryId) {
    return {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      blockedReason: "index_storage_unknown_identity",
    };
  }

  const protectedIds = new Set(protectedWorkspaceRoots.map(storeIdForRoot));
  if (
    protectedIds.has(entryId) ||
    (workspaceRoot &&
      protectedWorkspaceRoots.some(
        (root) => canonical(root) === canonical(workspaceRoot),
      ))
  ) {
    return {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      blockedReason: "index_storage_protected",
    };
  }
  const leasePath = getCodeIndexWriterLeasePath(storeRoot);
  const lease = await readLease(leasePath);
  if (lease === "invalid")
    return {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      blockedReason: "index_storage_invalid_lease",
    };
  if (lease && lease.status === "active" && isProcessAlive(lease.pid)) {
    return {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      blockedReason: "index_storage_writer_active",
    };
  }
  return workspaceRoot ? { workspaceRoot } : {};
}

function resolveStoreRoot(globalStoragePath: string, entryId: string): string {
  if (!STORE_ID_PATTERN.test(entryId))
    throw new Error("index_storage_invalid_id");
  return path.join(globalStoragePath, CODE_RETRIEVAL_STORES_DIRECTORY, entryId);
}

function storeIdForRoot(workspaceRoot: string): string {
  return getCodeWorkspaceScopeId(workspaceRoot).replace(":", "-");
}

function canonical(value: string): string {
  return canonicalizePath(value);
}

async function readWorkspaceMetadata(
  storeRoot: string,
): Promise<string | undefined | "invalid"> {
  const metadataPath = `${storeRoot}.workspace.json`;
  let raw: string;
  try {
    const stat = await fs.lstat(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return "invalid";
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "invalid";
  }
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceMetadata>;
    return value.version === 1 &&
      typeof value.workspaceRoot === "string" &&
      value.workspaceRoot
      ? value.workspaceRoot
      : "invalid";
  } catch {
    return "invalid";
  }
}

async function readWorkspaceRoot(
  storeRoot: string,
  knownRoot: string | undefined,
): Promise<string | undefined> {
  if (knownRoot) return knownRoot;
  const metadataPath = `${storeRoot}.workspace.json`;
  let raw: string;
  try {
    const stat = await fs.lstat(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceMetadata>;
    if (
      value.version !== 1 ||
      typeof value.workspaceRoot !== "string" ||
      !value.workspaceRoot
    )
      return undefined;
    return value.workspaceRoot;
  } catch {
    return undefined;
  }
}

async function measureTree(root: string): Promise<number> {
  let bytes = 0;
  let entries = 0;
  const pending: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > MAX_SIZE_DEPTH)
      throw new Error("index_storage_size_depth_exceeded");
    for (const item of await fs.readdir(current.directory, {
      withFileTypes: true,
    })) {
      if (++entries > MAX_SIZE_ENTRIES)
        throw new Error("index_storage_size_entry_limit_exceeded");
      const fullPath = path.join(current.directory, item.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory())
        pending.push({ directory: fullPath, depth: current.depth + 1 });
      else if (stat.isFile()) bytes += stat.size;
    }
  }
  return bytes;
}

async function assertNoSymlinkPath(
  base: string,
  target: string,
): Promise<void> {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("index_storage_path_outside_root");
  let current = path.resolve(base);
  for (const segment of ["", ...relative.split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("index_storage_symlink_path");
  }
}

async function readLease(
  leasePath: string,
): Promise<{ status: string; pid: number } | null | "invalid"> {
  let raw: string;
  try {
    const stat = await fs.lstat(leasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return "invalid";
    raw = await fs.readFile(leasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "invalid";
  }
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      status?: unknown;
      pid?: unknown;
      storeRoot?: unknown;
      ownerId?: unknown;
      ownerToken?: unknown;
      workspaceScopeId?: unknown;
      protocolVersion?: unknown;
      fenceToken?: unknown;
      acquiredAt?: unknown;
      heartbeatAt?: unknown;
    };
    if (
      value.version !== 1 ||
      (value.status !== "active" && value.status !== "released") ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.ownerId !== "string" ||
      !value.ownerId ||
      typeof value.ownerToken !== "string" ||
      !value.ownerToken ||
      typeof value.workspaceScopeId !== "string" ||
      !value.workspaceScopeId ||
      typeof value.protocolVersion !== "string" ||
      !value.protocolVersion ||
      typeof value.fenceToken !== "string" ||
      !/^[1-9][0-9]*$/.test(value.fenceToken) ||
      !Number.isFinite(value.acquiredAt) ||
      !Number.isFinite(value.heartbeatAt) ||
      value.storeRoot !==
        path.resolve(
          path.dirname(leasePath),
          path.basename(leasePath).replace(/\.writer-lease\.json$/, ""),
        )
    )
      return "invalid";
    return { status: value.status, pid: Number(value.pid) };
  } catch {
    return "invalid";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function matchingCachePaths(
  globalStoragePath: string,
  entryId: string,
): Promise<string[]> {
  if (!STORE_ID_PATTERN.test(entryId))
    throw new Error("index_storage_invalid_id");
  const hash = entryId.slice("workspace-".length, "workspace-".length + 16);
  const cacheDirectory = path.join(globalStoragePath, "index-cache");
  const candidates = new Set<string>();
  try {
    await assertNoSymlinkPath(globalStoragePath, cacheDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = await fs
    .readdir(cacheDirectory)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  for (const name of names) {
    const match = /^al-(?:v[0-9]+-)?([a-f0-9]{16})(.*)$/.exec(name);
    if (!match || match[1] !== hash) continue;
    const suffix = match[2];
    if (
      ![".json", ".structural.json", ".journal.json", ".reset.json"].includes(
        suffix,
      )
    )
      continue;
    candidates.add(name);
  }
  const matches: string[] = [];
  for (const name of candidates) {
    const fullPath = path.join(cacheDirectory, name);
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isFile() && !stat.isSymbolicLink()) matches.push(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return matches;
}
