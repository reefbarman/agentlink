import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantUpdateDiscovery,
  AssistantUpdateOperation,
} from "../../../src/shared/assistantUpdates.js";
import {
  createDockerUpdaterJobLauncher,
  runUpdaterJob,
  startAssistantUpdater,
  type AssistantReleaseDiscoveryService,
  type AssistantUpdaterOptions,
  type UpdaterJobLauncher,
} from "./assistantUpdater.js";
import { createUpdaterClient } from "./updaterClient.js";
import { withFileLock } from "./fileLock.js";
import { AssistantReleaseUpdateService } from "../../../src/updates/assistantReleaseUpdateService.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const DISCOVERY: AssistantUpdateDiscovery = {
  status: "available",
  automaticChecks: true,
  includePreviews: false,
  checkedAt: 10,
  lastAttemptAt: 10,
  retryAt: null,
  stale: false,
  releases: [
    {
      version: "2.3.4",
      tag: "assistant-v2.3.4",
      channel: "stable",
      releaseUrl:
        "https://github.com/reefbarman/agentlink/releases/tag/assistant-v2.3.4",
      notes: "Cached notes",
    },
  ],
};
async function setup(overrides: Partial<AssistantUpdaterOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "updater-test-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const deployDirectory = path.join(root, "deploy");
  const updaterDirectory = path.join(root, "updater");
  let jobState: "running" | "stopped" | "missing" = "running";
  const jobs: UpdaterJobLauncher = {
    launch: vi.fn(async () => undefined),
    inspect: vi.fn(async () => jobState),
  };
  let discovery = structuredClone(DISCOVERY);
  const releases: AssistantReleaseDiscoveryService = {
    start: vi.fn(async () => undefined),
    snapshot: () => discovery,
    check: vi.fn(async () => discovery),
    setPreferences: vi.fn(async (value) => {
      discovery = { ...discovery, ...value };
    }),
    dispose: vi.fn(),
  };
  const options: AssistantUpdaterOptions = {
    host: "127.0.0.1",
    port: 0,
    token: "private-token",
    deployDirectory,
    updaterDirectory,
    jobs,
    releases,
    readInstalled: async () => ({
      managed: true,
      version: "1.9.8",
      commit: "a".repeat(40),
      rollbackVersion: "1.8.7",
    }),
    schedule: false,
    ...overrides,
  };
  let service = await startAssistantUpdater(options);
  cleanup.push(async () => service.close());
  const client = () =>
    createUpdaterClient({
      host: "127.0.0.1",
      port: service.address.port,
      token: "private-token",
    });
  const call = async (
    action: string,
    body?: unknown,
    token = "private-token",
    method = "POST",
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${service.address.port}/v1/updates${action}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  return {
    options,
    jobs,
    releases,
    client,
    call,
    setState: (state: typeof jobState) => {
      jobState = state;
    },
    restart: async () => {
      await service.close();
      service = await startAssistantUpdater(options);
    },
  };
}
const confirmation = {
  version: "2.3.4",
  expectedInstalledVersion: "1.9.8",
  confirmed: true as const,
};

describe("private Assistant updater", () => {
  it("recovers discovery after restarting during a transient deployment identity mismatch", async () => {
    let managed = false;
    const discover = vi.fn(async () => ({
      records: [],
      complete: true,
      unverifiedVersions: [],
    }));
    const { client } = await setup({
      releases: undefined,
      releaseClient: { discover },
      readInstalled: async () => ({
        managed,
        version: managed ? "2.0.0" : null,
        commit: null,
        rollbackVersion: null,
      }),
    });
    expect((await client().status()).managed).toBe(false);
    managed = true;
    const start = vi
      .spyOn(AssistantReleaseUpdateService.prototype, "start")
      .mockRejectedValueOnce(new Error("temporary preferences read failure"));
    try {
      await expect(client().status()).rejects.toThrow();
    } finally {
      start.mockRestore();
    }
    await client().status();
    await client().check();
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ product: "assistant", version: "2.0.0" }),
      expect.any(AbortSignal),
    );
  });

  it("refuses mutable job images for managed releases", async () => {
    for (const jobImage of [
      undefined,
      "agentlink-updater:local",
      "ghcr.io/reefbarman/agentlink-updater:latest",
    ]) {
      await expect(setup({ jobs: undefined, jobImage })).rejects.toThrow(
        "update_image_unpinned",
      );
    }
  });
  it("requires bearer auth, exact bodies and explicit confirmation", async () => {
    const { call, jobs } = await setup();
    expect((await call("", undefined, "wrong", "GET")).status).toBe(401);
    for (const action of ["check", "preferences", "apply", "rollback"]) {
      expect(
        (
          await call(`/${action}`, {
            ...confirmation,
            deployDirectory: "/etc",
            image: "evil",
            command: "evil",
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (await call("/apply", { ...confirmation, confirmed: false })).status,
    ).toBe(400);
    expect(
      (
        await call("/preferences", {
          automaticChecks: "yes",
          includePreviews: false,
        })
      ).status,
    ).toBe(400);
    expect(jobs.launch).not.toHaveBeenCalled();
  });

  it("rejects stale, downgrade and unknown release requests", async () => {
    const { call, jobs } = await setup();
    expect(
      await call("/apply", {
        ...confirmation,
        expectedInstalledVersion: "1.0.0",
      }),
    ).toMatchObject({
      status: 409,
      body: { error: "update_installed_version_changed" },
    });
    expect(
      await call("/apply", { ...confirmation, version: "1.8.7" }),
    ).toMatchObject({
      status: 409,
      body: { error: "update_downgrade_forbidden" },
    });
    expect(
      (await call("/apply", { ...confirmation, version: "9.0.0" })).status,
    ).toBe(409);
    expect(
      (await call("/rollback", { ...confirmation, version: "1.7.0" })).status,
    ).toBe(409);
    expect(jobs.launch).not.toHaveBeenCalled();
  });

  it("persists before launch, serialises simultaneous applies and retains a live job after restart", async () => {
    const { options, jobs, client, restart } = await setup();
    vi.mocked(jobs.launch).mockImplementation(async (operation) => {
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(
              options.updaterDirectory,
              "operations",
              `${operation.id}.json`,
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({
        phase: "queued",
        targetVersion: "2.3.4",
        fromVersion: "1.9.8",
      });
    });
    const outcomes = await Promise.allSettled([
      client().apply(confirmation),
      client().apply(confirmation),
    ]);
    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(jobs.launch).toHaveBeenCalledTimes(1);
    await restart();
    expect((await client().status()).operation).toMatchObject({
      phase: "queued",
      kind: "update",
      targetVersion: "2.3.4",
    });
    expect(jobs.launch).toHaveBeenCalledTimes(1);
  });

  it("does not hold the progress lock during slow inspection or overwrite newer progress", async () => {
    const { options, jobs, client } = await setup();
    const operation = (await client().apply(confirmation)).operation!;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inspecting = false;
    vi.mocked(jobs.inspect).mockImplementationOnce(async () => {
      inspecting = true;
      await pending;
      return "stopped";
    });
    const reading = client().status();
    try {
      await vi.waitFor(() => expect(inspecting).toBe(true));
      await withFileLock(
        path.join(options.updaterDirectory, "operation.lock"),
        async () => {
          await fs.writeFile(
            path.join(
              options.updaterDirectory,
              "operations",
              `${operation.id}.json`,
            ),
            JSON.stringify({
              ...operation,
              phase: "reconnecting",
              updatedAt: operation.updatedAt + 1,
            }),
          );
        },
        { timeoutMs: 500 },
      );
    } finally {
      release();
    }
    expect((await reading).operation?.phase).toBe("reconnecting");
  });

  it("rereads worker progress on GET and marks a missing job interrupted", async () => {
    const { options, client, setState } = await setup();
    const operation = (await client().apply(confirmation)).operation!;
    const file = path.join(
      options.updaterDirectory,
      "operations",
      `${operation.id}.json`,
    );
    await fs.writeFile(
      file,
      JSON.stringify({
        ...operation,
        phase: "checking_health",
        secret: "/private/token",
        error: "raw logs /secret",
      }),
    );
    const status = await client().status();
    expect(status.operation).toMatchObject({
      phase: "checking_health",
      error: "update_job_failed",
    });
    expect(JSON.stringify(status)).not.toContain("/private");
    expect(JSON.stringify(status)).not.toContain("raw logs");
    setState("missing");
    expect((await client().status()).operation).toMatchObject({
      phase: "interrupted",
      error: "update_interrupted",
    });
  });

  it("never retries a launch whose response was lost while the real job runs", async () => {
    const { jobs, client, restart } = await setup();
    vi.mocked(jobs.launch).mockRejectedValue(
      new Error("response lost after Docker start"),
    );
    expect((await client().apply(confirmation)).operation?.phase).toBe(
      "queued",
    );
    await restart();
    expect((await client().status()).operation?.phase).toBe("queued");
    await expect(client().apply(confirmation)).rejects.toThrow(
      "update_operation_active",
    );
    expect(jobs.launch).toHaveBeenCalledTimes(1);
  });

  it("preserves stale cached notes and bounded check errors in public status", async () => {
    const { releases, client } = await setup();
    releases.snapshot = () => ({
      ...DISCOVERY,
      stale: true,
      status: "unavailable",
      error: "update_check_failed",
    });
    expect((await client().status()).discovery).toMatchObject({
      stale: true,
      status: "unavailable",
      error: "update_check_failed",
      releases: [{ notes: "Cached notes" }],
    });
  });

  it("does not infer interruption when Docker is unavailable", async () => {
    const { jobs, client, restart } = await setup();
    await client().apply(confirmation);
    vi.mocked(jobs.inspect).mockRejectedValue(new Error("secret socket path"));
    await restart();
    expect(await client().status()).toMatchObject({
      operation: { phase: "queued" },
      error: "update_job_status_unavailable",
    });
  });

  it("never converts source deployments or invokes discovery checks for them", async () => {
    const { client, call, jobs, releases } = await setup({
      readInstalled: async () => ({
        managed: false,
        version: null,
        commit: null,
        rollbackVersion: null,
      }),
    });
    expect(await client().status()).toMatchObject({
      managed: false,
      error: "update_source_build_unmanaged",
      discovery: { status: "unsupported" },
    });
    expect((await call("/apply", confirmation)).status).toBe(409);
    await client().check();
    expect(jobs.launch).not.toHaveBeenCalled();
    expect(releases.start).not.toHaveBeenCalled();
    expect(releases.check).not.toHaveBeenCalled();
  });

  it("forwards manual checks and preferences without adding notifications", async () => {
    const { client, releases } = await setup();
    await client().check();
    expect(releases.check).toHaveBeenCalledWith(true);
    expect(
      (
        await client().preferences({
          automaticChecks: false,
          includePreviews: true,
        })
      ).discovery,
    ).toMatchObject({ automaticChecks: false, includePreviews: true });
  });

  it("runs the fixed worker with complete operation data and durable progress", async () => {
    const { options, client } = await setup();
    const operation = (await client().apply(confirmation)).operation!;
    const runUpdate = vi.fn(
      async (
        request: Parameters<
          NonNullable<Parameters<typeof runUpdaterJob>[0]["runUpdate"]>
        >[0],
      ) => {
        expect(request).toMatchObject({
          deployDirectory: options.deployDirectory,
          updaterDirectory: options.updaterDirectory,
          operation: {
            id: operation.id,
            targetVersion: "2.3.4",
            fromVersion: "1.9.8",
          },
        });
        await request.onProgress("reconnecting");
        expect((await client().status()).operation?.phase).toBe("reconnecting");
      },
    );
    await runUpdaterJob({ ...options, operation: operation.id, runUpdate });
    expect((await client().status()).operation?.phase).toBe("completed");
    await expect(
      runUpdaterJob({ ...options, operation: operation.id, runUpdate }),
    ).rejects.toThrow("update_job_already_started");
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses the shared release client cache and persists preferences and offline notes across restart", async () => {
    const discover = vi.fn(async () => ({
      records: [
        {
          metadata: {
            schemaVersion: 1 as const,
            product: "assistant" as const,
            version: "2.3.4",
            tag: "assistant-v2.3.4",
            channel: "stable" as const,
            targets: {
              "linux-x64": "assistant-release.env",
              "linux-arm64": "assistant-release.env",
            },
            engines: {},
          },
          assets: ["assistant-release.env"],
          prerelease: false,
          notes: "Persistent release notes",
        },
      ],
      unverifiedVersions: [],
      complete: true,
    }));
    const { client, restart } = await setup({
      releases: undefined,
      releaseClient: { discover },
    });
    await client().check();
    expect((await client().status()).discovery.releases).toEqual([
      expect.objectContaining({
        version: "2.3.4",
        notes: "Persistent release notes",
      }),
    ]);
    await client().preferences({
      automaticChecks: false,
      includePreviews: true,
    });
    discover.mockRejectedValue(new Error("secret offline details"));
    await restart();
    const failed = await client().check();
    expect(failed.discovery).toMatchObject({
      automaticChecks: false,
      includePreviews: true,
      stale: true,
      status: "unavailable",
      releases: [
        expect.objectContaining({
          version: "2.3.4",
          notes: "Persistent release notes",
        }),
      ],
    });
    expect(JSON.stringify(failed)).not.toContain("secret offline details");
    await restart();
    expect((await client().status()).discovery).toMatchObject({
      automaticChecks: false,
      includePreviews: true,
      stale: true,
      releases: [
        expect.objectContaining({ notes: "Persistent release notes" }),
      ],
    });
  });

  it("persists worker failure without exposing raw errors", async () => {
    const { options, client } = await setup();
    const operation = (
      await client().rollback({ ...confirmation, version: "1.8.7" })
    ).operation!;
    await expect(
      runUpdaterJob({
        ...options,
        operation: operation.id,
        runRollback: async () => {
          throw new Error("token /private/rawlog");
        },
      }),
    ).rejects.toThrow("update_job_failed");
    expect((await client().status()).operation).toMatchObject({
      kind: "rollback",
      phase: "failed",
      error: "update_job_failed",
    });
  });
});

it("creates only a fixed privileged job and never starts a conflicting existing container", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "updater-docker-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "engine.sock");
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let conflict = false;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      calls.push({
        method: request.method!,
        url: request.url!,
        body: chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
          : null,
      });
      response.writeHead(
        request.url?.includes("create") ? (conflict ? 409 : 201) : 204,
      );
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const launcher = createDockerUpdaterJobLauncher({
    deployDirectory: "/srv/deploy",
    updaterDirectory: "/srv/updater",
    dockerSocket: socket,
    jobImage: "agentlink-updater@sha256:abc",
  });
  const operation: AssistantUpdateOperation = {
    id: "dd826d90-6a28-4a28-9545-fb3622413acb",
    kind: "update",
    fromVersion: "1.0.0",
    targetVersion: "2.3.4",
    phase: "queued",
    startedAt: 1,
    updatedAt: 1,
  };
  await launcher.launch(operation);
  expect(calls[0]).toMatchObject({
    body: {
      Image: "agentlink-updater@sha256:abc",
      Entrypoint: ["agentlink-server"],
      StopTimeout: 600,
      Cmd: [
        "updater-job",
        "--deploy-root",
        "/srv/deploy",
        "--updater-root",
        "/srv/updater",
        "--operation",
        operation.id,
      ],
      Labels: { "io.agentlink.updater.operation": operation.id },
      HostConfig: {
        Init: true,
        Binds: [
          "/srv/deploy:/srv/deploy:rw",
          "/srv/updater:/srv/updater:rw",
          `${socket}:${socket}:rw`,
        ],
        NetworkMode: "agentlink-updater-egress",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: ["DAC_OVERRIDE", "CHOWN"],
      },
    },
  });
  expect(calls).toHaveLength(2);
  conflict = true;
  await expect(launcher.launch(operation)).rejects.toThrow(
    "update_job_launch_failed",
  );
  expect(calls).toHaveLength(3);
});
