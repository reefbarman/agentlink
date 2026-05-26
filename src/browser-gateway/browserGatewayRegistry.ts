import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { BrowserGatewayDiscoveryRecord } from "./browserGatewayDiscovery.js";
import type { BrowserGatewayThemeSnapshot } from "../shared/types.js";

const REGISTRY_DIR = path.join(os.homedir(), ".agentlink");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "browser-gateways.json");

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
  const currentRecords = await readRegistry();
  const next = currentRecords.filter(
    (record) =>
      !staleRecords.some((stale) => isSameRegistryRecord(record, stale)),
  );
  if (next.length === currentRecords.length) return;
  await writeRegistry(next);
}

export async function upsertBrowserGatewayInstance(
  record: BrowserGatewayInstanceRecord,
): Promise<void> {
  const records = await readRegistry();
  const next = records.filter((r) => r.instanceId !== record.instanceId);
  next.push(record);
  next.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
  await writeRegistry(next);
}

export async function removeBrowserGatewayInstance(
  instanceId: string,
): Promise<void> {
  const records = await readRegistry();
  const next = records.filter((r) => r.instanceId !== instanceId);
  if (next.length === records.length) return;
  await writeRegistry(next);
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

async function isInstanceReachable(
  instance: BrowserGatewayInstanceRecord,
): Promise<boolean> {
  if (!isPidLikelyAlive(instance.pid)) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    const response = await fetch(`${instance.url}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

export async function listBrowserGatewayInstances(): Promise<
  BrowserGatewayInstanceRecord[]
> {
  return await readRegistry();
}

export async function listHealthyBrowserGatewayInstances(): Promise<
  BrowserGatewayInstanceRecord[]
> {
  const records = await readRegistry();
  const checks = await Promise.all(
    records.map(async (record) => ({
      record,
      healthy: await isInstanceReachable(record),
    })),
  );
  const healthy = checks.filter((c) => c.healthy).map((c) => c.record);
  const stale = checks.filter((c) => !c.healthy).map((c) => c.record);
  await removeExactBrowserGatewayInstances(stale);
  return healthy;
}
