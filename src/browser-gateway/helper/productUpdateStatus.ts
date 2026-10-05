import type {
  HostReleaseUpdateStatus,
  ReleaseUpdateState,
} from "../../updates/releaseUpdateTypes.js";

import { randomUUID } from "crypto";

export interface PendingProductUpdateCheck {
  requestId: string;
  expiresAt: number;
  status: "checking" | "completed" | "expired";
}

export class ProductUpdateStatusStore {
  private readonly snapshots = new Map<string, HostReleaseUpdateStatus>();
  private readonly pending = new Map<string, PendingProductUpdateCheck>();

  publish(
    ownerId: string,
    generationId: string,
    state: ReleaseUpdateState,
    requestId?: string,
    now = Date.now(),
  ): HostReleaseUpdateStatus | undefined {
    if (!validReleaseUpdateState(state)) return undefined;
    this.expire(now);
    const key = this.key(ownerId, generationId);
    const pending = this.pending.get(key);
    if (
      pending &&
      pending.status === "expired" &&
      (pending.requestId === requestId ||
        (state.checkedAt ?? 0) <= pending.expiresAt)
    ) {
      return this.snapshots.get(key);
    }
    if (pending && requestId === pending.requestId) {
      pending.status = state.status === "checking" ? "checking" : "completed";
    }
    const status: HostReleaseUpdateStatus = {
      hostId: ownerId,
      generationId,
      state,
      ...(requestId
        ? { requestId }
        : pending?.status === "completed"
          ? { requestId: pending.requestId }
          : {}),
    };
    this.snapshots.set(key, status);
    this.expire(now);
    return status;
  }

  get(
    ownerId: string,
    generationId: string,
    now = Date.now(),
  ): HostReleaseUpdateStatus | undefined {
    this.expire(now);
    return this.snapshots.get(this.key(ownerId, generationId));
  }

  requestCheck(
    ownerId: string,
    generationId: string,
    now = Date.now(),
    ttlMs = 45_000,
  ): PendingProductUpdateCheck {
    this.expire(now);
    const key = this.key(ownerId, generationId);
    const existing = this.pending.get(key);
    if (existing && existing.status === "checking") return existing;
    const request: PendingProductUpdateCheck = {
      requestId: randomUUID(),
      expiresAt: now + ttlMs,
      status: "checking",
    };
    this.pending.set(key, request);
    return request;
  }

  getPending(
    ownerId: string,
    generationId: string,
    now = Date.now(),
  ): PendingProductUpdateCheck | undefined {
    this.expire(now);
    const request = this.pending.get(this.key(ownerId, generationId));
    return request?.status === "checking" ? request : undefined;
  }

  expire(now = Date.now()): void {
    for (const [key, request] of this.pending) {
      if (request.expiresAt <= now && request.status === "checking") {
        request.status = "expired";
        const snapshot = this.snapshots.get(key);
        if (snapshot) {
          this.snapshots.set(key, {
            ...snapshot,
            requestId: request.requestId,
            state: { ...snapshot.state, status: "unavailable", stale: true },
          });
        }
      }
      if (request.status !== "checking" && request.expiresAt + 45_000 <= now) {
        this.pending.delete(key);
      }
    }
  }

  removeOwner(ownerId: string, generationId?: string): void {
    const prefix = `${ownerId}\u0000`;
    for (const key of this.snapshots.keys()) {
      if (
        key.startsWith(prefix) &&
        (!generationId || key === this.key(ownerId, generationId))
      ) {
        this.snapshots.delete(key);
        this.pending.delete(key);
      }
    }
  }

  private key(ownerId: string, generationId: string): string {
    return `${ownerId}\u0000${generationId}`;
  }
}

export function validReleaseUpdateState(
  value: unknown,
): value is ReleaseUpdateState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ReleaseUpdateState>;
  const identity = state.identity;
  if (
    !identity ||
    !["vscode", "desktop", "cli"].includes(identity.product) ||
    typeof identity.version !== "string" ||
    typeof identity.target !== "string" ||
    typeof identity.development !== "boolean" ||
    (identity.hostLabel !== undefined &&
      typeof identity.hostLabel !== "string") ||
    (identity.vscodeVersion !== undefined &&
      typeof identity.vscodeVersion !== "string") ||
    ![
      "idle",
      "checking",
      "available",
      "current",
      "unavailable",
      "rate_limited",
      "unsupported",
      "metadata_unavailable",
    ].includes(state.status ?? "") ||
    typeof state.automaticChecks !== "boolean" ||
    typeof state.stale !== "boolean" ||
    ![state.lastAttemptAt, state.checkedAt, state.retryAt].every(
      (time) =>
        time === null || (typeof time === "number" && Number.isFinite(time)),
    )
  ) {
    return false;
  }
  if (state.candidate === undefined) return false;
  if (state.candidate !== null) {
    const candidate = state.candidate;
    if (
      typeof candidate.version !== "string" ||
      typeof candidate.tag !== "string" ||
      !["stable", "preview"].includes(candidate.channel) ||
      typeof candidate.target !== "string" ||
      !isReleaseUrl(candidate.releaseUrl) ||
      !isReleaseUrl(candidate.instructionsUrl)
    ) {
      return false;
    }
  }
  return (
    state.dismissedVersion === null ||
    typeof state.dismissedVersion === "string"
  );
}

function isReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/reefbarman/agentlink/")
    );
  } catch {
    return false;
  }
}
