import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * Draining the server for an upgrade, and resuming it after.
 *
 * `agentlink-server drain` (on the server machine, as the account that owns
 * the data root, like `pair`) writes `<dataRoot>/maintenance/request.json`;
 * the running server notices within a second, stops admitting new work
 * (chat turns outside task chats, new or resumed tasks, scheduled and
 * manual job runs), waits for what is running, and reports progress in
 * `status.json`. At the deadline (15 minutes by default) it stops what is
 * left, recorded `interrupted` so it can be resumed. A server started while
 * the request exists starts drained, so the new version of an upgrade
 * stays drained until `agentlink-server resume` removes the request.
 */

export const MAINTENANCE_FOLDER = "maintenance";
const REQUEST_FILE = "request.json";
const STATUS_FILE = "status.json";
export const DEFAULT_DRAIN_WAIT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 1_000;
/** After stopping what was left, how long to wait for it to end. */
const DEFAULT_SETTLE_MS = 60_000;

export interface MaintenanceRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: "drain";
  /** Shown to the owner: "upgrade". */
  readonly reason: string;
  readonly requestedAt: number;
  /** How long to wait for running work before stopping it. */
  readonly waitMs: number;
}

export type MaintenanceState = "running" | "draining" | "drained";

export interface MaintenanceStatus {
  readonly schemaVersion: 1;
  readonly state: MaintenanceState;
  /** The drain request this status answers. */
  readonly requestId?: string;
  readonly reason?: string;
  readonly since: number;
  /** What the drain is waiting for, in words. */
  readonly waiting: readonly string[];
  /** What was stopped at the deadline, in words. */
  readonly interrupted: readonly string[];
}

export function maintenanceDirectory(dataRoot: string): string {
  return path.join(dataRoot, MAINTENANCE_FOLDER);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Torn or unreadable: treated as absent, never as a reason to stop.
    return undefined;
  }
}

export async function readMaintenanceRequest(
  dataRoot: string,
): Promise<MaintenanceRequest | undefined> {
  const value = await readJson(
    path.join(maintenanceDirectory(dataRoot), REQUEST_FILE),
  );
  if (!value || typeof value !== "object") return undefined;
  const request = value as Partial<MaintenanceRequest>;
  if (
    request.schemaVersion !== 1 ||
    request.kind !== "drain" ||
    typeof request.id !== "string" ||
    typeof request.requestedAt !== "number" ||
    typeof request.waitMs !== "number"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    id: request.id,
    kind: "drain",
    reason: typeof request.reason === "string" ? request.reason : "upgrade",
    requestedAt: request.requestedAt,
    waitMs: request.waitMs,
  };
}

export async function readMaintenanceStatus(
  dataRoot: string,
): Promise<MaintenanceStatus | undefined> {
  const value = await readJson(
    path.join(maintenanceDirectory(dataRoot), STATUS_FILE),
  );
  if (!value || typeof value !== "object") return undefined;
  const status = value as Partial<MaintenanceStatus>;
  if (
    status.schemaVersion !== 1 ||
    (status.state !== "running" &&
      status.state !== "draining" &&
      status.state !== "drained")
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    state: status.state,
    ...(typeof status.requestId === "string"
      ? { requestId: status.requestId }
      : {}),
    ...(typeof status.reason === "string" ? { reason: status.reason } : {}),
    since: typeof status.since === "number" ? status.since : 0,
    waiting: Array.isArray(status.waiting) ? status.waiting.map(String) : [],
    interrupted: Array.isArray(status.interrupted)
      ? status.interrupted.map(String)
      : [],
  };
}

export interface MaintenanceOptions {
  readonly dataRoot: string;
  /** What is running now, in words; the drain ends when this is empty. */
  readonly running: () => readonly string[];
  /** Stop what is running; returns what was stopped, in words. */
  readonly interrupt: (reason: string) => Promise<readonly string[]>;
  /** The server paused or resumed admitting work. */
  readonly onChanged?: (status: MaintenanceStatus) => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly settleMs?: number;
  readonly log?: (line: string) => void;
}

export interface Maintenance {
  /** Read the request on disk (paused before anything starts) and poll. */
  start(): Promise<void>;
  /** Whether new work is on hold. */
  paused(): boolean;
  status(): MaintenanceStatus;
  /** One poll (tests). */
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createMaintenance(options: MaintenanceOptions): Maintenance {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const directory = maintenanceDirectory(options.dataRoot);
  let status: MaintenanceStatus = {
    schemaVersion: 1,
    state: "running",
    since: now(),
    waiting: [],
    interrupted: [],
  };
  let request: MaintenanceRequest | undefined;
  let interruptedAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<void> | undefined;
  let closed = false;
  let written = "";

  const save = async (next: MaintenanceStatus) => {
    const changedState = next.state !== status.state;
    status = next;
    const text = `${JSON.stringify(next)}\n`;
    if (text !== written) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(path.join(directory, STATUS_FILE), text);
      written = text;
    }
    if (changedState) {
      try {
        options.onChanged?.(next);
      } catch {
        // A broken listener must not stop the drain.
      }
    }
  };

  const poll = async () => {
    const found = await readMaintenanceRequest(options.dataRoot);
    if (!found) {
      request = undefined;
      interruptedAt = undefined;
      if (status.state !== "running") {
        log("Resumed: new chats, tasks and scheduled runs start again");
        await save({
          schemaVersion: 1,
          state: "running",
          since: now(),
          waiting: [],
          interrupted: [],
        });
      }
      return;
    }
    if (found.id !== request?.id) {
      request = found;
      interruptedAt = undefined;
      // A restart while drained keeps what the earlier drain stopped.
      const previous = await readMaintenanceStatus(options.dataRoot);
      log(
        `Draining for ${found.reason}: new work waits; running work has until ${new Date(found.requestedAt + found.waitMs).toISOString()}`,
      );
      await save({
        schemaVersion: 1,
        state: "draining",
        requestId: found.id,
        reason: found.reason,
        since: now(),
        waiting: [],
        interrupted:
          previous?.requestId === found.id ? previous.interrupted : [],
      });
    }
    if (status.state !== "draining") return;
    const waiting = [...options.running()];
    const at = now();
    if (waiting.length === 0) {
      log("Drained: nothing is running");
      await save({ ...status, state: "drained", since: at, waiting: [] });
      return;
    }
    const deadline = found.requestedAt + found.waitMs;
    if (interruptedAt === undefined && at >= deadline) {
      interruptedAt = at;
      log(`Drain deadline: stopping ${waiting.length} running item(s)`);
      const stopped = await options.interrupt(found.reason);
      await save({
        ...status,
        waiting,
        interrupted: [...status.interrupted, ...stopped],
      });
      return;
    }
    if (interruptedAt !== undefined && at - interruptedAt >= settleMs) {
      // Whatever would not stop is recorded interrupted by the restart.
      log(`Drained, with ${waiting.length} item(s) still stopping`);
      await save({ ...status, state: "drained", since: at, waiting });
      return;
    }
    await save({ ...status, waiting });
  };

  const check = (): Promise<void> => {
    checking ??= poll()
      .catch((error: unknown) => {
        log(
          `Maintenance check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        checking = undefined;
      });
    return checking;
  };

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => {
      void check().finally(schedule);
    }, pollMs);
    timer.unref();
  };

  return {
    async start() {
      written =
        (await fs
          .readFile(path.join(directory, STATUS_FILE), "utf8")
          .catch(() => "")) ?? "";
      await check();
      schedule();
    },
    paused: () => request !== undefined,
    status: () => status,
    check,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await checking;
    },
  };
}

/** The CLI's side: `drain` and `resume`. */

export type DrainOutcome =
  | { readonly kind: "drained"; readonly status: MaintenanceStatus }
  | { readonly kind: "not_running" }
  | { readonly kind: "timed_out"; readonly status?: MaintenanceStatus };

export interface MaintenanceCommandOptions {
  readonly dataRoot: string;
  /** Progress lines for the terminal. */
  readonly report: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a running server to answer. */
  readonly ackTimeoutMs?: number;
  readonly pollMs?: number;
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask the server to drain and wait until it has. A request already on disk
 * is joined rather than replaced. Without a running server the request
 * stays, so the next start is drained.
 */
export async function requestDrain(
  options: MaintenanceCommandOptions & {
    readonly waitMs?: number;
    readonly reason?: string;
  },
): Promise<DrainOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const ackTimeoutMs = options.ackTimeoutMs ?? 15_000;
  const directory = maintenanceDirectory(options.dataRoot);
  let request = await readMaintenanceRequest(options.dataRoot);
  if (request) {
    options.report(
      `Already draining (since ${new Date(request.requestedAt).toISOString()}); waiting for it.`,
    );
  } else {
    request = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: "drain",
      reason: options.reason ?? "upgrade",
      requestedAt: now(),
      waitMs: options.waitMs ?? DEFAULT_DRAIN_WAIT_MS,
    };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      path.join(directory, REQUEST_FILE),
      `${JSON.stringify(request)}\n`,
    );
  }
  const started = now();
  // The server's own settling time after the deadline, plus a margin.
  const giveUpAt =
    request.requestedAt + request.waitMs + DEFAULT_SETTLE_MS + 120_000;
  let acknowledged = false;
  let lastWaiting = "";
  for (;;) {
    const status = await readMaintenanceStatus(options.dataRoot);
    if (status?.requestId === request.id) {
      acknowledged = true;
      if (status.state === "drained") return { kind: "drained", status };
      const waiting = status.waiting.join("; ");
      if (waiting && waiting !== lastWaiting) {
        options.report(`Waiting for: ${waiting}`);
      }
      lastWaiting = waiting;
    }
    if (!acknowledged && now() - started >= ackTimeoutMs) {
      return { kind: "not_running" };
    }
    if (now() >= giveUpAt) {
      return { kind: "timed_out", ...(status ? { status } : {}) };
    }
    await sleep(pollMs);
  }
}

/**
 * Lift the drain and wait for a running server to start admitting work
 * again. `not_draining` when there was nothing to lift.
 */
export async function requestResume(
  options: MaintenanceCommandOptions,
): Promise<"resumed" | "not_running" | "not_draining"> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const ackTimeoutMs = options.ackTimeoutMs ?? 15_000;
  const request = await readMaintenanceRequest(options.dataRoot);
  await fs.rm(path.join(maintenanceDirectory(options.dataRoot), REQUEST_FILE), {
    force: true,
  });
  const before = await readMaintenanceStatus(options.dataRoot);
  if (!request && (!before || before.state === "running")) {
    return "not_draining";
  }
  const started = now();
  for (;;) {
    const status = await readMaintenanceStatus(options.dataRoot);
    if (status?.state === "running") return "resumed";
    if (now() - started >= ackTimeoutMs) return "not_running";
    await sleep(pollMs);
  }
}
