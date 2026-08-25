import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import type {
  McpAuthEvent,
  McpAuthTelemetry,
} from "../telemetry/McpAuthTelemetry.js";

export type McpAuthMode = "interactive" | "noninteractive";

export type McpAuthTrigger =
  | "startup"
  | "config-watcher"
  | "config-mutation"
  | "plugin-refresh"
  | "ask-agent-refresh"
  | "runtime-reconnect"
  | "scheduled-retry"
  | "manual-reauth"
  | "manual-reconnect"
  | "tool-use";

export interface McpAuthorizationAttempt {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly serverIdentityHash: string;
  readonly trigger: McpAuthTrigger;
  readonly userInitiated: boolean;
  readonly authMode: McpAuthMode;
  readonly attemptId: string;
  readonly rootAttemptId: string;
  readonly parentAttemptId?: string;
  readonly retryCount: number;
  readonly hubScope?: string;
  readonly hubGeneration?: number;
  readonly tokenGenerationBefore: number;
}

export type McpAuthorizationBlockReason =
  | "blocked_manual_reauth"
  | "blocked_dialog_cap"
  | "blocked_active_lease"
  | "blocked_cooldown";

export interface McpAuthorizationLease {
  readonly outcome: "acquired" | "fail_open";
  readonly waitMs: number;
  complete(): Promise<void>;
}

export type McpAuthorizationDecision =
  | {
      readonly allowed: true;
      readonly dialogOpenCount: number;
      readonly lease: McpAuthorizationLease;
    }
  | {
      readonly allowed: false;
      readonly dialogOpenCount: number;
      readonly reason: McpAuthorizationBlockReason;
    };

export interface McpAuthCoordinatorOptions {
  readonly stateDirectory?: string;
  readonly instanceId?: string;
  readonly activeLeaseMs?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly telemetrySalt?: string;
  readonly log?: (message: string) => void;
}

interface LeaseRecord {
  readonly version: 1;
  readonly state: "active" | "cooldown";
  readonly ownerInstanceId: string;
  readonly ownerPid: number;
  readonly attemptId: string;
  readonly expiresAt: number;
}

const DEFAULT_ACTIVE_LEASE_MS = 6 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 90 * 1000;

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function loadTelemetrySalt(stateDirectory: string, fallback: string): string {
  const saltPath = path.join(stateDirectory, "telemetry-salt");
  try {
    fsSync.mkdirSync(stateDirectory, { recursive: true });
    try {
      fsSync.writeFileSync(saltPath, crypto.randomBytes(32).toString("hex"), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const salt = fsSync.readFileSync(saltPath, "utf8").trim();
    return salt || fallback;
  } catch {
    return fallback;
  }
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LeaseRecord>;
  return (
    record.version === 1 &&
    (record.state === "active" || record.state === "cooldown") &&
    typeof record.ownerInstanceId === "string" &&
    typeof record.ownerPid === "number" &&
    typeof record.attemptId === "string" &&
    typeof record.expiresAt === "number"
  );
}

export function mcpServerIdentityHash(
  serverName: string,
  serverUrl: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${serverName}\0${serverUrl}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Coordinates interactive MCP OAuth across every hub in one extension host and
 * across VS Code extension hosts via small atomic lease files.
 */
export class McpAuthCoordinator {
  private readonly stateDirectory: string;
  private readonly instanceId: string;
  private readonly activeLeaseMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly telemetrySalt: string;
  private readonly log?: (message: string) => void;
  private telemetry?: Pick<McpAuthTelemetry, "record">;
  private readonly manualReauthRequired = new Set<string>();
  private readonly dialogOpenCounts = new Map<string, number>();

  constructor(options: McpAuthCoordinatorOptions = {}) {
    this.stateDirectory =
      options.stateDirectory ??
      path.join(os.homedir(), ".agentlink", "mcp-auth");
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.activeLeaseMs = options.activeLeaseMs ?? DEFAULT_ACTIVE_LEASE_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.telemetrySalt =
      options.telemetrySalt ??
      loadTelemetrySalt(this.stateDirectory, this.instanceId);
    this.log = options.log;
  }

  setTelemetry(telemetry: Pick<McpAuthTelemetry, "record"> | undefined): void {
    this.telemetry = telemetry;
  }

  record(event: McpAuthEvent): void {
    this.telemetry?.record({
      ...event,
      ...(event.serverIdentityHash
        ? {
            serverIdentityHash: crypto
              .createHmac("sha256", this.telemetrySalt)
              .update(event.serverIdentityHash)
              .digest("hex")
              .slice(0, 24),
          }
        : {}),
    });
  }

  isManualReauthRequired(serverIdentityHash: string): boolean {
    return this.manualReauthRequired.has(serverIdentityHash);
  }

  requireManualReauth(serverIdentityHash: string): void {
    this.manualReauthRequired.add(serverIdentityHash);
  }

  clearManualReauth(serverIdentityHash: string): void {
    this.manualReauthRequired.delete(serverIdentityHash);
  }

  clearAttempt(attemptId: string): void {
    this.dialogOpenCounts.delete(attemptId);
  }

  async beforeBrowserOpen(
    request: Readonly<McpAuthorizationAttempt>,
  ): Promise<McpAuthorizationDecision> {
    if (
      !request.userInitiated &&
      this.manualReauthRequired.has(request.serverIdentityHash)
    ) {
      const decision = {
        allowed: false as const,
        dialogOpenCount: this.dialogOpenCounts.get(request.attemptId) ?? 0,
        reason: "blocked_manual_reauth" as const,
      };
      this.recordDecision(request, decision);
      return decision;
    }

    const current = this.dialogOpenCounts.get(request.attemptId) ?? 0;
    if (current >= 1) {
      this.manualReauthRequired.add(request.serverIdentityHash);
      this.dialogOpenCounts.delete(request.attemptId);
      const decision = {
        allowed: false as const,
        dialogOpenCount: current,
        reason: "blocked_dialog_cap" as const,
      };
      this.recordDecision(request, decision);
      return decision;
    }

    const next = current + 1;
    this.dialogOpenCounts.set(request.attemptId, next);
    const lease = await this.acquireLease(request);
    if (lease.allowed) {
      const decision = {
        allowed: true as const,
        dialogOpenCount: next,
        lease: lease.lease,
      };
      this.recordDecision(request, decision);
      return decision;
    }
    this.dialogOpenCounts.delete(request.attemptId);
    const decision = {
      allowed: false as const,
      dialogOpenCount: next,
      reason: lease.reason,
    };
    this.recordDecision(request, decision);
    return decision;
  }

  async readTokenGeneration(serverIdentityHash: string): Promise<number> {
    try {
      const raw = await fs.readFile(
        this.tokenGenerationPath(serverIdentityHash),
        "utf8",
      );
      const parsed = Number(raw.trim());
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log?.(
          `[mcp-auth] token generation read failed (${serverIdentityHash}): ${String(error)}`,
        );
      }
      return 0;
    }
  }

  async incrementTokenGeneration(serverIdentityHash: string): Promise<number> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    const lockPath = `${this.tokenGenerationPath(serverIdentityHash)}.lock`;
    const startedAt = this.now();
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              version: 1,
              ownerInstanceId: this.instanceId,
              ownerPid: process.pid,
              createdAt: this.now(),
            }),
          );
          const next = (await this.readTokenGeneration(serverIdentityHash)) + 1;
          const target = this.tokenGenerationPath(serverIdentityHash);
          const temporary = `${target}.${this.instanceId}.${process.pid}.tmp`;
          await fs.writeFile(temporary, String(next), { mode: 0o600 });
          await fs.rename(temporary, target);
          return next;
        } finally {
          await handle.close().catch(() => undefined);
          await fs.unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          this.log?.(
            `[mcp-auth] token generation increment failed (${serverIdentityHash}): ${String(error)}`,
          );
          return this.readTokenGeneration(serverIdentityHash);
        }
        const ownerPid = await this.readTokenLockOwnerPid(lockPath);
        if (ownerPid !== undefined && !this.isProcessAlive(ownerPid)) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (this.now() - startedAt >= 2_000) {
          this.log?.(
            `[mcp-auth] token generation increment timed out behind live lock (${serverIdentityHash})`,
          );
          return this.readTokenGeneration(serverIdentityHash);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  private async readTokenLockOwnerPid(
    lockPath: string,
  ): Promise<number | undefined> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (!value || typeof value !== "object") return undefined;
      const ownerPid = (value as { ownerPid?: unknown }).ownerPid;
      return Number.isInteger(ownerPid) && Number(ownerPid) > 0
        ? Number(ownerPid)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private recordDecision(
    request: Readonly<McpAuthorizationAttempt>,
    decision: McpAuthorizationDecision,
  ): void {
    const common = {
      serverName: request.serverName,
      serverIdentityHash: request.serverIdentityHash,
      trigger: request.trigger,
      authMode: request.authMode,
      userInitiated: request.userInitiated,
      attemptId: request.attemptId,
      rootAttemptId: request.rootAttemptId,
      parentAttemptId: request.parentAttemptId,
      hubScope: request.hubScope,
      hubGeneration: request.hubGeneration,
      retryCount: request.retryCount,
      dialogOpenCount: decision.dialogOpenCount,
      tokenGenerationBefore: request.tokenGenerationBefore,
    } as const;
    if (decision.allowed) {
      this.record({
        type: "lease_acquired",
        ...common,
        leaseOutcome:
          decision.lease.outcome === "acquired" ? "acquired" : "error",
        leaseWaitMs: decision.lease.waitMs,
        decisionReason:
          decision.lease.outcome === "acquired" ? "allowed" : "lease_error",
      });
      return;
    }
    this.record({
      type: "lease_contended",
      ...common,
      leaseOutcome:
        decision.reason === "blocked_active_lease" ? "contended" : "skipped",
      decisionReason:
        decision.reason === "blocked_active_lease"
          ? "blocked_lease"
          : decision.reason,
    });
    this.record({
      type: "browser_open_blocked",
      ...common,
      decisionReason:
        decision.reason === "blocked_active_lease"
          ? "blocked_lease"
          : decision.reason,
    });
  }

  private async acquireLease(
    request: Readonly<McpAuthorizationAttempt>,
  ): Promise<
    | { allowed: true; lease: McpAuthorizationLease }
    | {
        allowed: false;
        reason: "blocked_active_lease" | "blocked_cooldown";
      }
  > {
    const startedAt = this.now();
    const leasePath = this.leasePath(request.serverIdentityHash);
    try {
      await fs.mkdir(this.stateDirectory, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const record: LeaseRecord = {
          version: 1,
          state: "active",
          ownerInstanceId: this.instanceId,
          ownerPid: process.pid,
          attemptId: request.attemptId,
          expiresAt: this.now() + this.activeLeaseMs,
        };
        try {
          const handle = await fs.open(leasePath, "wx", 0o600);
          await handle.writeFile(JSON.stringify(record));
          await handle.close();
          return {
            allowed: true,
            lease: this.createLease(
              leasePath,
              request,
              "acquired",
              this.now() - startedAt,
            ),
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await this.readLeaseRecord(leasePath);
          if (!existing || this.isStale(existing)) {
            await fs.unlink(leasePath).catch(() => undefined);
            continue;
          }
          if (existing.state === "active") {
            return { allowed: false, reason: "blocked_active_lease" };
          }
          if (!request.userInitiated) {
            return { allowed: false, reason: "blocked_cooldown" };
          }
          await fs.unlink(leasePath).catch(() => undefined);
        }
      }
      return { allowed: false, reason: "blocked_active_lease" };
    } catch (error) {
      this.log?.(
        `[mcp-auth] lease acquisition failed open (${request.serverName}): ${String(error)}`,
      );
      return {
        allowed: true,
        lease: this.createLease(
          undefined,
          request,
          "fail_open",
          this.now() - startedAt,
        ),
      };
    }
  }

  private createLease(
    leasePath: string | undefined,
    request: Readonly<McpAuthorizationAttempt>,
    outcome: "acquired" | "fail_open",
    waitMs: number,
  ): McpAuthorizationLease {
    let completed = false;
    return {
      outcome,
      waitMs,
      complete: async () => {
        if (completed || !leasePath) return;
        completed = true;
        const existing = await this.readLeaseRecord(leasePath);
        if (
          !existing ||
          existing.ownerInstanceId !== this.instanceId ||
          existing.attemptId !== request.attemptId
        ) {
          return;
        }
        const cooldown: LeaseRecord = {
          ...existing,
          state: "cooldown",
          expiresAt: this.now() + this.cooldownMs,
        };
        const temporary = `${leasePath}.${this.instanceId}.${process.pid}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(cooldown), {
            mode: 0o600,
          });
          await fs.rename(temporary, leasePath);
        } catch (error) {
          await fs.unlink(temporary).catch(() => undefined);
          await fs.unlink(leasePath).catch(() => undefined);
          this.log?.(
            `[mcp-auth] lease cooldown write failed (${request.serverName}): ${String(error)}`,
          );
        }
      },
    };
  }

  private isStale(record: LeaseRecord): boolean {
    if (record.expiresAt <= this.now()) return true;
    return record.state === "active" && !this.isProcessAlive(record.ownerPid);
  }

  private async readLeaseRecord(
    leasePath: string,
  ): Promise<LeaseRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(leasePath, "utf8"));
      return isLeaseRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private leasePath(serverIdentityHash: string): string {
    return path.join(this.stateDirectory, `${serverIdentityHash}.lease.json`);
  }

  private tokenGenerationPath(serverIdentityHash: string): string {
    return path.join(this.stateDirectory, `${serverIdentityHash}.tokens`);
  }
}
