import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { BrowserGatewayDiscoveryRecord } from "./browserGatewayDiscovery.js";
import type { BrowserGatewayThemeSnapshot } from "../shared/types.js";

const REGISTRY_DIR = path.join(os.homedir(), ".agentlink");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "browser-gateways.json");
const REGISTRY_LOCK_DIR = `${REGISTRY_PATH}.lock`;
const REGISTRY_LOCK_TIMEOUT_MS = 20_000;
const REGISTRY_STALE_LOCK_MS = 10_000;

let registryLog: ((message: string) => void) | undefined;

export function setBrowserGatewayRegistryLogger(
  log: ((message: string) => void) | undefined,
): void {
  registryLog = log;
}

function logRegistry(message: string): void {
  registryLog?.(`[browser-gateway-registry] ${message}`);
}

function summarizeRecord(record: BrowserGatewayInstanceRecord): string {
  return `${record.instanceId} pid=${record.pid} port=${record.port} workspace=${JSON.stringify(record.workspaceName)} path=${JSON.stringify(record.workspacePath)}`;
}

export interface BrowserGatewayInstanceRecord extends BrowserGatewayDiscoveryRecord {
  instanceId: string;
  workspaceName: string;
  workspacePath: string;
  theme?: BrowserGatewayThemeSnapshot;
}

export function getBrowserGatewayRegistryPath(): string {
  return REGISTRY_PATH;
}

async function readRegistry(): Promise<BrowserGatewayInstanceRecord[]> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as BrowserGatewayInstanceRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRegistry(
  records: BrowserGatewayInstanceRecord[],
): Promise<void> {
  await fs.mkdir(REGISTRY_DIR, { recursive: true });
  const tmpPath = `${REGISTRY_PATH}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(records, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, REGISTRY_PATH);
}

function isAlreadyExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code?: unknown }).code) === "EEXIST"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const deadline = startedAt + REGISTRY_LOCK_TIMEOUT_MS;
  let acquired = false;
  let loggedContention = false;

  await fs.mkdir(REGISTRY_DIR, { recursive: true });
  while (!acquired) {
    try {
      await fs.mkdir(REGISTRY_LOCK_DIR);
      acquired = true;
      const waitedMs = Date.now() - startedAt;
      if (waitedMs > 0 || loggedContention) {
        logRegistry(
          `lock acquired path=${REGISTRY_LOCK_DIR} waitedMs=${waitedMs}`,
        );
      }
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;

      try {
        const stat = await fs.stat(REGISTRY_LOCK_DIR);
        const ageMs = Date.now() - stat.mtimeMs;
        if (!loggedContention) {
          loggedContention = true;
          logRegistry(
            `lock contention path=${REGISTRY_LOCK_DIR} ageMs=${Math.round(ageMs)} timeoutMs=${REGISTRY_LOCK_TIMEOUT_MS} staleMs=${REGISTRY_STALE_LOCK_MS}`,
          );
        }
        if (ageMs > REGISTRY_STALE_LOCK_MS) {
          // Best-effort stale lock recovery. Registry operations are small
          // read/filter/write transactions, so a 10s lock age strongly implies
          // the owning extension host died rather than a live writer being slow.
          logRegistry(
            `removing stale lock path=${REGISTRY_LOCK_DIR} ageMs=${Math.round(ageMs)}`,
          );
          await fs.rm(REGISTRY_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between mkdir/stat/rm attempts. Retry below.
      }

      if (Date.now() >= deadline) {
        logRegistry(
          `lock timeout path=${REGISTRY_LOCK_DIR} waitedMs=${Date.now() - startedAt}`,
        );
        throw new Error("browser_gateway_registry_lock_timeout");
      }
      await sleep(50);
    }
  }

  try {
    return await operation();
  } finally {
    await fs.rm(REGISTRY_LOCK_DIR, { recursive: true, force: true });
  }
}

function isSameRegistryRecord(
  a: BrowserGatewayInstanceRecord,
  b: BrowserGatewayInstanceRecord,
): boolean {
  // These fields identify a specific running registration. Metadata like theme
  // or workspace name can change without making a stale cleanup target safer to
  // remove.
  return (
    a.instanceId === b.instanceId &&
    a.pid === b.pid &&
    a.port === b.port &&
    a.url === b.url &&
    a.startedAt === b.startedAt
  );
}

async function removeExactBrowserGatewayInstances(
  staleRecords: BrowserGatewayInstanceRecord[],
): Promise<void> {
  if (staleRecords.length === 0) return;
  await withRegistryLock(async () => {
    const currentRecords = await readRegistry();
    const next = currentRecords.filter(
      (record) =>
        !staleRecords.some((stale) => isSameRegistryRecord(record, stale)),
    );
    if (next.length === currentRecords.length) return;
    await writeRegistry(next);
  });
}

export async function upsertBrowserGatewayInstance(
  record: BrowserGatewayInstanceRecord,
): Promise<void> {
  await withRegistryLock(async () => {
    const records = await readRegistry();
    const replaced = records.filter((r) => r.instanceId === record.instanceId);
    const next = records.filter((r) => r.instanceId !== record.instanceId);
    next.push(record);
    // Tie-break on instanceId so same-named workspaces keep a stable order
    // across upserts (the upserted record is re-appended before sorting).
    next.sort(
      (a, b) =>
        a.workspaceName.localeCompare(b.workspaceName) ||
        a.instanceId.localeCompare(b.instanceId),
    );
    await writeRegistry(next);
    logRegistry(
      `upsert path=${REGISTRY_PATH} record=${summarizeRecord(record)} previousCount=${records.length} nextCount=${next.length} replaced=${replaced.map(summarizeRecord).join(" | ") || "none"}`,
    );
  });
}

export async function removeBrowserGatewayInstance(
  instanceId: string,
): Promise<void> {
  await withRegistryLock(async () => {
    const records = await readRegistry();
    const removed = records.filter((r) => r.instanceId === instanceId);
    const next = records.filter((r) => r.instanceId !== instanceId);
    if (next.length === records.length) {
      logRegistry(
        `remove path=${REGISTRY_PATH} instanceId=${instanceId} previousCount=${records.length} removed=none`,
      );
      return;
    }
    await writeRegistry(next);
    logRegistry(
      `remove path=${REGISTRY_PATH} instanceId=${instanceId} previousCount=${records.length} nextCount=${next.length} removed=${removed.map(summarizeRecord).join(" | ")}`,
    );
  });
}

function isPidLikelyAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    return code === "EPERM";
  }
}

type InstanceHealth = "healthy" | "unreachable" | "dead";

async function checkInstanceHealth(
  instance: BrowserGatewayInstanceRecord,
): Promise<InstanceHealth> {
  if (!isPidLikelyAlive(instance.pid)) return "dead";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(`${instance.url}/health`, {
      signal: controller.signal,
    });
    return response.ok ? "healthy" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export async function listBrowserGatewayInstances(): Promise<
  BrowserGatewayInstanceRecord[]
> {
  return await readRegistry();
}

export async function listCheckedBrowserGatewayInstances(): Promise<{
  healthy: BrowserGatewayInstanceRecord[];
  registered: BrowserGatewayInstanceRecord[];
}> {
  const records = await readRegistry();
  const checks = await Promise.all(
    records.map(async (record) => ({
      record,
      health: await checkInstanceHealth(record),
    })),
  );
  const healthy = checks
    .filter((c) => c.health === "healthy")
    .map((c) => c.record);
  const registered = checks
    .filter((c) => c.health !== "dead")
    .map((c) => c.record);
  const stale = checks.filter((c) => c.health === "dead").map((c) => c.record);
  const summary = checks
    .map((c) => `${c.health}:${summarizeRecord(c.record)}`)
    .join(" | ");
  logRegistry(
    `listChecked path=${REGISTRY_PATH} records=${records.length} healthy=${healthy.length} registered=${registered.length} stale=${stale.length} checks=${summary || "none"}`,
  );
  await removeExactBrowserGatewayInstances(stale);
  return { healthy, registered };
}

export async function listRegisteredBrowserGatewayInstances(): Promise<
  BrowserGatewayInstanceRecord[]
> {
  return (await listCheckedBrowserGatewayInstances()).registered;
}

export async function listHealthyBrowserGatewayInstances(): Promise<
  BrowserGatewayInstanceRecord[]
> {
  return (await listCheckedBrowserGatewayInstances()).healthy;
}
