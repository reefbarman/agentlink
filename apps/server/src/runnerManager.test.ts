import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRunnerManagerClient,
  startRunnerManager,
  type DockerApi,
} from "./runnerManager.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface DockerCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/**
 * The Docker Engine API, in memory, recording what it is asked. The
 * manager's own container has the projects and runners' data mounted.
 */
function fakeDocker(mounts: { projects: string; data: string }) {
  const calls: DockerCall[] = [];
  const containers = new Map<string, { Labels: Record<string, string> }>();
  const api: DockerApi = async (method, requestPath, body) => {
    const url = new URL(requestPath, "http://docker");
    calls.push({ method, path: url.pathname, body });
    const name = /\/containers\/([^/]+)/u.exec(url.pathname)?.[1];
    if (method === "GET" && name === os.hostname()) {
      return {
        status: 200,
        body: {
          Mounts: [
            {
              Source: "/home/owner/assistant/projects",
              Destination: mounts.projects,
            },
            {
              Source: "/home/owner/assistant/data/runners",
              Destination: mounts.data,
            },
          ],
        },
      };
    }
    if (method === "POST" && url.pathname.endsWith("/create")) {
      containers.set(url.searchParams.get("name")!, {
        Labels: (body as { Labels: Record<string, string> }).Labels,
      });
      return { status: 201, body: { Id: "abc" } };
    }
    if (method === "POST" && url.pathname.endsWith("/start")) {
      return { status: 204, body: undefined };
    }
    if (method === "DELETE" && name) {
      return {
        status: containers.delete(name) ? 204 : 404,
        body: undefined,
      };
    }
    if (method === "GET" && url.pathname.endsWith("/containers/json")) {
      return { status: 200, body: [...containers.values()] };
    }
    return { status: 404, body: { message: "no such thing" } };
  };
  return { api, calls, containers };
}

async function setup(
  extra: {
    editor?: { image: string; network: string };
    browser?: { image: string; network: string };
  } = {
    editor: { image: "agentlink-editor:local", network: "agentlink-editors" },
    browser: {
      image: "agentlink-browser:local",
      network: "agentlink-browsers",
    },
  },
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "runner-manager-")),
  );
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, "projects");
  const data = path.join(root, "runners");
  const folder = path.join(projects, ".tasks", "t1");
  const dataFolder = path.join(data, "task-t1");
  await fs.mkdir(path.join(folder, "repo"), { recursive: true });
  await fs.mkdir(dataFolder, { recursive: true });
  await fs.mkdir(path.join(projects, "home"), { recursive: true });
  const docker = fakeDocker({ projects, data });
  const manager = await startRunnerManager({
    host: "127.0.0.1",
    port: 0,
    token: "manager-token",
    dockerSocket: "/var/run/docker.sock",
    dockerApi: docker.api,
    image: "agentlink-command-worker:local",
    network: "agentlink-runners",
    projectsRoot: projects,
    dataRoot: data,
    user: "1000:1000",
    limits: { memory: 2 * 1024 ** 3, cpus: 2, pids: 512 },
    ...(extra.editor ? { editor: extra.editor } : {}),
    ...(extra.browser ? { browser: extra.browser } : {}),
    log: () => undefined,
  });
  cleanup.push(() => manager.close());
  const client = (token = "manager-token") =>
    createRunnerManagerClient({
      host: "127.0.0.1",
      port: manager.port,
      readToken: async () => token,
    });
  return { root, projects, folder, dataFolder, docker, client };
}

describe("runner manager browsers", () => {
  it("starts headless Chromium with no mounts, no credentials and only the browsers' network", async () => {
    const test = await setup();
    const started = await test.client().startBrowser({
      id: "b-0123456789abcdef0123",
      proxy: "http://egress-gateway:3128",
    });
    expect(started).toEqual({
      host: "agentlink-browser-b-0123456789abcdef0123",
      port: 9222,
    });
    const create = test.docker.calls.find((call) =>
      call.path.endsWith("/create"),
    )!;
    const body = create.body as {
      Image: string;
      Env: string[];
      User: string;
      Cmd: string[];
      Entrypoint: string[];
      HostConfig: Record<string, unknown>;
    };
    expect(body.Image).toBe("agentlink-browser:local");
    expect(body.Entrypoint).toEqual(["/usr/local/bin/agentlink-browser"]);
    expect(body.Cmd).toEqual(["--proxy-server=http://egress-gateway:3128"]);
    expect(body.User).toBe("1000:1000");
    // Nothing from the caller but the proxy's address: no credentials.
    expect(body.Env).toEqual(["HOME=/tmp/home"]);
    expect(JSON.stringify(body)).not.toMatch(/token|password|secret|@/iu);
    expect(body.HostConfig.Binds).toBeUndefined();
    expect(body.HostConfig.Mounts).toBeUndefined();
    expect(body.HostConfig.Privileged).toBeUndefined();
    expect(body.HostConfig).toMatchObject({
      NetworkMode: "agentlink-browsers",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 2 * 1024 ** 3,
      PidsLimit: 512,
    });

    await test.client().stopBrowser("b-0123456789abcdef0123");
    expect(test.docker.containers.size).toBe(0);
  });

  it("refuses a proxy with credentials, a bad id, and browsers when not configured", async () => {
    const test = await setup();
    for (const request of [
      { id: "b-1", proxy: "http://user:pass@egress-gateway:3128" },
      { id: "b-1", proxy: "https://egress-gateway:3128" },
      { id: "b-1", proxy: "http://egress-gateway" },
      { id: "../x", proxy: "http://egress-gateway:3128" },
    ]) {
      await expect(
        test.client().startBrowser(request),
        JSON.stringify(request),
      ).rejects.toMatchObject({ status: 400 });
    }
    const without = await setup({});
    await expect(
      without
        .client()
        .startBrowser({ id: "b-1", proxy: "http://egress-gateway:3128" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("stops every browser it started", async () => {
    const test = await setup();
    await test
      .client()
      .startBrowser({ id: "b-1", proxy: "http://egress-gateway:3128" });
    await test
      .client()
      .startBrowser({ id: "b-2", proxy: "http://egress-gateway:3128" });
    await expect(test.client().stopAllBrowsers()).resolves.toEqual({
      stopped: 2,
    });
    expect(test.docker.containers.size).toBe(0);
  });
});

describe("runner manager editors", () => {
  it("starts code-server on the task folder only, read-only or not, with nothing but the proxy", async () => {
    const test = await setup();
    // A file and an old AgentLink state folder and a symlink beside the repo.
    await fs.writeFile(path.join(test.folder, "notes.txt"), "x");
    await fs.mkdir(path.join(test.folder, ".agentlink"));
    await fs.symlink("/etc", path.join(test.folder, "escape"));
    const started = await test.client().startEditor({
      id: "task-t1",
      folder: test.folder,
      mode: "ro",
      proxy: "http://u:p@egress-gateway:3128",
      settings: { "agentlink.disabledProviders": ["codex"] },
      noProxy: ["assistant"],
    });
    expect(started.url).toBe("http://agentlink-editor-task-t1:8080");
    const create = test.docker.calls.find((call) =>
      call.path.endsWith("/create"),
    )!;
    const body = create.body as {
      Image: string;
      Env: string[];
      User: string;
      Cmd: string[];
      Entrypoint: string[];
      HostConfig: Record<string, unknown>;
    };
    expect(body.Image).toBe("agentlink-editor:local");
    // The image's start script writes the settings, then runs code-server.
    expect(body.Entrypoint).toEqual(["/usr/local/bin/agentlink-editor"]);
    expect(body.User).toBe("1000:1000");
    expect(body.Cmd).toContain("none");
    expect(body.Cmd.at(-1)).toBe(test.folder);
    // Only the task folder's entries, on the host's path, and read-only,
    // over a scratch folder where AgentLink keeps its own chats; no
    // symlinks and no old state.
    const host = "/home/owner/assistant/projects/.tasks/t1";
    expect(body.HostConfig.Binds).toBeUndefined();
    expect(body.HostConfig.Mounts).toEqual([
      {
        Type: "tmpfs",
        Target: test.folder,
        TmpfsOptions: { SizeBytes: 256 * 1024 * 1024, Mode: 0o1777 },
      },
      {
        Type: "bind",
        Source: `${host}/notes.txt`,
        Target: path.join(test.folder, "notes.txt"),
        ReadOnly: true,
      },
      {
        Type: "bind",
        Source: `${host}/repo`,
        Target: path.join(test.folder, "repo"),
        ReadOnly: true,
      },
    ]);
    expect(body.HostConfig).toMatchObject({
      NetworkMode: "agentlink-editors",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
    });
    expect(body.Env).toEqual([
      "HOME=/tmp/home",
      "HTTPS_PROXY=http://u:p@egress-gateway:3128",
      "HTTP_PROXY=http://u:p@egress-gateway:3128",
      "NO_PROXY=localhost,127.0.0.1,assistant",
      'AGENTLINK_EDITOR_SETTINGS={"agentlink.disabledProviders":["codex"]}',
    ]);

    await test.client().startEditor({
      id: "task-t1",
      folder: test.folder,
      mode: "rw",
    });
    const second = test.docker.calls.filter((call) =>
      call.path.endsWith("/create"),
    )[1]!.body as {
      HostConfig: { Binds: string[]; Mounts?: unknown };
      Env: string[];
    };
    // Taken over: the whole task folder, writable.
    expect(second.HostConfig.Binds).toEqual([`${host}:${test.folder}:rw`]);
    expect(second.HostConfig.Mounts).toBeUndefined();
    expect(second.Env).toEqual(["HOME=/tmp/home"]);
    await expect(test.client().stopAllEditors()).resolves.toEqual({
      stopped: 1,
    });
  });

  it("refuses other folders, bad modes and proxies, and editors when not configured", async () => {
    const test = await setup();
    const client = test.client();
    for (const request of [
      { id: "task-t1", folder: path.join(test.projects, "home"), mode: "rw" },
      { id: "task-t1", folder: test.dataFolder, mode: "rw" },
      { id: "task-t1", folder: test.folder, mode: "write" },
      {
        id: "task-t1",
        folder: test.folder,
        mode: "ro",
        proxy: "https://x y",
      },
      { id: "task-t1", folder: test.folder, mode: "ro", settings: ["x"] },
      {
        id: "task-t1",
        folder: test.folder,
        mode: "ro",
        settings: { big: "x".repeat(300 * 1024) },
      },
      {
        id: "task-t1",
        folder: test.folder,
        mode: "ro",
        noProxy: ["evil host,*"],
      },
    ]) {
      await expect(client.startEditor(request as never)).rejects.toMatchObject({
        status: 400,
      });
    }
    const without = await setup({});
    await expect(
      without
        .client()
        .startEditor({ id: "task-t1", folder: without.folder, mode: "ro" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

const env = {
  AGENTLINK_RUNNER_TOKEN: "runner-token",
  AGENTLINK_RUNNER_CONTROL_URL: "http://assistant:7500",
  AGENTLINK_RUNNER_SPEC: "{}",
};

describe("runner manager", () => {
  it("starts a locked-down runner with only the task's folder and its data mounted", async () => {
    const harness = await setup();
    await expect(
      harness.client().start({
        id: "task-t1",
        folder: harness.folder,
        dataFolder: harness.dataFolder,
        env,
      }),
    ).resolves.toEqual({ url: "http://agentlink-runner-task-t1:7600" });
    const created = harness.docker.calls.find((call) =>
      call.path.endsWith("/containers/create"),
    )!.body as {
      Image: string;
      User: string;
      Env: string[];
      HostConfig: Record<string, unknown> & { Binds: string[] };
    };
    expect(created.Image).toBe("agentlink-command-worker:local");
    expect(created.User).toBe("1000:1000");
    expect(created.HostConfig.Binds).toEqual([
      `/home/owner/assistant/projects/.tasks/t1:${harness.folder}:rw`,
      "/home/owner/assistant/data/runners/task-t1:/var/lib/agentlink-runner:rw",
    ]);
    // Nothing else: no Docker socket, no other project, no server data.
    expect(JSON.stringify(created)).not.toContain("docker.sock");
    expect(created.HostConfig).toMatchObject({
      NetworkMode: "agentlink-runners",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 2 * 1024 ** 3,
      NanoCpus: 2e9,
      PidsLimit: 512,
    });
    expect(created.HostConfig.Privileged).toBeUndefined();
    expect(created.Env.sort()).toEqual([
      "AGENTLINK_RUNNER_CONTROL_URL=http://assistant:7500",
      "AGENTLINK_RUNNER_SPEC={}",
      "AGENTLINK_RUNNER_TOKEN=runner-token",
    ]);
  });

  it("refuses other folders, extra environment and the wrong token", async () => {
    const harness = await setup();
    const start = (overrides: Record<string, unknown>) =>
      harness.client().start({
        id: "task-t1",
        folder: harness.folder,
        dataFolder: harness.dataFolder,
        env,
        ...overrides,
      } as never);
    // A project that is not a task, the tasks root itself, outside paths.
    for (const folder of [
      path.join(harness.projects, "home"),
      path.join(harness.projects, ".tasks"),
      path.join(harness.projects, ".tasks", "t1", "..", "..", "home"),
      "/etc",
    ]) {
      await expect(start({ folder })).rejects.toMatchObject({
        code: "folder_invalid",
      });
    }
    // A symlink inside the tasks root that points elsewhere.
    const link = path.join(harness.projects, ".tasks", "sneaky");
    await fs.symlink(path.join(harness.projects, "home"), link);
    await expect(start({ folder: link })).rejects.toMatchObject({
      code: "folder_invalid",
    });
    await expect(start({ dataFolder: harness.folder })).rejects.toMatchObject({
      code: "data_folder_invalid",
    });
    await expect(
      start({ env: { ...env, LD_PRELOAD: "/tmp/x.so" } }),
    ).rejects.toMatchObject({ code: "env_invalid" });
    await expect(start({ id: "../../etc" })).rejects.toMatchObject({
      code: "runner_id_invalid",
    });
    await expect(
      harness.client("wrong").start({
        id: "task-t1",
        folder: harness.folder,
        dataFolder: harness.dataFolder,
        env,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(
      harness.docker.calls.some((call) => call.path.endsWith("/create")),
    ).toBe(false);
  });

  it("replaces a runner on start, and stops one or all of them", async () => {
    const harness = await setup();
    const request = {
      id: "task-t1",
      folder: harness.folder,
      dataFolder: harness.dataFolder,
      env,
    };
    await harness.client().start(request);
    await harness.client().start(request);
    expect(harness.docker.containers.size).toBe(1);
    await harness.client().stop("task-t1");
    expect(harness.docker.containers.size).toBe(0);
    await harness.client().start(request);
    await expect(harness.client().stopAll()).resolves.toEqual({ stopped: 1 });
    expect(harness.docker.containers.size).toBe(0);
  });
});
