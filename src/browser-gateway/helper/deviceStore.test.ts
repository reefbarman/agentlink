/** @vitest-environment node */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { DeviceStore, hashDeviceToken } from "./deviceStore.js";

async function freshStore(): Promise<{ store: DeviceStore; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlink-devstore-"));
  const filePath = path.join(dir, "devices.json");
  return { store: new DeviceStore({ filePath }), filePath };
}

describe("DeviceStore", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const p = cleanup.pop()!;
      try {
        await fs.rm(path.dirname(p), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("registers, matches, and revokes devices via the persisted file", async () => {
    const { store, filePath } = await freshStore();
    cleanup.push(filePath);

    const first = await store.register("Safari on iPhone");
    expect(first.device.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.token).toHaveLength(43);

    const match = await store.matchToken(first.token);
    expect(match?.id).toBe(first.device.id);
    expect(match?.label).toBe("Safari on iPhone");

    const bogus = await store.matchToken("nope");
    expect(bogus).toBeNull();

    const revoked = await store.revoke(first.device.id);
    expect(revoked).toBe(true);

    const afterRevoke = await store.matchToken(first.token);
    expect(afterRevoke).toBeNull();

    // Revoking again returns false (not found).
    expect(await store.revoke(first.device.id)).toBe(false);
  });

  it("persists tokens only as sha256 hashes (plaintext tokens are never written to disk)", async () => {
    const { store, filePath } = await freshStore();
    cleanup.push(filePath);

    const { token } = await store.register("Test device");
    const raw = await fs.readFile(filePath, "utf-8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashDeviceToken(token));
  });

  it("updates lastSeenAt when touchLastSeen is called", async () => {
    const { store, filePath } = await freshStore();
    cleanup.push(filePath);

    const { device } = await store.register("Laptop");
    const originalLastSeen = device.lastSeenAt;
    await new Promise((r) => setTimeout(r, 20));
    await store.touchLastSeen(device.id);
    const [updated] = await store.list();
    expect(updated.lastSeenAt >= originalLastSeen).toBe(true);
  });

  it("list returns multiple devices sorted by insertion order", async () => {
    const { store, filePath } = await freshStore();
    cleanup.push(filePath);

    await store.register("Phone A");
    await store.register("Phone B");
    const devices = await store.list();
    expect(devices.map((d) => d.label)).toEqual(["Phone A", "Phone B"]);
  });
});
