import * as fs from "fs";
import * as path from "path";

import { writeAtomicJsonFile } from "./atomicJsonFile.js";

export const COLLECTION_RESET_STATE_VERSION = 1;

export interface CollectionResetTarget {
  qdrantUrl: string;
  collectionName: string;
}

export interface CollectionResetState extends CollectionResetTarget {
  version: typeof COLLECTION_RESET_STATE_VERSION;
  status: "in-progress" | "complete";
}

export type CollectionResetLoadResult =
  | { status: "missing" }
  | { status: "valid"; state: CollectionResetState }
  | { status: "corrupt"; error: string };

export function getCollectionResetStatePath(cachePath: string): string {
  const extension = path.extname(cachePath);
  if (!extension) return `${cachePath}.reset.json`;
  return path.join(
    path.dirname(cachePath),
    `${path.basename(cachePath, extension)}.reset${extension}`,
  );
}

export function loadCollectionResetState(
  statePath: string,
): CollectionResetLoadResult {
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
      value.version !== COLLECTION_RESET_STATE_VERSION ||
      (value.status !== "in-progress" && value.status !== "complete") ||
      typeof value.qdrantUrl !== "string" ||
      value.qdrantUrl.length === 0 ||
      typeof value.collectionName !== "string" ||
      value.collectionName.length === 0
    ) {
      throw new Error("Unsupported or malformed collection reset state");
    }
    return {
      status: "valid",
      state: {
        version: COLLECTION_RESET_STATE_VERSION,
        status: value.status,
        qdrantUrl: value.qdrantUrl,
        collectionName: value.collectionName,
      },
    };
  } catch (error) {
    return { status: "corrupt", error: describeError(error) };
  }
}

export function beginCollectionReset(
  statePath: string,
  target: CollectionResetTarget,
): void {
  writeAtomicJsonFile(statePath, {
    version: COLLECTION_RESET_STATE_VERSION,
    status: "in-progress",
    ...target,
  } satisfies CollectionResetState);
}

export function completeCollectionReset(
  statePath: string,
  target: CollectionResetTarget,
): void {
  writeAtomicJsonFile(statePath, {
    version: COLLECTION_RESET_STATE_VERSION,
    status: "complete",
    ...target,
  } satisfies CollectionResetState);
}

function inspectMissingEntry(entryPath: string): string | null {
  try {
    fs.lstatSync(entryPath);
    return "Collection reset state path exists but could not be read";
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
