import * as fs from "fs";
import * as path from "path";

import { writeAtomicJsonFile } from "./atomicJsonFile.js";

export const INDEX_RESET_STATE_VERSION = 1;

export interface IndexResetTarget {
  storeRoot: string;
  workspaceScopeId: string;
}

export interface IndexResetState {
  version: typeof INDEX_RESET_STATE_VERSION;
  status: "in-progress" | "complete";
  target: IndexResetTarget;
}

export type IndexResetLoadResult =
  | { status: "missing" }
  | { status: "valid"; state: IndexResetState }
  | { status: "corrupt"; error: string };

export function getIndexResetStatePath(cachePath: string): string {
  const extension = path.extname(cachePath);
  if (!extension) return `${cachePath}.reset.json`;
  return path.join(
    path.dirname(cachePath),
    `${path.basename(cachePath, extension)}.reset${extension}`,
  );
}

export function loadIndexResetState(statePath: string): IndexResetLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      const entryError = inspectMissingEntry(statePath);
      return entryError === null
        ? { status: "missing" }
        : { status: "corrupt", error: entryError };
    }
    return { status: "corrupt", error: describeError(error) };
  }

  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.version !== INDEX_RESET_STATE_VERSION ||
      (value.status !== "in-progress" && value.status !== "complete")
    ) {
      throw new Error("Unsupported or malformed index reset state");
    }
    const target = readTarget(value);
    return {
      status: "valid",
      state: {
        version: INDEX_RESET_STATE_VERSION,
        status: value.status,
        target,
      },
    };
  } catch (error) {
    return { status: "corrupt", error: describeError(error) };
  }
}

export function beginIndexReset(
  statePath: string,
  target: IndexResetTarget,
): void {
  writeResetState(statePath, "in-progress", target);
}

export function completeIndexReset(
  statePath: string,
  target: IndexResetTarget,
): void {
  writeResetState(statePath, "complete", target);
}

function readTarget(value: Record<string, unknown>): IndexResetTarget {
  const canonical = readCanonicalTarget(value);
  const legacy = readLegacyTarget(value);
  if (!canonical && !legacy) {
    throw new Error("Index reset state target is missing");
  }
  if (
    canonical &&
    legacy &&
    (normalizeStoreRoot(canonical.storeRoot) !==
      normalizeStoreRoot(legacy.storeRoot) ||
      canonical.workspaceScopeId !== legacy.workspaceScopeId)
  ) {
    throw new Error("Index reset state target aliases conflict");
  }
  return canonical ?? legacy!;
}

function readCanonicalTarget(
  value: Record<string, unknown>,
): IndexResetTarget | null {
  if (!("target" in value)) return null;
  if (!isRecord(value.target)) {
    throw new Error("Index reset state canonical target is malformed");
  }
  const current = readOptionalTargetFields(
    value.target,
    "storeRoot",
    "workspaceScopeId",
    "canonical",
  );
  const previous = readOptionalTargetFields(
    value.target,
    "endpoint",
    "indexName",
    "previous canonical",
  );
  if (!current && !previous) {
    throw new Error("Index reset state canonical target is malformed");
  }
  if (
    current &&
    previous &&
    (normalizeStoreRoot(current.storeRoot) !==
      normalizeStoreRoot(previous.storeRoot) ||
      current.workspaceScopeId !== previous.workspaceScopeId)
  ) {
    throw new Error("Index reset state canonical target aliases conflict");
  }
  return current ?? previous;
}

function readLegacyTarget(
  value: Record<string, unknown>,
): IndexResetTarget | null {
  const hasEndpoint = "qdrantUrl" in value;
  const hasIndexName = "collectionName" in value;
  if (!hasEndpoint && !hasIndexName) return null;
  if (!hasEndpoint || !hasIndexName) {
    throw new Error("Index reset state legacy target is malformed");
  }
  return readTargetFields(value, "qdrantUrl", "collectionName", "legacy");
}

function readTargetFields(
  value: Record<string, unknown>,
  endpointField: string,
  indexNameField: string,
  label: string,
): IndexResetTarget {
  const storeRoot = value[endpointField];
  const workspaceScopeId = value[indexNameField];
  if (
    typeof storeRoot !== "string" ||
    storeRoot.length === 0 ||
    typeof workspaceScopeId !== "string" ||
    workspaceScopeId.length === 0
  ) {
    throw new Error(`Index reset state ${label} target is malformed`);
  }
  return { storeRoot, workspaceScopeId };
}

function readOptionalTargetFields(
  value: Record<string, unknown>,
  storeRootField: string,
  workspaceScopeIdField: string,
  label: string,
): IndexResetTarget | null {
  const hasStoreRoot = storeRootField in value;
  const hasWorkspaceScopeId = workspaceScopeIdField in value;
  if (!hasStoreRoot && !hasWorkspaceScopeId) return null;
  if (!hasStoreRoot || !hasWorkspaceScopeId) {
    throw new Error(`Index reset state ${label} target is malformed`);
  }
  return readTargetFields(value, storeRootField, workspaceScopeIdField, label);
}

function writeResetState(
  statePath: string,
  status: IndexResetState["status"],
  target: IndexResetTarget,
): void {
  writeAtomicJsonFile(statePath, {
    version: INDEX_RESET_STATE_VERSION,
    status,
    target,
  });
}

function normalizeStoreRoot(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function inspectMissingEntry(entryPath: string): string | null {
  try {
    fs.lstatSync(entryPath);
    return "Index reset state path exists but could not be read";
  } catch (error) {
    return isMissingFile(error) ? null : describeError(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
