import { FileLockHeldError, acquireFileLock } from "./fileLock.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileCodexOAuthStorage } from "./codexSignIn.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAssistantServerCli } from "./serverCli.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of cleanup.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sign-in-"));
  cleanup.push(dir);
  return dir;
}

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

async function writeConfig(root: string): Promise<string> {
  await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
  const configPath = path.join(root, "server.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      dataRoot: "data",
      listen: { host: "127.0.0.1", port: 8443 },
      publicOrigins: ["https://assistant.home.arpa:8443"],
      tls: { localCa: true },
      defaultModel: { providerId: "codex", modelId: "gpt-6.1-sol" },
      providers: [{ type: "codex", modelIds: ["gpt-6.1-sol"] }],
      projects: [{ id: "home", root: "projects/home" }],
    }),
  );
  return configPath;
}

function cliIo(
  lines: (stdout: string) => string | undefined,
  env: NodeJS.ProcessEnv = {},
) {
  let stdout = "";
  const logs: string[] = [];
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      log: (line: string) => {
        logs.push(line);
      },
      env,
      waitForShutdown: () => new Promise<string>(() => undefined),
      readLine: async () => lines(stdout),
    },
    output: () => stdout,
    logs,
  };
}

describe("file Codex sign-in storage", () => {
  it("stores state privately and refuses a file others can read", async () => {
    const dir = path.join(await tempDir(), "credentials");
    const storage = createFileCodexOAuthStorage(dir);
    await expect(storage.get()).resolves.toBeUndefined();

    await storage.store('{"version":2}');
    const file = path.join(dir, "codex-sign-in.json");
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(storage.get()).resolves.toBe('{"version":2}');

    await fs.chmod(file, 0o644);
    await expect(storage.get()).rejects.toThrow("chmod 600");
    await fs.chmod(file, 0o600);

    await storage.delete();
    await storage.delete();
    await expect(storage.get()).resolves.toBeUndefined();
  });

  it("serialises mutations across holders with a lock file", async () => {
    const dir = await tempDir();
    const storage = createFileCodexOAuthStorage(dir, { lockTimeoutMs: 2_000 });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = storage.withMutationLock!(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    const second = storage.withMutationLock!(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);

    const blocked = createFileCodexOAuthStorage(dir, { lockTimeoutMs: 100 });
    const lock = await acquireFileLock(path.join(dir, "codex-sign-in.lock"));
    expect(lock).toBeTruthy();
    await expect(
      blocked.withMutationLock!(async () => undefined),
    ).rejects.toBeInstanceOf(FileLockHeldError);
  });
});

describe("codex-login and codex-logout", () => {
  it("signs in from a pasted redirect, reports it in --check, and signs out", async () => {
    const root = await tempDir();
    const configPath = await writeConfig(root);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new URLSearchParams(String(init.body)).get("code")).toBe("abc");
      return new Response(
        JSON.stringify({
          access_token: jwt({ email: "owner@example.com" }),
          refresh_token: "refresh",
          id_token: jwt({
            email: "owner@example.com",
            "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
          }),
          expires_in: 3600,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    // The container image names the config with AGENTLINK_SERVER_CONFIG.
    const before = cliIo(() => undefined, {
      AGENTLINK_SERVER_CONFIG: configPath,
    });
    expect(await runAssistantServerCli(["--check"], before.io)).toBe(0);
    expect(before.output()).toContain("Codex: not signed in");

    const login = cliIo((stdout) => {
      const link = /https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/u.exec(
        stdout,
      )![0];
      const state = new URL(link).searchParams.get("state");
      return `http://localhost:1455/auth/callback?code=abc&state=${state}`;
    });
    expect(
      await runAssistantServerCli(
        ["codex-login", "--config", configPath],
        login.io,
      ),
    ).toBe(0);
    expect(login.output()).toContain("Signed in as owner@example.com (added)");
    const stateFile = path.join(
      root,
      "data",
      "credentials",
      "codex-sign-in.json",
    );
    expect((await fs.stat(stateFile)).mode & 0o777).toBe(0o600);

    const after = cliIo(() => undefined);
    await runAssistantServerCli(["--config", configPath, "--check"], after.io);
    expect(after.output()).toContain("Codex: signed in as owner@example.com");

    const logout = cliIo(() => undefined);
    expect(
      await runAssistantServerCli(
        ["codex-logout", "--config", configPath],
        logout.io,
      ),
    ).toBe(0);
    await expect(fs.stat(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a pasted address from another flow without storing anything", async () => {
    const root = await tempDir();
    const configPath = await writeConfig(root);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const login = cliIo(
      () => "http://localhost:1455/auth/callback?code=abc&state=forged",
    );
    expect(
      await runAssistantServerCli(
        ["codex-login", "--config", configPath],
        login.io,
      ),
    ).toBe(1);
    expect(login.logs.join("\n")).toContain("State mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(root, "data", "credentials", "codex-sign-in.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
