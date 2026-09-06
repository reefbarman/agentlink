import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createKeychainSecretStorage } from "./keychainSecretStorage.js";

const values = new Map<string, string>();
let getPasswordCalls = 0;

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    async getPassword(): Promise<string | undefined> {
      getPasswordCalls += 1;
      return values.get(`${this.service}:${this.account}`);
    }

    async setPassword(value: string): Promise<void> {
      values.set(`${this.service}:${this.account}`, value);
    }

    async deletePassword(): Promise<boolean> {
      return values.delete(`${this.service}:${this.account}`);
    }
  },
}));

const temporaryRoots: string[] = [];

afterEach(async () => {
  values.clear();
  getPasswordCalls = 0;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createStorage() {
  const lockRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-keychain-"),
  );
  temporaryRoots.push(lockRoot);
  return await createKeychainSecretStorage({
    service: "test-service",
    account: "test-account",
    lockRoot,
  });
}

describe("createKeychainSecretStorage", () => {
  it("round-trips and deletes one Keychain entry", async () => {
    const storage = await createStorage();

    expect(await storage.get()).toBeUndefined();
    await storage.store("secret-state");
    expect(await storage.get()).toBe("secret-state");
    await storage.delete();
    expect(await storage.get()).toBeUndefined();
  });

  it("caches repeated reads while the shared revision is unchanged", async () => {
    values.set("test-service:test-account", "seeded-state");
    const storage = await createStorage();

    await expect(storage.get()).resolves.toBe("seeded-state");
    await expect(storage.get()).resolves.toBe("seeded-state");
    expect(getPasswordCalls).toBe(1);
  });

  it("reloads cached state after another adapter writes", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-keychain-shared-"),
    );
    temporaryRoots.push(lockRoot);
    const first = await createKeychainSecretStorage({
      service: "test-service",
      account: "test-account",
      lockRoot,
    });
    const second = await createKeychainSecretStorage({
      service: "test-service",
      account: "test-account",
      lockRoot,
    });
    values.set("test-service:test-account", "first-state");

    await expect(first.get()).resolves.toBe("first-state");
    await second.store("second-state");
    await expect(first.get()).resolves.toBe("second-state");
    await expect(first.get()).resolves.toBe("second-state");
    expect(getPasswordCalls).toBe(2);
  });

  it("serializes mutation operations through the shared directory lock", async () => {
    const storage = await createStorage();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = storage.withMutationLock(async () => {
      events.push("first:start");
      await firstReleased;
      events.push("first:end");
    });
    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    const second = storage.withMutationLock(async () => {
      events.push("second:start", "second:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });
});
