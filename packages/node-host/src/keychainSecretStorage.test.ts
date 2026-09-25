import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createKeychainSecretStorage } from "./keychainSecretStorage.js";
import {
  CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT,
  DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT,
} from "./keychainMcpCredentialRepository.js";

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
  it("isolates CLI and Desktop OAuth entries from each other and the former default", async () => {
    expect(
      new Set([
        CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT,
        DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT,
        "agentlink-mcp-oauth-v1",
      ]).size,
    ).toBe(3);
  });

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

  it("does not reclaim an old mutation lock owned by a live process", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-keychain-live-lock-"),
    );
    temporaryRoots.push(lockRoot);
    const lockPath = path.join(lockRoot, "test-service--test-account.lock");
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner"), `${process.pid}:live`);
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);

    const storage = await createKeychainSecretStorage({
      service: "test-service",
      account: "test-account",
      lockRoot,
      staleLockMs: 1,
      lockTimeoutMs: 20,
      retryDelayMs: 1,
    });

    await expect(
      storage.withMutationLock(async () => undefined),
    ).rejects.toThrow("agentlink_keychain_mutation_lock_timeout");
    await expect(
      fs.readFile(path.join(lockPath, "owner"), "utf-8"),
    ).resolves.toBe(`${process.pid}:live`);
  });

  it("fails closed on a stale mutation lock whose owner is gone", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-keychain-dead-lock-"),
    );
    temporaryRoots.push(lockRoot);
    const lockPath = path.join(lockRoot, "test-service--test-account.lock");
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner"), "2147483647:dead");
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);

    const storage = await createKeychainSecretStorage({
      service: "test-service",
      account: "test-account",
      lockRoot,
      staleLockMs: 1,
      lockTimeoutMs: 100,
      retryDelayMs: 1,
    });
    await expect(
      storage.withMutationLock(async () => "acquired"),
    ).rejects.toThrow("agentlink_keychain_mutation_lock_timeout");
    await expect(
      fs.readFile(path.join(lockPath, "owner"), "utf-8"),
    ).resolves.toBe("2147483647:dead");
  });

  it("does not delete a stale lock with no owner record", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-keychain-unknown-lock-"),
    );
    temporaryRoots.push(lockRoot);
    const lockPath = path.join(lockRoot, "test-service--test-account.lock");
    await fs.mkdir(lockPath);
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);

    const storage = await createKeychainSecretStorage({
      service: "test-service",
      account: "test-account",
      lockRoot,
      staleLockMs: 1,
      lockTimeoutMs: 20,
      retryDelayMs: 1,
    });
    await expect(
      storage.withMutationLock(async () => undefined),
    ).rejects.toThrow("agentlink_keychain_mutation_lock_timeout");
    expect((await fs.stat(lockPath)).isDirectory()).toBe(true);
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
