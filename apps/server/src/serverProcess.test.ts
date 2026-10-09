import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTestCertificate,
  freePort,
  httpsRequest,
  sessionCookieFrom,
} from "./testSupport.js";

const execFileAsync = promisify(execFile);
const PASSPHRASE = "correct horse battery staple";
const serverRoot = path.join(import.meta.dirname, "..");

let workDir: string;
let bundle: string;

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-process-"));
  bundle = path.join(workDir, "bin", "agentlink-server.js");
  // Exercise the shipped artifact, not the TypeScript sources.
  await execFileAsync(process.execPath, ["esbuild.mjs", "--outfile", bundle], {
    cwd: serverRoot,
  });
}, 120_000);

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** A model endpoint that accepts requests and never answers them. */
async function startStalledModelServer() {
  const requests: Array<{ aborted: boolean }> = [];
  const server = http.createServer((request, response) => {
    const entry = { aborted: false };
    requests.push(entry);
    request.resume();
    response.on("close", () => {
      if (!response.writableEnded) entry.aborted = true;
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as { port: number };
  return {
    requests,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function startProcess(configPath: string) {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [bundle, "--config", configPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stdout.resume();
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    child,
    exited,
    output: () => output,
    async waitFor(pattern: RegExp, timeoutMs = 30_000) {
      await vi.waitFor(
        () => {
          if (!pattern.test(output)) {
            throw new Error(`Waiting for ${pattern}; output:\n${output}`);
          }
        },
        { timeout: timeoutMs, interval: 50 },
      );
      return pattern.exec(output)!;
    },
  };
}

describe("agentlink-server process", () => {
  it("checks its configuration, recovers after a crash, and stops cleanly on SIGTERM", async () => {
    const certificate = createTestCertificate();
    const root = path.join(workDir, "deployment");
    await fs.mkdir(path.join(root, "tls"), { recursive: true });
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.writeFile(path.join(root, "tls", "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "tls", "server.key"), certificate.key, {
      mode: 0o600,
    });
    const model = await startStalledModelServer();
    const port = await freePort();
    const origin = `https://localhost:${port}`;
    const configPath = path.join(root, "server.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port },
        publicOrigins: [origin],
        tls: { certFile: "tls/server.crt", keyFile: "tls/server.key" },
        defaultModel: { providerId: "local", modelId: "fixture" },
        providers: [
          {
            type: "openai-compatible",
            id: "local",
            baseURL: model.baseURL,
            noAuth: true,
            allowInsecureHttp: true,
            models: [
              {
                id: "fixture",
                contextWindow: 32_768,
                maxOutputTokens: 4_096,
                supportsToolUse: true,
              },
            ],
          },
        ],
        projects: [{ id: "home", label: "Home", root: "projects/home" }],
      }),
    );

    try {
      const { stdout } = await execFileAsync(process.execPath, [
        bundle,
        "--config",
        configPath,
        "--check",
      ]);
      expect(stdout).toContain("Configuration OK: 1 project(s)");

      // First run: bootstrap the owner from the locally printed credential.
      const first = startProcess(configPath);
      const [, setupToken] = await first.waitFor(
        /Setup credential[^\n]*:\n\s+(\S+)/u,
      );
      await first.waitFor(/listening on 127\.0\.0\.1/u);
      const request = (input: {
        method?: string;
        path: string;
        body?: unknown;
        session?: { cookie: string; csrf: string };
      }) =>
        httpsRequest({
          port,
          ca: certificate.cert,
          method: input.method,
          path: input.path,
          body: input.body,
          headers: {
            ...(input.method && input.method !== "GET" ? { origin } : {}),
            ...(input.session
              ? {
                  cookie: input.session.cookie,
                  "x-agentlink-csrf": input.session.csrf,
                }
              : {}),
          },
        });
      const bootstrap = await request({
        method: "POST",
        path: "/api/auth/bootstrap",
        body: { setupToken, passphrase: PASSPHRASE },
      });
      expect(bootstrap.status).toBe(201);
      const owner = {
        cookie: sessionCookieFrom(bootstrap),
        csrf: (bootstrap.body as { csrfToken: string }).csrfToken,
      };
      const created = await request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
      });
      const { sessionId } = created.body as { sessionId: string };
      const turns = `/api/projects/home/sessions/${sessionId}/turns`;
      await expect(
        request({
          method: "POST",
          path: turns,
          session: owner,
          body: { text: "hello" },
        }),
      ).resolves.toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
        timeout: 15_000,
      });

      // Crash mid-turn.
      first.child.kill("SIGKILL");
      await first.exited;

      // Second run starts at once even though the dead process's turn lease
      // is still live. The owner and session survive, no new setup
      // credential is issued, and the session is busy until its lease
      // expires and recovery completes.
      const second = startProcess(configPath);
      await second.waitFor(/listening on 127\.0\.0\.1/u);
      expect(second.output()).toContain(
        `Session ${sessionId} in project "home" is still leased`,
      );
      expect(second.output()).not.toContain("Setup credential");
      await expect(
        request({
          method: "POST",
          path: turns,
          session: owner,
          body: { text: "too soon" },
        }),
      ).resolves.toMatchObject({
        status: 409,
        body: { error: "session_busy" },
      });
      await second.waitFor(
        new RegExp(`Recovered interrupted session ${sessionId}`, "u"),
        60_000,
      );
      await expect(
        request({
          method: "POST",
          path: turns,
          session: owner,
          body: { text: "hello again" },
        }),
      ).resolves.toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(model.requests).toHaveLength(2), {
        timeout: 15_000,
      });

      // Local recovery works while the server runs, and the code goes only
      // to the command's own output, never to the service log.
      const recovered = await execFileAsync(process.execPath, [
        bundle,
        "recover",
        "--config",
        configPath,
      ]);
      const recoveryToken = /recovery code[^\n]*:\n\s*\n\s+(\S+)/u.exec(
        recovered.stdout,
      )?.[1];
      expect(recoveryToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(second.output()).not.toContain(recoveryToken);
      await expect(
        request({
          method: "POST",
          path: "/api/auth/recover",
          body: { recoveryToken, passphrase: PASSPHRASE },
        }),
      ).resolves.toMatchObject({ status: 201 });

      // Graceful stop aborts the running turn before exiting.
      second.child.kill("SIGTERM");
      await expect(second.exited).resolves.toEqual({ code: 0, signal: null });
      expect(second.output()).toContain("AgentLink server stopped");
      await vi.waitFor(() => expect(model.requests[1]!.aborted).toBe(true));
    } finally {
      await model.close();
    }
  }, 120_000);

  it("refuses a TLS key that other users can read", async () => {
    const certificate = createTestCertificate();
    const root = path.join(workDir, "loose-key");
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key);
    await fs.chmod(path.join(root, "server.key"), 0o644);
    const configPath = path.join(root, "server.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port: 8443 },
        publicOrigins: ["https://localhost:8443"],
        tls: { certFile: "server.crt", keyFile: "server.key" },
        defaultModel: { providerId: "local", modelId: "fixture" },
        providers: [
          {
            type: "openai-compatible",
            id: "local",
            baseURL: "http://127.0.0.1:9/v1",
            noAuth: true,
            models: [
              {
                id: "fixture",
                contextWindow: 32_768,
                maxOutputTokens: 4_096,
                supportsToolUse: true,
              },
            ],
          },
        ],
        projects: [{ id: "home", root: "projects/home" }],
      }),
    );
    const result = await execFileAsync(process.execPath, [
      bundle,
      "--config",
      configPath,
      "--check",
    ]).catch((error: { code: number; stderr: string }) => error);
    expect(result).toMatchObject({ code: 1 });
    expect((result as { stderr: string }).stderr).toContain(
      "must not be accessible by others",
    );
  }, 30_000);
});
