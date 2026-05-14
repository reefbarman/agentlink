import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

import { readBrowserGatewayHelperDiscovery } from "../browserGatewayHelperDiscovery.js";
import {
  BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION,
  type BrowserGatewayHelperDiscoveryRecord,
  type BrowserGatewayHelperHealthResponse,
} from "../protocol.js";

export interface BrowserGatewayHelperBootstrapOptions {
  extensionRootPath: string;
  browserGatewayPort: number;
  helperVersion: string;
  idleShutdownMs?: number;
  startupTimeoutMs?: number;
  /** Expose gateway on 0.0.0.0 and start mDNS advertising. */
  lanAccess?: boolean;
  /** mDNS hostname (without `.local`). */
  mdnsName?: string;
  log: (message: string) => void;
}

export interface BrowserGatewayHelperBootstrapResult {
  source: "existing" | "spawned";
  discovery: BrowserGatewayHelperDiscoveryRecord;
  child?: ChildProcess;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const HELPER_TERMINATION_TIMEOUT_MS = 5_000;

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

export async function fetchHelperHealth(
  discovery: Pick<BrowserGatewayHelperDiscoveryRecord, "url">,
): Promise<BrowserGatewayHelperHealthResponse | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_200);
    const response = await fetch(`${discovery.url}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as BrowserGatewayHelperHealthResponse;
    return body;
  } catch {
    return null;
  }
}

export interface DesiredHelperConfig {
  helperVersion: string;
  lanAccess: boolean;
  mdnsName?: string;
}

export function discoveryMatchesDesiredConfig(
  discovery: BrowserGatewayHelperDiscoveryRecord,
  desired: DesiredHelperConfig,
): boolean {
  const discoveredLanAccess = Boolean(discovery.lanAccess);
  if (discoveredLanAccess !== desired.lanAccess) return false;
  if (desired.lanAccess) {
    const wantName = (desired.mdnsName ?? "agentlink").trim() || "agentlink";
    const gotName = (discovery.mdnsHostName ?? "").trim();
    // The helper may have rotated the suffix (e.g. "agentlink" → "agentlink-3f20")
    // on conflict. Accept either exact match or suffix-rotated variant of the
    // desired base name.
    if (gotName !== wantName && !gotName.startsWith(`${wantName}-`)) {
      return false;
    }
  }
  return true;
}

export async function resolveHealthyDiscoveredHelper(
  expectedPort: number,
  desired: DesiredHelperConfig,
): Promise<BrowserGatewayHelperDiscoveryRecord | null> {
  const discovery = await readBrowserGatewayHelperDiscovery();
  if (!discovery) return null;
  if (discovery.port !== expectedPort) return null;
  if (!isPidLikelyAlive(discovery.pid)) return null;

  const health = await fetchHelperHealth(discovery);
  if (!health) return null;
  if (health.protocolVersion !== BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION) {
    return null;
  }
  if (health.helperVersion !== desired.helperVersion) {
    return null;
  }
  if (!discoveryMatchesDesiredConfig(discovery, desired)) {
    return null;
  }

  return discovery;
}

export async function waitForHelperReady(
  expectedPort: number,
  desired: DesiredHelperConfig,
  timeoutMs: number,
  expectedPid?: number,
): Promise<BrowserGatewayHelperDiscoveryRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovery = await resolveHealthyDiscoveredHelper(
      expectedPort,
      desired,
    );
    if (
      discovery &&
      (expectedPid === undefined || discovery.pid === expectedPid)
    ) {
      return discovery;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("helper_start_timeout");
}

/**
 * When the discovered helper doesn't match what we want (wrong version,
 * wrong lanAccess flag, different mDNS name) we have to replace it. The old
 * process is still bound to the port, so spawn-then-listen would fail with
 * EADDRINUSE. SIGTERM the stale pid and wait for the socket to actually close.
 */
async function terminateStaleHelper(
  log: (message: string) => void,
): Promise<void> {
  const discovery = await readBrowserGatewayHelperDiscovery();
  if (!discovery) return;
  if (!isPidLikelyAlive(discovery.pid)) return;

  log(
    `[browser-gateway-helper] terminating stale helper pid=${discovery.pid} (config changed)`,
  );
  try {
    process.kill(discovery.pid, "SIGTERM");
  } catch (err) {
    log(`[browser-gateway-helper] SIGTERM failed: ${String(err)}`);
  }

  const deadline = Date.now() + HELPER_TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isPidLikelyAlive(discovery.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Still alive — escalate.
  log(
    `[browser-gateway-helper] pid=${discovery.pid} did not exit within ${HELPER_TERMINATION_TIMEOUT_MS}ms; sending SIGKILL`,
  );
  try {
    process.kill(discovery.pid, "SIGKILL");
  } catch {
    // already gone
  }
  // Give the OS a beat to release the port.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export async function bootstrapBrowserGatewayHelper(
  options: BrowserGatewayHelperBootstrapOptions,
): Promise<BrowserGatewayHelperBootstrapResult> {
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const desired: DesiredHelperConfig = {
    helperVersion: options.helperVersion,
    lanAccess: Boolean(options.lanAccess),
    mdnsName: options.mdnsName,
  };

  const existing = await resolveHealthyDiscoveredHelper(
    options.browserGatewayPort,
    desired,
  );
  if (existing) {
    options.log(
      `[browser-gateway-helper] using existing helper at ${existing.url} (pid=${existing.pid}, lanAccess=${Boolean(existing.lanAccess)})`,
    );
    return {
      source: "existing",
      discovery: existing,
    };
  }

  const helperPath = path.join(
    options.extensionRootPath,
    "dist",
    "browser-gateway-helper.js",
  );
  if (!fs.existsSync(helperPath)) {
    throw new Error(`helper_bundle_missing:${helperPath}`);
  }

  // A helper is present but mismatched (version or lanAccess changed). Before
  // spawning, terminate the stale process so the port is free.
  await terminateStaleHelper(options.log);

  const args = [
    helperPath,
    `--port=${options.browserGatewayPort}`,
    `--helperVersion=${options.helperVersion}`,
    `--extensionRootPath=${options.extensionRootPath}`,
  ];
  if (
    typeof options.idleShutdownMs === "number" &&
    Number.isFinite(options.idleShutdownMs)
  ) {
    args.push(
      `--idleShutdownMs=${Math.max(1_000, Math.floor(options.idleShutdownMs))}`,
    );
  }
  if (options.lanAccess) {
    args.push(`--lanAccess=true`);
  }
  if (options.mdnsName && options.mdnsName.trim()) {
    args.push(`--mdnsName=${options.mdnsName.trim()}`);
  }

  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    options.log(`[browser-gateway-helper stdout] ${data.toString().trim()}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    options.log(`[browser-gateway-helper stderr] ${data.toString().trim()}`);
  });

  child.on("exit", (code, signal) => {
    options.log(
      `[browser-gateway-helper] exited (code=${code}, signal=${signal})`,
    );
  });

  const discovery = await waitForHelperReady(
    options.browserGatewayPort,
    desired,
    startupTimeoutMs,
    child.pid,
  );

  options.log(
    `[browser-gateway-helper] started at ${discovery.url} (pid=${discovery.pid}, lanAccess=${Boolean(discovery.lanAccess)}, mdns=${discovery.mdnsUrl ?? "off"})`,
  );

  return {
    source: "spawned",
    discovery,
    child,
  };
}
