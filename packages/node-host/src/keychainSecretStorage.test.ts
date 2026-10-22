import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT,
  DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT,
} from "./keychainMcpCredentialRepository.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexOAuthRuntime } from "./codexOAuthRuntime.js";
import { createKeychainSecretStorage } from "./keychainSecretStorage.js";

const values = new Map<string, string>();
let getPasswordCalls = 0;
let setPasswordCalls = 0;
const constructorCalls: unknown[][] = [];

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
      ...rest: unknown[]
    ) {
      constructorCalls.push([service, account, ...rest]);
    }

    async getPassword(): Promise<string | undefined> {
      getPasswordCalls += 1;
      return values.get(`${this.service}:${this.account}`);
    }

    async setPassword(value: string): Promise<void> {
      setPasswordCalls += 1;
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
  setPasswordCalls = 0;
  constructorCalls.length = 0;
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

  it("does not rewrite an unchanged value, which would reset macOS access for other surfaces", async () => {
    const storage = await createStorage();
    await storage.store("same");
    await storage.store("same");
    expect(setPasswordCalls).toBe(1);
    // A value written by another surface is compared, not the stale cache.
    values.set("test-service:test-account", "external");
    const other = await createStorage();
    await other.store("external");
    expect(setPasswordCalls).toBe(1);
    await other.store("changed");
    expect(setPasswordCalls).toBe(2);
    await expect(other.get()).resolves.toBe("changed");
  });

  describe("with the AgentLink Credentials helper", () => {
    // A stand-in helper speaking the same stdin/stdout protocol. Its state
    // file lets the test see what the "Keychain" holds and which labels and
    // operations it was given.
    async function fakeHelper(mode: "ok" | "reject" | "error") {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "agentlink-fake-helper-"),
      );
      temporaryRoots.push(root);
      const statePath = path.join(root, "state.json");
      const helperPath = path.join(root, "AgentLink Credentials (Test)");
      await fs.writeFile(
        helperPath,
        `#!${process.execPath}
const fs = require("node:fs");
const state = fs.existsSync(${JSON.stringify(statePath)})
  ? JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"))
  : { values: {}, requests: [] };
const request = JSON.parse(fs.readFileSync(0, "utf8"));
state.requests.push({ op: request.op, account: request.account, label: request.label });
let reply;
if (${JSON.stringify(mode)} === "reject") reply = { ok: false, error: "caller_rejected" };
else if (${JSON.stringify(mode)} === "error") reply = { ok: false, error: "keychain_error", status: -128, message: "User canceled" };
else {
  const key = request.service + ":" + request.account;
  if (request.op === "store") state.values[key] = request.value;
  if (request.op === "delete") delete state.values[key];
  reply = { ok: true, value: request.op === "get" ? (state.values[key] ?? null) : null };
}
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
process.stdout.write(JSON.stringify(reply));
`,
        { mode: 0o755 },
      );
      const readState = async () =>
        JSON.parse(await fs.readFile(statePath, "utf8")) as {
          values: Record<string, string>;
          requests: Array<{ op: string; account: string; label: string }>;
        };
      const storage = async (account = "codex-oauth-credentials") => {
        const lockRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), "agentlink-keychain-helper-"),
        );
        temporaryRoots.push(lockRoot);
        return await createKeychainSecretStorage({
          service: "test-service",
          account,
          lockRoot,
          credentialsHelperPath: helperPath,
        });
      };
      return { readState, storage };
    }

    it("reads and writes through the helper with a descriptive label", async () => {
      const helper = await fakeHelper("ok");
      const storage = await helper.storage();
      await storage.store("token-state");
      await expect(storage.get()).resolves.toBe("token-state");
      await storage.delete();
      const state = await helper.readState();
      expect(state.values).toEqual({});
      expect(state.requests.map((request) => request.op)).toEqual([
        "get",
        "store",
        "delete",
      ]);
      expect(state.requests[0]?.label).toBe(
        "AgentLink: Codex sign-in (shared by VS Code, CLI and Desktop)",
      );
      // The native module was never asked: every access went to the helper.
      expect(getPasswordCalls).toBe(0);
      expect(setPasswordCalls).toBe(0);
    });

    it("falls back to direct Keychain access when the caller is not allowed", async () => {
      const helper = await fakeHelper("reject");
      const storage = await helper.storage("test-account");
      await storage.store("direct-value");
      await expect(storage.get()).resolves.toBe("direct-value");
      expect(values.get("test-service:test-account")).toBe("direct-value");
      // One rejected attempt, then direct access for the rest of the process.
      expect((await helper.readState()).requests).toHaveLength(1);
    });

    it("reports a Keychain error without retrying directly and prompting twice", async () => {
      const helper = await fakeHelper("error");
      const storage = await helper.storage("test-account");
      await expect(storage.store("value")).rejects.toThrow(
        "agentlink_credentials_helper_keychain_error: User canceled (-128)",
      );
      expect(getPasswordCalls).toBe(0);
      expect(setPasswordCalls).toBe(0);
    });

    it("uses direct access when the configured helper is missing", async () => {
      const lockRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "agentlink-keychain-missing-"),
      );
      temporaryRoots.push(lockRoot);
      const storage = await createKeychainSecretStorage({
        service: "test-service",
        account: "test-account",
        lockRoot,
        credentialsHelperPath: path.join(lockRoot, "missing-helper"),
      });
      await storage.store("value");
      expect(values.get("test-service:test-account")).toBe("value");
    });
  });

  it("keeps the native default store selection when no Linux store is requested", async () => {
    await createStorage();
    expect(constructorCalls).toEqual([["test-service", "test-account"]]);
  });

  it("requires the requested Linux store instead of allowing fallback", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-keychain-linux-"),
    );
    temporaryRoots.push(lockRoot);
    await createKeychainSecretStorage({
      service: "test-service",
      account: "test-account",
      lockRoot,
      linuxStore: "secret-service",
    });
    expect(constructorCalls).toEqual([
      ["test-service", "test-account", { linux: { store: "secret-service" } }],
    ]);
  });

  it("forwards the Linux store from the Codex OAuth runtime composition", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-keychain-runtime-"),
    );
    temporaryRoots.push(lockRoot);
    const runtime = createCodexOAuthRuntime({
      log: () => undefined,
      keychain: {
        service: "decky-codex-test",
        lockRoot,
        linuxStore: "secret-service",
      },
    });
    await runtime.ready();
    expect(constructorCalls).toEqual([
      [
        "decky-codex-test",
        "codex-oauth-credentials",
        { linux: { store: "secret-service" } },
      ],
    ]);
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
    // first's two reads, plus second's check for an unchanged value.
    expect(getPasswordCalls).toBe(3);
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
