import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT,
  DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT,
  KeychainMcpCredentialRepository,
  SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT,
  createStandaloneMcpCredentialRepository,
} from "./keychainMcpCredentialRepository.js";
import {
  LinuxCredentialStoreUnavailableError,
  createKeychainSecretStorage,
} from "./keychainSecretStorage.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexOAuthRuntime } from "./codexOAuthRuntime.js";

const values = new Map<string, string>();
let getPasswordCalls = 0;
let getPasswordError: Error | undefined;
let setPasswordCalls = 0;
const constructorCalls: unknown[][] = [];
let constructorError: Error | undefined;
const failSetOnce = new Set<string>();

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
      ...rest: unknown[]
    ) {
      constructorCalls.push([service, account, ...rest]);
      if (constructorError) throw constructorError;
    }

    async getPassword(): Promise<string | undefined> {
      getPasswordCalls += 1;
      if (getPasswordError) throw getPasswordError;
      return values.get(`${this.service}:${this.account}`);
    }

    async setPassword(value: string): Promise<void> {
      setPasswordCalls += 1;
      const key = `${this.service}:${this.account}`;
      if (failSetOnce.delete(key)) throw new Error(`write failed: ${key}`);
      values.set(key, value);
    }

    async deletePassword(): Promise<boolean> {
      return values.delete(`${this.service}:${this.account}`);
    }
  },
}));

const temporaryRoots: string[] = [];
const hostPlatform = process.platform;

// For tests asserting eager entry construction, which is macOS behaviour: a
// Linux host creates the default Secret Service entry lazily. Restored after
// each test.
function onMacOS() {
  Object.defineProperty(process, "platform", { value: "darwin" });
}

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: hostPlatform });
  values.clear();
  getPasswordCalls = 0;
  getPasswordError = undefined;
  constructorError = undefined;
  vi.unstubAllEnvs();
  setPasswordCalls = 0;
  constructorCalls.length = 0;
  failSetOnce.clear();
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
  it("composes CLI and Desktop with one standalone account and distinct compatibility replicas", async () => {
    onMacOS();
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-composition-"),
    );
    temporaryRoots.push(lockRoot);
    await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service: "test-mcp-service",
      lockRoot,
    });
    await createStandaloneMcpCredentialRepository({
      surface: "desktop",
      service: "test-mcp-service",
      lockRoot,
    });
    expect(constructorCalls).toEqual([
      ["test-mcp-service", SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT],
      ["test-mcp-service", CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT],
      ["test-mcp-service", SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT],
      ["test-mcp-service", DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT],
    ]);
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
    async function fakeHelper(
      mode: "ok" | "reject" | "error" | "detect-concurrency",
    ) {
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
const concurrencyMarker = ${JSON.stringify(path.join(os.tmpdir(), `agentlink-helper-concurrency-${process.pid}`))};
if (${JSON.stringify(mode)} === "detect-concurrency") {
  try { fs.mkdirSync(concurrencyMarker); }
  catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "keychain_error", message: "concurrent helper request" }));
    process.exit(1);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
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
if (${JSON.stringify(mode)} === "detect-concurrency") fs.rmdirSync(concurrencyMarker);
process.stdout.write(JSON.stringify(reply));
`,
        { mode: 0o755 },
      );
      const readState = async () =>
        JSON.parse(await fs.readFile(statePath, "utf8")) as {
          values: Record<string, string>;
          requests: Array<{ op: string; account: string; label: string }>;
        };
      const storage = async (
        account = "codex-oauth-credentials",
        sharedLockRoot?: string,
      ) => {
        const lockRoot =
          sharedLockRoot ??
          (await fs.mkdtemp(
            path.join(os.tmpdir(), "agentlink-keychain-helper-"),
          ));
        if (!sharedLockRoot) temporaryRoots.push(lockRoot);
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

    it("serializes helper prompts across accounts and host processes", async () => {
      const helper = await fakeHelper("detect-concurrency");
      const lockRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "agentlink-keychain-shared-helper-"),
      );
      temporaryRoots.push(lockRoot);
      const [codex, mcp] = await Promise.all([
        helper.storage("codex-oauth-credentials", lockRoot),
        helper.storage("agentlink-mcp-oauth-v1", lockRoot),
      ]);
      await expect(Promise.all([codex.get(), mcp.get()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect((await helper.readState()).requests).toHaveLength(2);
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

  it("migrates and mirrors one surface tenant without overwriting the other standalone tenant", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-shared-vault-"),
    );
    temporaryRoots.push(lockRoot);
    const service = "test-mcp-service";
    const cliPrincipal = { tenantId: "local", subjectId: "project-a" };
    const desktopPrincipal = {
      tenantId: "agentlink-desktop",
      subjectId: "ask-agent",
    };
    const record = (principal: typeof cliPrincipal, token: string) => ({
      schemaVersion: 1 as const,
      principal,
      serverId: "records",
      client: { client_id: `${principal.tenantId}-client` },
      tokens: { access_token: token, token_type: "bearer" },
      updatedAt: 100,
    });
    const state = (entries: Array<ReturnType<typeof record>>) => ({
      schemaVersion: 1,
      credentials: Object.fromEntries(
        entries.map((entry) => [
          JSON.stringify([
            entry.principal.tenantId,
            entry.principal.subjectId,
            entry.serverId,
          ]),
          { record: entry, revision: 1 },
        ]),
      ),
      authorizations: {},
    });
    const primaryStorage = await createKeychainSecretStorage({
      service,
      account: SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT,
      lockRoot,
    });
    await primaryStorage.store(
      JSON.stringify(state([record(desktopPrincipal, "desktop-token")])),
    );
    const legacyStorage = await createKeychainSecretStorage({
      service,
      account: CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT,
      lockRoot,
    });
    await legacyStorage.store(
      JSON.stringify(state([record(cliPrincipal, "cli-token")])),
    );

    const repository = await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service,
      lockRoot,
    });
    await expect(
      repository.readCredential({
        principal: cliPrincipal,
        serverId: "records",
      }),
    ).resolves.toMatchObject({
      ok: true,
      record: { tokens: { access_token: "cli-token" } },
    });
    await expect(
      repository.readCredential({
        principal: desktopPrincipal,
        serverId: "records",
      }),
    ).resolves.toMatchObject({
      ok: true,
      record: { tokens: { access_token: "desktop-token" } },
    });
    const mirroredLegacy = JSON.parse(
      values.get(`${service}:${CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT}`) ?? "{}",
    ) as {
      credentials?: Record<
        string,
        { record: { principal: { tenantId: string } } }
      >;
    };
    expect(
      Object.values(mirroredLegacy.credentials ?? {}).map(
        ({ record: mirrored }) => mirrored.principal.tenantId,
      ),
    ).toEqual(["local"]);

    await legacyStorage.store(
      JSON.stringify(state([record(cliPrincipal, "same-revision-new-token")])),
    );
    await expect(
      repository.readCredential({
        principal: cliPrincipal,
        serverId: "records",
      }),
    ).resolves.toMatchObject({
      ok: true,
      revision: "2",
      record: { tokens: { access_token: "same-revision-new-token" } },
    });

    const oldCli = new KeychainMcpCredentialRepository(legacyStorage);
    await expect(
      oldCli.deleteCredential({
        principal: cliPrincipal,
        serverId: "records",
        expectedRevision: "2",
      }),
    ).resolves.toEqual({ ok: true, revision: "2" });
    await expect(
      repository.readCredential({
        principal: cliPrincipal,
        serverId: "records",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      repository.readCredential({
        principal: desktopPrincipal,
        serverId: "records",
      }),
    ).resolves.toMatchObject({ ok: true });

    await oldCli.saveCredential({
      record: record(cliPrincipal, "cli-token-recreated"),
      expectedRevision: undefined,
    });
    await expect(
      repository.readCredential({
        principal: cliPrincipal,
        serverId: "records",
      }),
    ).resolves.toMatchObject({ ok: true });
    await legacyStorage.delete();
    await expect(
      repository.readCredential({
        principal: cliPrincipal,
        serverId: "records",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });

    await repository.reset();
    await expect(
      repository.readCredential({
        principal: desktopPrincipal,
        serverId: "records",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(values.has(`${service}:${CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT}`)).toBe(
      false,
    );
  });

  it("serializes concurrent mutations and consumes one callback only once", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-concurrent-vault-"),
    );
    temporaryRoots.push(lockRoot);
    const repository = await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service: "test-mcp-concurrent",
      lockRoot,
    });
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const principal = { tenantId: "local", subjectId: `project-${index}` };
        await expect(
          repository.saveCredential({
            record: {
              schemaVersion: 1,
              principal,
              serverId: "records",
              client: { client_id: `client-${index}` },
              tokens: { access_token: `token-${index}` },
              updatedAt: index,
            },
            expectedRevision: undefined,
          }),
        ).resolves.toMatchObject({ ok: true });
      }),
    );
    for (let index = 0; index < 12; index += 1) {
      await expect(
        repository.readCredential({
          principal: { tenantId: "local", subjectId: `project-${index}` },
          serverId: "records",
        }),
      ).resolves.toMatchObject({ ok: true });
    }

    const principal = { tenantId: "local", subjectId: "project-callback" };
    const authorization = {
      schemaVersion: 1 as const,
      transactionId: "transaction",
      principal,
      serverId: "records",
      redirectUri: "http://127.0.0.1/callback",
      state: "state",
      codeVerifier: "verifier",
      createdAt: 10,
      expiresAt: 100,
    };
    await repository.createPendingAuthorization({ authorization });
    const outcomes = await Promise.all([
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction",
        state: "state",
        consumedAt: 20,
      }),
      repository.consumePendingAuthorization({
        principal,
        serverId: "records",
        transactionId: "transaction",
        state: "state",
        consumedAt: 20,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      { ok: false, reason: "consumed" },
    ]);
  });

  it("repairs the shared MCP vault after the legacy write succeeds and the shared write fails", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-partial-write-"),
    );
    temporaryRoots.push(lockRoot);
    const service = "test-mcp-partial-write";
    const principal = { tenantId: "local", subjectId: "project-a" };
    const legacyStorage = await createKeychainSecretStorage({
      service,
      account: CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT,
      lockRoot,
    });
    const oldCli = new KeychainMcpCredentialRepository(legacyStorage);
    await oldCli.saveCredential({
      record: {
        schemaVersion: 1,
        principal,
        serverId: "records",
        client: { client_id: "client" },
        tokens: { access_token: "first" },
        updatedAt: 1,
      },
      expectedRevision: undefined,
    });
    const repository = await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service,
      lockRoot,
    });
    await expect(
      repository.readCredential({ principal, serverId: "records" }),
    ).resolves.toMatchObject({ ok: true, revision: "1" });
    failSetOnce.add(
      `${service}:${SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT}`,
    );
    await expect(
      repository.saveCredential({
        record: {
          schemaVersion: 1,
          principal,
          serverId: "records",
          client: { client_id: "client" },
          tokens: { access_token: "second" },
          updatedAt: 2,
        },
        expectedRevision: "1",
      }),
    ).rejects.toThrow("write failed");

    const reopened = await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service,
      lockRoot,
    });
    await expect(
      reopened.readCredential({ principal, serverId: "records" }),
    ).resolves.toMatchObject({
      ok: true,
      revision: "2",
      record: { tokens: { access_token: "second" } },
    });
  });

  it("resets corrupt shared and legacy MCP items", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-corrupt-reset-"),
    );
    temporaryRoots.push(lockRoot);
    const service = "test-mcp-corrupt-reset";
    values.set(
      `${service}:${SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT}`,
      "not-json",
    );
    values.set(`${service}:${CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT}`, "also-not-json");
    const repository = await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service,
      lockRoot,
    });
    await expect(repository.reset()).resolves.toBeUndefined();
    await expect(
      repository.readCredential({
        principal: { tenantId: "local", subjectId: "project-a" },
        serverId: "records",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("does not create an empty legacy MCP item for a new installation", async () => {
    const lockRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-mcp-new-vault-"),
    );
    temporaryRoots.push(lockRoot);
    const service = "test-mcp-service";
    const repository = await createStandaloneMcpCredentialRepository({
      surface: "cli",
      service,
      lockRoot,
    });
    await expect(
      repository.readCredential({
        principal: { tenantId: "local", subjectId: "project-a" },
        serverId: "records",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(
      values.has(`${service}:${SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT}`),
    ).toBe(true);
    expect(values.has(`${service}:${CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT}`)).toBe(
      false,
    );
  });

  it("keeps the native default store selection when no Linux store is requested", async () => {
    onMacOS();
    await createStorage();
    expect(constructorCalls).toEqual([["test-service", "test-account"]]);
  });

  it("requires the requested Linux store instead of allowing fallback", async () => {
    onMacOS();
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

  describe("on Linux", () => {
    const originalPlatform = process.platform;

    async function linuxStorage(linuxStore?: "secret-service" | "keyutils") {
      Object.defineProperty(process, "platform", { value: "linux" });
      const lockRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "agentlink-keychain-linux-"),
      );
      temporaryRoots.push(lockRoot);
      return await createKeychainSecretStorage({
        service: "test-service",
        account: "test-account",
        lockRoot,
        ...(linuxStore ? { linuxStore } : {}),
      });
    }

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("requires Secret Service by default instead of the kernel keyring fallback", async () => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
      values.set("test-service:test-account", "stored");
      const storage = await linuxStorage();

      await expect(storage.get()).resolves.toBe("stored");
      expect(constructorCalls).toEqual([
        [
          "test-service",
          "test-account",
          { linux: { store: "secret-service" } },
        ],
      ]);
    });

    it("fails headless sessions with a typed error before calling the store", async () => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
      const runtimeDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "agentlink-xdg-"),
      );
      temporaryRoots.push(runtimeDirectory);
      vi.stubEnv("XDG_RUNTIME_DIR", runtimeDirectory);
      const storage = await linuxStorage();

      const failure = await storage.get().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LinuxCredentialStoreUnavailableError);
      expect(failure).toMatchObject({
        code: "linux_credential_store_unavailable",
        reason: "no_session_bus",
      });
      await expect(storage.store("secret")).rejects.toBeInstanceOf(
        LinuxCredentialStoreUnavailableError,
      );
      expect(getPasswordCalls).toBe(0);
      expect(setPasswordCalls).toBe(0);
    });

    it("reports a missing Secret Service provider with the native cause", async () => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
      const cause = new Error(
        "Platform secure storage failure: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files",
      );
      getPasswordError = cause;
      const storage = await linuxStorage();

      await expect(storage.get()).rejects.toMatchObject({
        reason: "secret_service_unavailable",
        cause,
      });
    });

    it("classifies a D-Bus failure raised while creating the entry", async () => {
      // Seen on headless Ubuntu: a bus socket exists but autolaunch fails.
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
      const cause = new Error(
        "Platform failure: DBus error: Using X11 for dbus-daemon autolaunch was disabled at compile time, set your DBUS_SESSION_BUS_ADDRESS instead",
      );
      constructorError = cause;
      const storage = await linuxStorage();
      expect(constructorCalls).toEqual([]);

      await expect(storage.get()).rejects.toMatchObject({
        reason: "secret_service_unavailable",
        cause,
      });
      constructorError = undefined;
      values.set("test-service:test-account", "recovered");
      await expect(storage.get()).resolves.toBe("recovered");
    });

    it("passes unrelated native errors through unchanged", async () => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
      const cause = new Error("Attribute value too long");
      getPasswordError = cause;
      const storage = await linuxStorage();

      await expect(storage.get()).rejects.toBe(cause);
    });

    it("keeps an explicit keyutils opt-in without the Secret Service check", async () => {
      vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "");
      vi.stubEnv("XDG_RUNTIME_DIR", "/nonexistent-agentlink-runtime");
      const storage = await linuxStorage("keyutils");

      await expect(storage.get()).resolves.toBeUndefined();
      expect(constructorCalls).toEqual([
        ["test-service", "test-account", { linux: { store: "keyutils" } }],
      ]);
    });
  });

  it("forwards the Linux store from the Codex OAuth runtime composition", async () => {
    onMacOS();
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
