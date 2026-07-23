import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { BrowserGatewayHelperDiscoveryRecord } from "./protocol.js";
import { writeTextFileAtomic } from "./atomicFile.js";

const DISCOVERY_DIR = path.join(os.homedir(), ".agentlink");
const TEST_WORKER_ID =
  process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID;
const DISCOVERY_FILENAME = TEST_WORKER_ID
  ? `browser-gateway-helper.${TEST_WORKER_ID}.json`
  : "browser-gateway-helper.json";
const DISCOVERY_PATH = path.join(DISCOVERY_DIR, DISCOVERY_FILENAME);

type DiscoveryOperation =
  | {
      kind: "write";
      record: BrowserGatewayHelperDiscoveryRecord;
      waiters: Array<{ resolve(): void; reject(error: unknown): void }>;
    }
  | {
      kind: "clear";
      expectedHelperGenerationId: string | undefined;
      waiters: Array<{ resolve(): void; reject(error: unknown): void }>;
    };

export interface BrowserGatewayHelperDiscoveryWriterOptions {
  writeRecord: (record: BrowserGatewayHelperDiscoveryRecord) => Promise<void>;
  clearRecord: (expectedHelperGenerationId?: string) => Promise<void>;
}

export class BrowserGatewayHelperDiscoveryWriter {
  private readonly operations: DiscoveryOperation[] = [];
  private readonly retiredHelperGenerationIds = new Set<string>();
  private draining = false;

  constructor(
    private readonly options: BrowserGatewayHelperDiscoveryWriterOptions,
  ) {}

  write(record: BrowserGatewayHelperDiscoveryRecord): Promise<void> {
    if (
      record.helperGenerationId &&
      this.retiredHelperGenerationIds.has(record.helperGenerationId)
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const pending = this.operations.at(-1);
      if (pending?.kind === "write") {
        pending.record = record;
        pending.waiters.push({ resolve, reject });
      } else {
        this.operations.push({
          kind: "write",
          record,
          waiters: [{ resolve, reject }],
        });
      }
      this.startDrain();
    });
  }

  clear(expectedHelperGenerationId?: string): Promise<void> {
    if (expectedHelperGenerationId) {
      this.retiredHelperGenerationIds.add(expectedHelperGenerationId);
    } else {
      this.retiredHelperGenerationIds.clear();
    }
    return new Promise<void>((resolve, reject) => {
      const pending = this.operations.at(-1);
      if (
        pending?.kind === "clear" &&
        pending.expectedHelperGenerationId === expectedHelperGenerationId
      ) {
        pending.waiters.push({ resolve, reject });
      } else {
        this.operations.push({
          kind: "clear",
          expectedHelperGenerationId,
          waiters: [{ resolve, reject }],
        });
      }
      this.startDrain();
    });
  }

  private startDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.operations.length > 0) {
        const operation = this.operations.shift()!;
        try {
          if (operation.kind === "write") {
            await this.options.writeRecord(operation.record);
          } else {
            await this.options.clearRecord(
              operation.expectedHelperGenerationId,
            );
          }
          for (const waiter of operation.waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of operation.waiters) waiter.reject(error);
        }
      }
    } finally {
      this.draining = false;
      if (this.operations.length > 0) this.startDrain();
    }
  }
}

const discoveryWriter = new BrowserGatewayHelperDiscoveryWriter({
  writeRecord: (record) =>
    writeTextFileAtomic(
      DISCOVERY_PATH,
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600 },
    ),
  clearRecord: async (expectedHelperGenerationId) => {
    if (expectedHelperGenerationId) {
      const current = await readBrowserGatewayHelperDiscovery();
      if (current?.helperGenerationId !== expectedHelperGenerationId) return;
    }
    await fs.rm(DISCOVERY_PATH, { force: true });
  },
});

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

export function writeBrowserGatewayHelperDiscovery(
  record: BrowserGatewayHelperDiscoveryRecord,
): Promise<void> {
  return discoveryWriter.write(record);
}

export async function clearBrowserGatewayHelperDiscovery(
  expectedHelperGenerationId?: string,
): Promise<void> {
  await discoveryWriter
    .clear(expectedHelperGenerationId)
    .catch(() => undefined);
}
