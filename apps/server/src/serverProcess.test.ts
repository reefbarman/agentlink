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
  openEventStream,
  sessionCookieFrom,
  type TestServerSentEvent,
} from "./testSupport.js";

const execFileAsync = promisify(execFile);
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
  await fs.rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
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

      // First run: the server says how to pair; `pair` prints a code.
      const first = startProcess(configPath);
      await first.waitFor(/listening on 127\.0\.0\.1/u);
      await first.waitFor(/agentlink-server pair/u);
      const pair = async () => {
        const { stdout } = await execFileAsync(process.execPath, [
          bundle,
          "pair",
          "--config",
          configPath,
        ]);
        const match = /Pairing code:\s+([0-9]{3}) ([0-9]{3})/u.exec(stdout);
        expect(match, stdout).not.toBeNull();
        const code = `${match![1]}${match![2]}`;
        expect(stdout).toContain(`${origin}/pair?code=${code}`);
        return code;
      };
      const request = (input: {
        method?: string;
        path: string;
        body?: unknown;
        form?: Record<string, string>;
        session?: { cookie: string };
      }) =>
        httpsRequest({
          port,
          ca: certificate.cert,
          method: input.method,
          path: input.path,
          body: input.body,
          form: input.form,
          headers: {
            ...(input.method && input.method !== "GET" ? { origin } : {}),
            ...(input.session ? { cookie: input.session.cookie } : {}),
          },
        });
      // The bundle embeds the shared chat app; its files need no session.
      for (const asset of [
        "/browser-gateway.js",
        "/browser-gateway.css",
        "/codicon.css",
        "/site.webmanifest",
        "/agentlink-icon.svg",
      ]) {
        const served = await request({ path: asset });
        expect(served.status, asset).toBe(200);
        expect(String(served.headers["content-length"]), asset).not.toBe("0");
      }
      await expect(request({ path: "/" })).resolves.toMatchObject({
        status: 303,
        headers: { location: "/pair" },
      });
      const firstCode = await pair();
      const paired = await request({
        method: "POST",
        path: "/pair",
        form: { code: firstCode },
      });
      expect(paired).toMatchObject({ status: 303, headers: { location: "/" } });
      const owner = { cookie: sessionCookieFrom(paired) };
      const shell = await request({ path: "/", session: owner });
      expect(shell.status).toBe(200);
      expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(String(shell.body)).toContain("/browser-gateway.js");
      expect(String(shell.body)).toContain("askAgentOnly: true");
      expect(String(shell.body)).toContain('product: "assistant"');
      expect(String(shell.body)).toContain(
        "<title>AgentLink Assistant</title>",
      );
      const created = await request({
        method: "POST",
        path: "/api/projects/home/sessions",
        session: owner,
      });
      const { sessionId } = created.body as { sessionId: string };
      const sessionPath = `/api/projects/home/sessions/${sessionId}`;
      const turns = `${sessionPath}/turns`;
      const cursor = async () =>
        (
          (await request({ path: sessionPath, session: owner })).body as {
            events: { epoch: string; sequence: number };
          }
        ).events;
      const events = (query: string) =>
        openEventStream({
          port,
          ca: certificate.cert,
          path: `${sessionPath}/events${query}`,
          headers: { cookie: owner.cookie },
        });
      const sessionEvent =
        (predicate: (event: Record<string, unknown>) => boolean) =>
        (message: TestServerSentEvent) =>
          message.event === "session" &&
          predicate((message.data as { event: Record<string, unknown> }).event);
      const firstEpoch = (await cursor()).epoch;
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
      expect(second.output()).not.toContain("No devices are paired yet");

      // The crash may have lost events a client saw, so the epoch changes
      // and an old cursor resets. The log itself survived: replay from the
      // new epoch shows the interrupted turn, closed as server_restarted.
      const afterCrash = await cursor();
      expect(afterCrash.epoch).not.toBe(firstEpoch);
      const stale = await events(`?epoch=${firstEpoch}&after=1`);
      await stale.waitFor(
        (message) =>
          message.event === "reset" &&
          (message.data as { reason: string }).reason === "epoch_changed",
      );
      stale.close();
      const crashed = await events(`?epoch=${afterCrash.epoch}&after=0`);
      await crashed.waitFor(
        sessionEvent(
          (event) => event.kind === "task" && event.state === "started",
        ),
      );
      await crashed.waitFor(
        sessionEvent(
          (event) =>
            event.kind === "task" &&
            event.state === "failed" &&
            event.error === "server_restarted",
        ),
      );
      crashed.close();
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
      const beforeStop = await cursor();

      // Local pairing works while the server runs, and the code goes only to
      // the command's own output, never to the service log.
      const secondCode = await pair();
      expect(second.output()).not.toContain(secondCode);
      await expect(
        request({
          method: "POST",
          path: "/api/auth/pairings/redeem",
          body: { code: secondCode, deviceLabel: "Phone" },
        }),
      ).resolves.toMatchObject({ status: 201 });

      // Graceful stop aborts the running turn before exiting.
      second.child.kill("SIGTERM");
      await expect(second.exited).resolves.toEqual({ code: 0, signal: null });
      expect(second.output()).toContain("AgentLink server stopped");
      await vi.waitFor(() => expect(model.requests[1]!.aborted).toBe(true));

      // After a clean stop the epoch survives, so a client reconnecting with
      // its cursor replays what it missed (the stopped turn) without a reset.
      const third = startProcess(configPath);
      await third.waitFor(/listening on 127\.0\.0\.1/u);
      try {
        expect((await cursor()).epoch).toBe(beforeStop.epoch);
        const resumed = await events(
          `?epoch=${beforeStop.epoch}&after=${beforeStop.sequence}`,
        );
        await resumed.waitFor(
          sessionEvent(
            (event) =>
              event.kind === "task" &&
              (event.state === "finished" || event.state === "failed"),
          ),
        );
        expect(
          resumed.events.some((message) => message.event === "reset"),
        ).toBe(false);
        expect(
          resumed.events.some(
            (message) =>
              message.event === "session" &&
              (message.data as { sequence: number }).sequence <=
                beforeStop.sequence,
          ),
        ).toBe(false);
        resumed.close();
      } finally {
        third.child.kill("SIGTERM");
        await third.exited;
      }
    } finally {
      await model.close();
    }
  }, 120_000);

  it("serves a certificate from its local CA that devices verify via export-ca", async () => {
    const root = path.join(workDir, "local-ca");
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const port = await freePort();
    const configPath = path.join(root, "server.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port },
        publicOrigins: [`https://localhost:${port}`],
        tls: { localCa: true },
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
    const exportCa = () =>
      execFileAsync(process.execPath, [
        bundle,
        "export-ca",
        "--config",
        configPath,
      ]);

    // --check creates nothing; export-ca has nothing to export yet.
    const checked = await execFileAsync(process.execPath, [
      bundle,
      "--config",
      configPath,
      "--check",
    ]);
    expect(checked.stdout).toContain("local CA will be created on first start");
    await expect(exportCa()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Start the server once"),
    });

    const server = startProcess(configPath);
    try {
      const [, fingerprint] = await server.waitFor(
        /CA SHA-256 fingerprint: ([0-9A-F:]{95})/u,
      );
      await server.waitFor(/listening on 127\.0\.0\.1/u);
      const exported = await exportCa();
      expect(exported.stdout).toMatch(/^-----BEGIN CERTIFICATE-----/u);
      expect(exported.stderr).toContain(fingerprint);

      // A client that trusts only the exported CA verifies the server.
      await expect(
        httpsRequest({ port, ca: exported.stdout, path: "/pair" }),
      ).resolves.toMatchObject({ status: 200 });

      const rechecked = await execFileAsync(process.execPath, [
        bundle,
        "--config",
        configPath,
        "--check",
      ]);
      expect(rechecked.stdout).toContain(`local CA ${fingerprint}`);
    } finally {
      server.child.kill("SIGTERM");
      await server.exited;
    }

    // Restarting reuses the same CA, so devices keep trusting the server.
    const restarted = startProcess(configPath);
    try {
      await restarted.waitFor(/listening on 127\.0\.0\.1/u);
      expect(restarted.output()).not.toContain("Created a local certificate");
      const exported = await exportCa();
      await expect(
        httpsRequest({ port, ca: exported.stdout, path: "/pair" }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      restarted.child.kill("SIGTERM");
      await restarted.exited;
    }
  }, 60_000);

  it("runs a job with no browser connected and records a crash as interrupted", async () => {
    const certificate = createTestCertificate();
    const root = path.join(workDir, "jobs");
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.writeFile(path.join(root, "server.crt"), certificate.cert);
    await fs.writeFile(path.join(root, "server.key"), certificate.key, {
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
        tls: { certFile: "server.crt", keyFile: "server.key" },
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
    const request = (input: {
      method?: string;
      path: string;
      body?: unknown;
      form?: Record<string, string>;
      cookie?: string;
    }) =>
      httpsRequest({
        port,
        ca: certificate.cert,
        method: input.method,
        path: input.path,
        body: input.body,
        form: input.form,
        headers: {
          ...(input.method && input.method !== "GET" ? { origin } : {}),
          ...(input.cookie ? { cookie: input.cookie } : {}),
        },
      });
    const first = startProcess(configPath);
    try {
      await first.waitFor(/listening on 127\.0\.0\.1/u);
      const { stdout } = await execFileAsync(process.execPath, [
        bundle,
        "pair",
        "--config",
        configPath,
      ]);
      const code = /Pairing code:\s+([0-9]{3}) ([0-9]{3})/u.exec(stdout)!;
      const paired = await request({
        method: "POST",
        path: "/pair",
        form: { code: `${code[1]}${code[2]}` },
      });
      const cookie = sessionCookieFrom(paired);
      const created = await request({
        method: "POST",
        path: "/api/jobs",
        cookie,
        body: {
          name: "Check in",
          projectId: "home",
          prompt: "Anything new?",
          schedule: { kind: "interval", everyMinutes: 15 },
        },
      });
      expect(created.status).toBe(201);
      const job = (created.body as { job: { id: string; nextRunAt: number } })
        .job;
      expect(job.nextRunAt).toBeGreaterThan(Date.now());

      // Started, then nothing is connected: the run reaches the model anyway.
      await expect(
        request({ method: "POST", path: `/api/jobs/${job.id}/run`, cookie }),
      ).resolves.toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(model.requests).toHaveLength(1), {
        timeout: 15_000,
      });
      const runs = async () =>
        (
          (await request({ path: `/api/jobs/${job.id}/runs`, cookie }))
            .body as {
            runs: Array<{ status: string; error?: string; sessionId?: string }>;
          }
        ).runs;
      expect((await runs())[0]).toMatchObject({ status: "running" });
      const sessionId = (await runs())[0]!.sessionId;
      expect(sessionId).toBeTruthy();

      first.child.kill("SIGKILL");
      await first.exited;

      // After the crash the job is still there, its run is interrupted
      // (never re-run), and its chat is kept.
      const second = startProcess(configPath);
      try {
        await second.waitFor(/listening on 127\.0\.0\.1/u);
        expect((await runs())[0]).toMatchObject({
          status: "interrupted",
          error: "server_restarted",
          sessionId,
        });
        const listed = await request({ path: "/api/jobs", cookie });
        expect(listed.body).toMatchObject({
          jobs: [{ id: job.id, enabled: true, nextRunAt: job.nextRunAt }],
        });
        expect(model.requests).toHaveLength(1);
        await expect(
          request({ path: `/api/projects/home/sessions/${sessionId}`, cookie }),
        ).resolves.toMatchObject({ status: 200 });
        // The owner hears about it in the inbox, linked to the run's chat.
        const inbox = await request({ path: "/api/inbox", cookie });
        expect(inbox.body).toMatchObject({
          unread: 1,
          entries: [
            {
              kind: "run_failed",
              title: "Check in was interrupted",
              projectId: "home",
              jobId: job.id,
              sessionId,
              read: false,
            },
          ],
        });
      } finally {
        second.child.kill("SIGTERM");
        await second.exited;
      }
    } finally {
      first.child.kill("SIGKILL");
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

  it("runs the command worker from the bundle and reports it in --check", async () => {
    const root = path.join(workDir, "worker");
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    const tokenFile = path.join(root, "token");
    await fs.writeFile(tokenFile, "bundle-worker-token\n", { mode: 0o600 });
    const workerPort = await freePort();
    const child = spawn(
      process.execPath,
      [
        bundle,
        "command-worker",
        "--listen",
        `127.0.0.1:${workerPort}`,
        "--token-file",
        tokenFile,
        "--root",
        path.join(root, "projects"),
        "--allow-local-peers",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stdout.resume();
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    try {
      await vi.waitFor(
        () => {
          if (!/command worker listening/u.test(output)) {
            throw new Error(output);
          }
        },
        { timeout: 15_000, interval: 50 },
      );
      const certificate = createTestCertificate();
      await fs.mkdir(path.join(root, "tls"), { recursive: true });
      await fs.writeFile(
        path.join(root, "tls", "server.crt"),
        certificate.cert,
      );
      await fs.writeFile(
        path.join(root, "tls", "server.key"),
        certificate.key,
        { mode: 0o600 },
      );
      const configPath = path.join(root, "server.json");
      const config = (token: string) => ({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port: 8443 },
        publicOrigins: ["https://localhost:8443"],
        tls: { certFile: "tls/server.crt", keyFile: "tls/server.key" },
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
        commandWorker: {
          host: "127.0.0.1",
          port: workerPort,
          token: { file: token },
        },
      });
      await fs.writeFile(configPath, JSON.stringify(config("token")));
      const check = () =>
        execFileAsync(process.execPath, [
          bundle,
          "--config",
          configPath,
          "--check",
        ]);
      await expect(check()).resolves.toMatchObject({
        stdout: expect.stringContaining(
          `Command worker: reachable at 127.0.0.1:${workerPort}`,
        ),
      });
      const wrongToken = path.join(root, "wrong-token");
      await fs.writeFile(wrongToken, "not-the-token\n", { mode: 0o600 });
      await fs.writeFile(configPath, JSON.stringify(config("wrong-token")));
      await expect(check()).resolves.toMatchObject({
        stdout: expect.stringContaining("(unauthorized)"),
      });
    } finally {
      child.kill("SIGTERM");
    }
    await expect(exited).resolves.toBe(0);
    expect(output).toContain("rejected a connection with a bad token");
  }, 60_000);
});
