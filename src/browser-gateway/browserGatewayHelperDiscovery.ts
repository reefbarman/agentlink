import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { BrowserGatewayHelperDiscoveryRecord } from "./protocol.js";

const DISCOVERY_DIR = path.join(os.homedir(), ".agentlink");
const TEST_WORKER_ID =
  process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID;
const DISCOVERY_FILENAME = TEST_WORKER_ID
  ? `browser-gateway-helper.${TEST_WORKER_ID}.json`
  : "browser-gateway-helper.json";
const DISCOVERY_PATH = path.join(DISCOVERY_DIR, DISCOVERY_FILENAME);

export function getBrowserGatewayHelperDiscoveryPath(): string {
  return DISCOVERY_PATH;
}

export async function readBrowserGatewayHelperDiscovery(): Promise<BrowserGatewayHelperDiscoveryRecord | null> {
  try {
    const raw = await fs.readFile(DISCOVERY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as BrowserGatewayHelperDiscoveryRecord;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.protocolVersion !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeBrowserGatewayHelperDiscovery(
  record: BrowserGatewayHelperDiscoveryRecord,
): Promise<void> {
  await fs.mkdir(DISCOVERY_DIR, { recursive: true });
  const tmpPath = `${DISCOVERY_PATH}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, DISCOVERY_PATH);
}

export async function clearBrowserGatewayHelperDiscovery(): Promise<void> {
  try {
    await fs.unlink(DISCOVERY_PATH);
  } catch {
    // ignore missing file / cleanup failures
  }
}
