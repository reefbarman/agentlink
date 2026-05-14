import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

import type { BrowserGatewayDeviceRecord } from "../protocol.js";

const STORE_DIR = path.join(os.homedir(), ".agentlink");
const STORE_PATH = path.join(STORE_DIR, "browser-gateway-devices.json");

interface StoredDevice {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

interface StoreFile {
  devices: StoredDevice[];
}

export function getDeviceStorePath(): string {
  return STORE_PATH;
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

export function issueDeviceToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashDeviceToken(token) };
}

async function readStore(filePath = STORE_PATH): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { devices: [] };
    const devices = (parsed as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) return { devices: [] };
    const valid: StoredDevice[] = [];
    for (const d of devices) {
      if (
        d &&
        typeof d === "object" &&
        typeof (d as StoredDevice).id === "string" &&
        typeof (d as StoredDevice).tokenHash === "string" &&
        typeof (d as StoredDevice).label === "string" &&
        typeof (d as StoredDevice).createdAt === "string" &&
        typeof (d as StoredDevice).lastSeenAt === "string"
      ) {
        valid.push(d as StoredDevice);
      }
    }
    return { devices: valid };
  } catch {
    return { devices: [] };
  }
}

async function writeStore(
  store: StoreFile,
  filePath = STORE_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
}

export interface DeviceStoreOptions {
  /** Override the file path — exposed for tests. */
  filePath?: string;
}

export class DeviceStore {
  private readonly filePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: DeviceStoreOptions = {}) {
    this.filePath = options.filePath ?? STORE_PATH;
  }

  getPath(): string {
    return this.filePath;
  }

  async list(): Promise<BrowserGatewayDeviceRecord[]> {
    const store = await readStore(this.filePath);
    return store.devices.map((d) => ({
      id: d.id,
      label: d.label,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    }));
  }

  async register(label: string): Promise<{
    token: string;
    device: BrowserGatewayDeviceRecord;
  }> {
    const { token, tokenHash } = issueDeviceToken();
    const now = new Date().toISOString();
    const device: StoredDevice = {
      id: randomUUID(),
      tokenHash,
      label: label.slice(0, 200),
      createdAt: now,
      lastSeenAt: now,
    };

    await this.enqueue(async () => {
      const store = await readStore(this.filePath);
      store.devices.push(device);
      await writeStore(store, this.filePath);
    });

    return {
      token,
      device: {
        id: device.id,
        label: device.label,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
      },
    };
  }

  async matchToken(
    token: string,
  ): Promise<BrowserGatewayDeviceRecord | null> {
    if (!token) return null;
    const tokenHash = hashDeviceToken(token);
    const store = await readStore(this.filePath);
    for (const device of store.devices) {
      if (device.tokenHash.length !== tokenHash.length) continue;
      if (
        timingSafeEqual(
          Buffer.from(device.tokenHash, "hex"),
          Buffer.from(tokenHash, "hex"),
        )
      ) {
        return {
          id: device.id,
          label: device.label,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
        };
      }
    }
    return null;
  }

  async touchLastSeen(deviceId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.enqueue(async () => {
      const store = await readStore(this.filePath);
      const device = store.devices.find((d) => d.id === deviceId);
      if (!device) return;
      if (device.lastSeenAt === now) return;
      device.lastSeenAt = now;
      await writeStore(store, this.filePath);
    });
  }

  async revoke(deviceId: string): Promise<boolean> {
    let removed = false;
    await this.enqueue(async () => {
      const store = await readStore(this.filePath);
      const before = store.devices.length;
      store.devices = store.devices.filter((d) => d.id !== deviceId);
      if (store.devices.length === before) return;
      await writeStore(store, this.filePath);
      removed = true;
    });
    return removed;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
