import { BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION } from "@agentlink/protocol/browser-gateway-helper-lifecycle";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_BYTES = 64 * 1024;
const HEALTH_TIMEOUT_MS = 2_000;

export interface DesktopRemoteTarget {
  url: string;
  generation: string;
}

interface DiscoveryDependencies {
  readRecord(): Promise<unknown>;
  isProcessAlive(pid: number): boolean;
  fetch: typeof fetch;
}

async function readDefaultRecord(): Promise<unknown> {
  // Load after desktop bootstrap has selected its own discovery namespace.
  const { getDefaultBrowserGatewayHelperDiscoveryPath } =
    await import("../../../src/browser-gateway/browserGatewayHelperDiscovery.js");
  const file = await open(
    getDefaultBrowserGatewayHelperDiscoveryPath(),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

async function readHealth(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function discoverDesktopRemote(
  dependencies: DiscoveryDependencies = {
    readRecord: readDefaultRecord,
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    fetch: globalThis.fetch,
  },
): Promise<DesktopRemoteTarget | null> {
  try {
    const record = await dependencies.readRecord();
    if (
      !isRecord(record) ||
      typeof record.url !== "string" ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(record.url) ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.port !== "number" ||
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65_535 ||
      record.protocolVersion !== BROWSER_GATEWAY_HELPER_PROTOCOL_VERSION ||
      typeof record.helperGenerationId !== "string" ||
      !record.helperGenerationId.trim() ||
      record.helperGenerationId.length > 256 ||
      typeof record.helperVersion !== "string" ||
      !record.helperVersion.trim() ||
      record.helperVersion.length > 128
    )
      return null;
    const url = new URL(record.url);
    if (
      Number(url.port || 80) !== record.port ||
      !dependencies.isProcessAlive(record.pid)
    ) {
      return null;
    }
    const health = await readHealth(
      await dependencies.fetch(new URL("/health", url), {
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      }),
    );
    if (
      !isRecord(health) ||
      health.status !== "ok" ||
      health.protocolVersion !== record.protocolVersion ||
      health.helperVersion !== record.helperVersion ||
      health.helperGenerationId !== record.helperGenerationId
    )
      return null;
    url.searchParams.set("desktopWorkspace", "1");
    return { url: url.toString(), generation: record.helperGenerationId };
  } catch {
    return null;
  }
}
