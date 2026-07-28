import * as fs from "fs";

import {
  LanceDbRetrievalRepository,
  RETRIEVAL_STORE_MARKER,
} from "../storage/retrieval/LanceDbRetrievalRepository.js";
import type {
  RetrievalFingerprintDisposition,
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
} from "../core/retrieval/contracts.js";

import { getCodeRetrievalStoreRoot } from "./codeRetrievalIdentity.js";

export interface CodeRetrievalHealthProviderOptions {
  globalStoragePath: string;
  enabled: boolean;
  getWorkspaceRoots: () => string[];
}

export function createCodeRetrievalHealthProvider(
  options: CodeRetrievalHealthProviderOptions,
): { health(): Promise<RetrievalHealthSnapshot> } {
  return {
    async health() {
      if (!options.enabled) return disabledHealth();
      const workspaceRoots = options.getWorkspaceRoots();
      if (workspaceRoots.length === 0) return unavailableHealth("no_workspace");

      const snapshots = await Promise.all(
        workspaceRoots.map(async (workspaceRoot) => {
          const storeRoot = getCodeRetrievalStoreRoot(
            options.globalStoragePath,
            workspaceRoot,
          );
          if (!fs.existsSync(`${storeRoot}/${RETRIEVAL_STORE_MARKER}`))
            return unavailableHealth("missing_index");

          const repository = new LanceDbRetrievalRepository({
            root: storeRoot,
          });
          try {
            return await repository.health();
          } catch {
            return unavailableHealth("store_unavailable");
          } finally {
            await repository.close().catch(() => undefined);
          }
        }),
      );
      return aggregateHealth(snapshots);
    },
  };
}

function aggregateHealth(
  snapshots: RetrievalHealthSnapshot[],
): RetrievalHealthSnapshot {
  const reasons = unique(snapshots.flatMap((snapshot) => snapshot.reasons));
  const status = snapshots.some((snapshot) => snapshot.status === "unavailable")
    ? "unavailable"
    : snapshots.some((snapshot) => snapshot.status === "degraded")
      ? "degraded"
      : snapshots.every((snapshot) => snapshot.status === "disabled")
        ? "disabled"
        : snapshots.some((snapshot) => snapshot.status === "disabled")
          ? "degraded"
          : "ready";
  const reason =
    snapshots.find((snapshot) => snapshot.reason !== undefined)?.reason ??
    reasons[0];

  return {
    status,
    lexical: everyCapability(snapshots, "lexical", "ready")
      ? "ready"
      : "unavailable",
    scalar: everyCapability(snapshots, "scalar", "ready")
      ? "ready"
      : "unavailable",
    vector: snapshots.every((snapshot) => snapshot.vector === "not_configured")
      ? "not_configured"
      : everyCapability(snapshots, "vector", "ready")
        ? "ready"
        : "unavailable",
    structural: everyCapability(snapshots, "structural", "ready")
      ? "ready"
      : "unavailable",
    embeddingCredentials: snapshots.some(
      (snapshot) => snapshot.embeddingCredentials === "missing",
    )
      ? "missing"
      : snapshots.every(
            (snapshot) => snapshot.embeddingCredentials === "not_required",
          )
        ? "not_required"
        : "available",
    ...(reason ? { reason } : {}),
    reasons,
    fingerprintDisposition: aggregateFingerprintDisposition(snapshots),
    pendingPublications: sum(snapshots, "pendingPublications"),
    sourceCount: sum(snapshots, "sourceCount"),
    chunkCount: sum(snapshots, "chunkCount"),
    relationCount: sum(snapshots, "relationCount"),
    staleSourceCount: sum(snapshots, "staleSourceCount"),
  };
}

function disabledHealth(): RetrievalHealthSnapshot {
  return {
    ...unavailableHealth("disabled"),
    status: "disabled",
  };
}

function unavailableHealth(
  reason: RetrievalHealthReason,
): RetrievalHealthSnapshot {
  return {
    status: "unavailable",
    lexical: "unavailable",
    scalar: "unavailable",
    vector: "not_configured",
    structural: "unavailable",
    embeddingCredentials: "not_required",
    reason,
    reasons: [reason],
    fingerprintDisposition: "initialize",
    pendingPublications: 0,
    sourceCount: 0,
    chunkCount: 0,
    relationCount: 0,
    staleSourceCount: 0,
  };
}

function everyCapability<
  K extends "lexical" | "scalar" | "vector" | "structural",
>(
  snapshots: RetrievalHealthSnapshot[],
  key: K,
  expected: RetrievalHealthSnapshot[K],
): boolean {
  return snapshots.every((snapshot) => snapshot[key] === expected);
}

function aggregateFingerprintDisposition(
  snapshots: RetrievalHealthSnapshot[],
): RetrievalFingerprintDisposition {
  const order: RetrievalFingerprintDisposition[] = [
    "rebuild_required",
    "initialize",
    "compatible",
  ];
  return (
    order.find((candidate) =>
      snapshots.some(
        (snapshot) => snapshot.fingerprintDisposition === candidate,
      ),
    ) ?? "initialize"
  );
}

function sum(
  snapshots: RetrievalHealthSnapshot[],
  key:
    | "pendingPublications"
    | "sourceCount"
    | "chunkCount"
    | "relationCount"
    | "staleSourceCount",
): number {
  return snapshots.reduce((total, snapshot) => total + snapshot[key], 0);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
