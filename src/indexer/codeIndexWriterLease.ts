import * as fs from "node:fs";
import * as path from "node:path";

import { randomUUID } from "node:crypto";
import { withRetrievalStoreLock } from "../storage/retrieval/retrievalStoreLock.js";
import { writeAtomicJsonFile } from "./atomicJsonFile.js";

export const CODE_INDEX_WRITER_LEASE_VERSION = 1;
export const CODE_INDEX_WRITER_FENCED_ERROR = "code_index_writer_fenced";
export const CODE_INDEX_WRITER_BUSY_ERROR = "code_index_writer_busy";

const DEFAULT_STALE_MS = 15_000;

export interface CodeIndexWriterLease {
  storeRoot: string;
  workspaceScopeId: string;
  ownerId: string;
  ownerToken: string;
  fenceToken: string;
  protocolVersion: string;
}

export interface CodeIndexWriterLeaseOptions {
  staleMs?: number;
  now?: () => number;
  pid?: number;
  isOwnerAlive?: (pid: number) => boolean;
}

interface CodeIndexWriterLeaseState extends CodeIndexWriterLease {
  version: typeof CODE_INDEX_WRITER_LEASE_VERSION;
  status: "active" | "released";
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

export function getCodeIndexWriterLeasePath(storeRoot: string): string {
  return `${storeRoot}.writer-lease.json`;
}

export async function acquireCodeIndexWriterLease(args: {
  storeRoot: string;
  workspaceScopeId: string;
  ownerId: string;
  protocolVersion: string;
  options?: CodeIndexWriterLeaseOptions;
}): Promise<CodeIndexWriterLease> {
  const options = resolveOptions(args.options);
  return withRetrievalStoreLock(args.storeRoot, async () => {
    const statePath = getCodeIndexWriterLeasePath(args.storeRoot);
    const current = loadLeaseState(statePath);
    const now = options.now();
    if (
      current &&
      current.status === "active" &&
      current.ownerId !== args.ownerId &&
      now - current.heartbeatAt <= options.staleMs &&
      options.isOwnerAlive(current.pid)
    ) {
      throw new Error(CODE_INDEX_WRITER_BUSY_ERROR);
    }

    const nextFenceToken = nextFence(current?.fenceToken);
    const state: CodeIndexWriterLeaseState = {
      version: CODE_INDEX_WRITER_LEASE_VERSION,
      status: "active",
      storeRoot: normalizeStoreRoot(args.storeRoot),
      workspaceScopeId: requireNonEmpty(
        args.workspaceScopeId,
        "workspace scope ID",
      ),
      ownerId: requireNonEmpty(args.ownerId, "owner ID"),
      ownerToken: randomUUID(),
      fenceToken: nextFenceToken,
      protocolVersion: requireNonEmpty(
        args.protocolVersion,
        "protocol version",
      ),
      pid: options.pid,
      acquiredAt: now,
      heartbeatAt: now,
    };
    writeAtomicJsonFile(statePath, state);
    return toLease(state);
  });
}

export async function renewCodeIndexWriterLease(
  lease: CodeIndexWriterLease,
  options?: CodeIndexWriterLeaseOptions,
): Promise<void> {
  const resolved = resolveOptions(options);
  await withRetrievalStoreLock(lease.storeRoot, async () => {
    const statePath = getCodeIndexWriterLeasePath(lease.storeRoot);
    const current = requireCurrentLease(statePath, lease);
    writeAtomicJsonFile(statePath, {
      ...current,
      heartbeatAt: resolved.now(),
    });
  });
}

export async function releaseCodeIndexWriterLease(
  lease: CodeIndexWriterLease,
  options?: CodeIndexWriterLeaseOptions,
): Promise<void> {
  const resolved = resolveOptions(options);
  await withRetrievalStoreLock(lease.storeRoot, async () => {
    const statePath = getCodeIndexWriterLeasePath(lease.storeRoot);
    const current = requireCurrentLease(statePath, lease);
    writeAtomicJsonFile(statePath, {
      ...current,
      status: "released",
      heartbeatAt: resolved.now(),
    });
  });
}

export function assertCodeIndexWriterFenceCurrent(
  lease: CodeIndexWriterLease,
): void {
  requireCurrentLease(getCodeIndexWriterLeasePath(lease.storeRoot), lease);
}

export async function withCodeIndexWriterFence<T>(
  lease: CodeIndexWriterLease,
  operation: () => Promise<T>,
): Promise<T> {
  return withRetrievalStoreLock(lease.storeRoot, async () => {
    const statePath = getCodeIndexWriterLeasePath(lease.storeRoot);
    assertCodeIndexWriterFenceCurrent(lease);
    try {
      return await operation();
    } finally {
      const current = requireCurrentLease(statePath, lease);
      writeAtomicJsonFile(statePath, {
        ...current,
        heartbeatAt: Date.now(),
      });
    }
  });
}

function loadLeaseState(statePath: string): CodeIndexWriterLeaseState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("code_index_writer_lease_corrupt");
  }
  if (!isRecord(value) || value.version !== CODE_INDEX_WRITER_LEASE_VERSION) {
    throw new Error("code_index_writer_lease_corrupt");
  }
  if (value.status !== "active" && value.status !== "released") {
    throw new Error("code_index_writer_lease_corrupt");
  }
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error("code_index_writer_lease_corrupt");
  }
  if (
    !Number.isFinite(value.acquiredAt) ||
    !Number.isFinite(value.heartbeatAt)
  ) {
    throw new Error("code_index_writer_lease_corrupt");
  }
  const state: CodeIndexWriterLeaseState = {
    version: CODE_INDEX_WRITER_LEASE_VERSION,
    status: value.status,
    storeRoot: normalizeStoreRoot(
      requireNonEmpty(value.storeRoot, "store root"),
    ),
    workspaceScopeId: requireNonEmpty(
      value.workspaceScopeId,
      "workspace scope ID",
    ),
    ownerId: requireNonEmpty(value.ownerId, "owner ID"),
    ownerToken: requireNonEmpty(value.ownerToken, "owner token"),
    fenceToken: requireFence(value.fenceToken),
    protocolVersion: requireNonEmpty(value.protocolVersion, "protocol version"),
    pid: Number(value.pid),
    acquiredAt: Number(value.acquiredAt),
    heartbeatAt: Number(value.heartbeatAt),
  };
  return state;
}

function requireCurrentLease(
  statePath: string,
  lease: CodeIndexWriterLease,
): CodeIndexWriterLeaseState {
  const current = loadLeaseState(statePath);
  if (
    !current ||
    current.status !== "active" ||
    current.storeRoot !== normalizeStoreRoot(lease.storeRoot) ||
    current.workspaceScopeId !== lease.workspaceScopeId ||
    current.ownerId !== lease.ownerId ||
    current.ownerToken !== lease.ownerToken ||
    current.fenceToken !== lease.fenceToken ||
    current.protocolVersion !== lease.protocolVersion
  ) {
    throw new Error(CODE_INDEX_WRITER_FENCED_ERROR);
  }
  return current;
}

function toLease(state: CodeIndexWriterLeaseState): CodeIndexWriterLease {
  return {
    storeRoot: state.storeRoot,
    workspaceScopeId: state.workspaceScopeId,
    ownerId: state.ownerId,
    ownerToken: state.ownerToken,
    fenceToken: state.fenceToken,
    protocolVersion: state.protocolVersion,
  };
}

function nextFence(current: string | undefined): string {
  return (
    current === undefined ? 1n : BigInt(requireFence(current)) + 1n
  ).toString();
}

function requireFence(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("code_index_writer_lease_corrupt");
  }
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Code index writer lease ${label} is invalid`);
  }
  return value;
}

function normalizeStoreRoot(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "");
}

function resolveOptions(options: CodeIndexWriterLeaseOptions | undefined): {
  staleMs: number;
  now: () => number;
  pid: number;
  isOwnerAlive: (pid: number) => boolean;
} {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new Error("Code index writer lease staleMs must be positive");
  }
  const pid = options?.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Code index writer lease PID must be positive");
  }
  return {
    staleMs,
    now: options?.now ?? Date.now,
    pid,
    isOwnerAlive: options?.isOwnerAlive ?? isProcessAlive,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && "code" in error && String(error.code) === "EPERM";
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
