import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const DISCOVERY_DIR = path.join(os.homedir(), ".agentlink");
const DISCOVERY_PATH = path.join(DISCOVERY_DIR, "browser-gateway.json");

export interface BrowserGatewayDiscoveryRecord {
  pid: number;
  port: number;
  url: string;
  protocolVersion: number;
  startedAt: string;
  authToken?: string;
}

export function getBrowserGatewayDiscoveryPath(): string {
  return DISCOVERY_PATH;
}

export async function writeBrowserGatewayDiscovery(
  record: BrowserGatewayDiscoveryRecord,
): Promise<void> {
  await fs.mkdir(DISCOVERY_DIR, { recursive: true });
  const tmpPath = `${DISCOVERY_PATH}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, DISCOVERY_PATH);
}

export async function clearBrowserGatewayDiscovery(): Promise<void> {
  try {
    await fs.unlink(DISCOVERY_PATH);
  } catch {
    // ignore missing file / cleanup failures
  }
}
