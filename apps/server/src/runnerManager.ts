import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { HttpError } from "./httpJson.js";
import {
  createRunnerHttpClient,
  sameToken,
  startRunnerHttpServer,
  type RunnerHttpServer,
} from "./runnerProtocol.js";
import { RUNNER_DATA_ROOT, RUNNER_ENV, RUNNER_PORT } from "./sessionRunner.js";

/**
 * The runner manager: the only AgentLink process with the Docker socket
 * (which is root-equivalent), so the control plane never has it. It
 * accepts exactly two requests from the control plane's token, "start a
 * runner for task X with folder F and data folder D" and "stop runner X",
 * and decides everything else itself: the image, the user, the limits, the
 * internal network, a read-only root filesystem, no capabilities, and only
 * F and D mounted. F must be a task folder under the projects root and D a
 * folder under the runners' data root; neither may be a symlink.
 *
 * Paths: the control plane names folders as it sees them. The manager has
 * the same folders mounted at the same paths and reads its own container's
 * mounts to find where they are on the Docker host, which is what Docker
 * needs for a bind mount (unless `hostPaths` are given).
 */

export const RUNNER_MANAGER_PORT = 7700;
const DOCKER_API = "/v1.41";
const RUNNER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const RUNNER_LABEL = "dev.agentlink.runner";
const MAX_ENV_VALUE_BYTES = 64 * 1024;
const ALLOWED_ENV = new Set<string>(Object.values(RUNNER_ENV));
const EDITOR_LABEL = "dev.agentlink.editor";
/** The port code-server listens on inside an editor container. */
export const EDITOR_PORT = 8080;
const MAX_PROXY_URL_LENGTH = 4_096;
const MAX_EDITOR_SETTINGS_BYTES = 256 * 1024;
const MAX_NO_PROXY_HOSTS = 8;
const HOST_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
/**
 * The editor image's start script: writes `AGENTLINK_EDITOR_SETTINGS` as
 * the editor's settings, then runs code-server with the arguments.
 */
export const EDITOR_ENTRYPOINT = "/usr/local/bin/agentlink-editor";
/** AgentLink's own state folder in the editor's workspace (the task folder). */
const EDITOR_STATE_FOLDER = ".agentlink";
const BROWSER_LABEL = "dev.agentlink.browser";
/** The DevTools port headless Chromium listens on inside a browser. */
export const BROWSER_PORT = 9222;
/** The browser image's start script: headless Chromium with fixed flags. */
export const BROWSER_ENTRYPOINT = "/usr/local/bin/agentlink-browser";
/** `http://host:port` with no credentials: Chromium cannot take them. */
const BROWSER_PROXY_PATTERN =
  /^http:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?:\d{1,5}$/u;
const MAX_READ_ONLY_ENTRIES = 64;
const READ_ONLY_SCRATCH_BYTES = 256 * 1024 * 1024;

/**
 * Docker mounts for a read-only editor. AgentLink keeps its chats in
 * `<workspace>/.agentlink`, and Docker cannot create a mount point inside a
 * read-only bind, so the task folder itself is a small scratch tmpfs with
 * each of its entries bound read-only beneath it: the editor can write its
 * own state (lost when it stops) but nothing of the task's. Symlinks and
 * any existing `.agentlink` are left out.
 */
async function readOnlyEditorMounts(
  folder: string,
  hostFolder: string,
): Promise<Array<Record<string, unknown>>> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const kept = entries.filter(
    (entry) =>
      entry.name !== EDITOR_STATE_FOLDER &&
      (entry.isDirectory() || entry.isFile()),
  );
  if (kept.length > MAX_READ_ONLY_ENTRIES) {
    throw new HttpError(400, "folder_too_many_entries");
  }
  return [
    {
      Type: "tmpfs",
      Target: folder,
      TmpfsOptions: { SizeBytes: READ_ONLY_SCRATCH_BYTES, Mode: 0o1777 },
    },
    ...kept
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({
        Type: "bind",
        Source: path.join(hostFolder, name),
        Target: path.join(folder, name),
        ReadOnly: true,
      })),
  ];
}

export interface RunnerLimits {
  /** Bytes. */
  readonly memory: number;
  readonly cpus: number;
  readonly pids: number;
}

export interface RunnerManagerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly dockerSocket: string;
  readonly image: string;
  /** The internal Docker network runners join. */
  readonly network: string;
  /** Where task folders are (`<projectsRoot>/.tasks/<task>`). */
  readonly projectsRoot: string;
  /** Where runners' data folders are. */
  readonly dataRoot: string;
  /**
   * The Docker host's paths for `projectsRoot` and `dataRoot`. Read from
   * this container's own mounts when not given.
   */
  readonly hostPaths?: { readonly projects: string; readonly data: string };
  /** `uid:gid` the runner runs as. */
  readonly user: string;
  readonly limits: RunnerLimits;
  /**
   * Browser editors (code-server) for task folders, on their own internal
   * network. Without it the manager refuses to start editors.
   */
  readonly editor?: { readonly image: string; readonly network: string };
  /**
   * Throwaway headless browsers for research, on their own internal
   * network. Without it the manager refuses to start browsers.
   */
  readonly browser?: { readonly image: string; readonly network: string };
  readonly log: (line: string) => void;
  /** Tests: answer Docker API requests instead of the socket. */
  readonly dockerApi?: DockerApi;
}

export type DockerApi = (
  method: string,
  requestPath: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export interface RunnerManager {
  readonly port: number;
  close(): Promise<void>;
}

/** One request to the Docker Engine API over its Unix socket. */
export async function dockerRequest(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return await new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        socketPath,
        method,
        path: `${DOCKER_API}${requestPath}`,
        headers: {
          host: "docker",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Plain text (for example an error message).
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function dockerError(
  action: string,
  result: { status: number; body: unknown },
) {
  const message =
    result.body && typeof result.body === "object"
      ? String((result.body as { message?: unknown }).message ?? "")
      : String(result.body ?? "");
  return Object.assign(
    new Error(`Docker could not ${action} (${result.status}): ${message}`),
    { code: "docker_failed" },
  );
}

/** The Docker host path of `containerPath`, from this container's mounts. */
async function hostPathsFromOwnMounts(
  docker: DockerApi,
  roots: { readonly projects: string; readonly data: string },
): Promise<{ readonly projects: string; readonly data: string }> {
  const self = await docker(
    "GET",
    `/containers/${encodeURIComponent(os.hostname())}/json`,
  );
  if (self.status !== 200) {
    throw new Error(
      "The runner manager could not read its own container's mounts; pass --projects-host-root and --data-host-root",
    );
  }
  const mounts = ((self.body as { Mounts?: unknown }).Mounts ?? []) as Array<{
    Source?: string;
    Destination?: string;
  }>;
  const find = (target: string) => {
    for (const mount of mounts) {
      if (!mount.Source || !mount.Destination) continue;
      const relative = path.relative(mount.Destination, target);
      if (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      ) {
        return path.join(mount.Source, relative);
      }
    }
    throw new Error(
      `${target} is not a mount of the runner manager's container`,
    );
  };
  return { projects: find(roots.projects), data: find(roots.data) };
}

/** `candidate` exists, is a directory, has no symlinks, and is inside `root`. */
async function checkFolder(
  candidate: unknown,
  root: string,
  code: string,
): Promise<string> {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new HttpError(400, code);
  }
  const canonical = await fs.realpath(candidate).catch(() => undefined);
  const relative = canonical ? path.relative(root, canonical) : "..";
  if (
    canonical !== candidate ||
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new HttpError(400, code);
  }
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new HttpError(400, code);
  return canonical;
}

export function runnerContainerName(id: string): string {
  return `agentlink-runner-${id}`;
}

export function editorContainerName(id: string): string {
  return `agentlink-editor-${id}`;
}

export function browserContainerName(id: string): string {
  return `agentlink-browser-${id}`;
}

export async function startRunnerManager(
  options: RunnerManagerOptions,
): Promise<RunnerManager> {
  const docker: DockerApi =
    options.dockerApi ??
    ((method, requestPath, body) =>
      dockerRequest(options.dockerSocket, method, requestPath, body));
  const projectsRoot = await fs.realpath(options.projectsRoot);
  const dataRoot = await fs.realpath(options.dataRoot);
  const tasksRoot = path.join(projectsRoot, ".tasks");
  const hostPaths =
    options.hostPaths ??
    (await hostPathsFromOwnMounts(docker, {
      projects: projectsRoot,
      data: dataRoot,
    }));
  const onHost = (folder: string, root: string, hostRoot: string) =>
    path.join(hostRoot, path.relative(root, folder));

  const remove = async (id: string) => {
    const result = await docker(
      "DELETE",
      `/containers/${runnerContainerName(id)}?force=true`,
    );
    if (result.status !== 204 && result.status !== 404) {
      throw dockerError("remove a runner", result);
    }
  };

  const start = async (body: Record<string, unknown>) => {
    const id = body.id;
    if (typeof id !== "string" || !RUNNER_ID_PATTERN.test(id)) {
      throw new HttpError(400, "runner_id_invalid");
    }
    const folder = await checkFolder(body.folder, tasksRoot, "folder_invalid");
    const dataFolder = await checkFolder(
      body.dataFolder,
      dataRoot,
      "data_folder_invalid",
    );
    const env = body.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new HttpError(400, "env_invalid");
    }
    const entries = Object.entries(env as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (
        !ALLOWED_ENV.has(key) ||
        typeof value !== "string" ||
        Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES
      ) {
        throw new HttpError(400, "env_invalid");
      }
    }
    const name = runnerContainerName(id);
    await remove(id);
    const created = await docker(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      {
        Image: options.image,
        Entrypoint: ["agentlink-server", "session-runner"],
        Cmd: ["--data", RUNNER_DATA_ROOT],
        User: options.user,
        WorkingDir: folder,
        Env: entries.map(([key, value]) => `${key}=${String(value)}`),
        Labels: { [RUNNER_LABEL]: id },
        ExposedPorts: { [`${RUNNER_PORT}/tcp`]: {} },
        HostConfig: {
          Binds: [
            `${onHost(folder, projectsRoot, hostPaths.projects)}:${folder}:rw`,
            `${onHost(dataFolder, dataRoot, hostPaths.data)}:${RUNNER_DATA_ROOT}:rw`,
          ],
          NetworkMode: options.network,
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "size=1g,mode=1777" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Init: true,
          Memory: options.limits.memory,
          NanoCpus: Math.round(options.limits.cpus * 1e9),
          PidsLimit: options.limits.pids,
          // A crash restarts it; its next start records the session
          // interrupted and the control plane carries on.
          RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
          LogConfig: {
            Type: "json-file",
            Config: { "max-size": "10m", "max-file": "2" },
          },
        },
      },
    );
    if (created.status !== 201) throw dockerError("create a runner", created);
    const started = await docker("POST", `/containers/${name}/start`);
    if (started.status !== 204 && started.status !== 304) {
      throw dockerError("start a runner", started);
    }
    options.log(`Started runner ${name}`);
    return { url: `http://${name}:${RUNNER_PORT}` };
  };

  const stopAll = async () => {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [RUNNER_LABEL] }),
    );
    const listed = await docker(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    if (listed.status !== 200) throw dockerError("list runners", listed);
    let stopped = 0;
    for (const container of (listed.body ?? []) as Array<{
      Labels?: Record<string, string>;
    }>) {
      const id = container.Labels?.[RUNNER_LABEL];
      if (id && RUNNER_ID_PATTERN.test(id)) {
        await remove(id);
        stopped += 1;
      }
    }
    return { stopped };
  };

  const removeEditor = async (id: string) => {
    const result = await docker(
      "DELETE",
      `/containers/${editorContainerName(id)}?force=true`,
    );
    if (result.status !== 204 && result.status !== 404) {
      throw dockerError("remove an editor", result);
    }
  };

  /**
   * An editor for one task folder: code-server, mounted read-only or
   * read-write, with no credentials, a read-only root filesystem, the
   * runners' limits, and only the editors' internal network. `proxy` (the
   * egress gateway, with credentials the assistant signed for extension
   * downloads) is the only environment it gets from the caller.
   */
  const startEditor = async (body: Record<string, unknown>) => {
    const editor = options.editor;
    if (!editor) throw new HttpError(409, "editors_not_configured");
    const id = body.id;
    if (typeof id !== "string" || !RUNNER_ID_PATTERN.test(id)) {
      throw new HttpError(400, "editor_id_invalid");
    }
    const folder = await checkFolder(body.folder, tasksRoot, "folder_invalid");
    if (body.mode !== "ro" && body.mode !== "rw") {
      throw new HttpError(400, "editor_mode_invalid");
    }
    const proxy = body.proxy;
    if (
      proxy !== undefined &&
      (typeof proxy !== "string" ||
        !/^http:\/\/\S+$/u.test(proxy) ||
        proxy.length > MAX_PROXY_URL_LENGTH)
    ) {
      throw new HttpError(400, "editor_proxy_invalid");
    }
    // AgentLink's settings, with the editor's own model token: only this
    // editor's environment gets them.
    const settings = body.settings;
    let settingsJson: string | undefined;
    if (settings !== undefined) {
      if (
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings)
      ) {
        throw new HttpError(400, "editor_settings_invalid");
      }
      settingsJson = JSON.stringify(settings);
      if (Buffer.byteLength(settingsJson) > MAX_EDITOR_SETTINGS_BYTES) {
        throw new HttpError(400, "editor_settings_invalid");
      }
    }
    const noProxy = body.noProxy ?? [];
    if (
      !Array.isArray(noProxy) ||
      noProxy.length > MAX_NO_PROXY_HOSTS ||
      noProxy.some(
        (host) => typeof host !== "string" || !HOST_NAME_PATTERN.test(host),
      )
    ) {
      throw new HttpError(400, "editor_no_proxy_invalid");
    }
    const hostFolder = onHost(folder, projectsRoot, hostPaths.projects);
    const mounts =
      body.mode === "ro"
        ? { Mounts: await readOnlyEditorMounts(folder, hostFolder) }
        : { Binds: [`${hostFolder}:${folder}:rw`] };
    const name = editorContainerName(id);
    await removeEditor(id);
    const created = await docker(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      {
        Image: editor.image,
        Entrypoint: [EDITOR_ENTRYPOINT],
        Cmd: [
          "--bind-addr",
          `0.0.0.0:${EDITOR_PORT}`,
          // The assistant's editor listener signs the owner in.
          "--auth",
          "none",
          "--disable-telemetry",
          "--disable-update-check",
          "--disable-workspace-trust",
          "--user-data-dir",
          "/tmp/code-server/data",
          "--extensions-dir",
          "/tmp/code-server/extensions",
          folder,
        ],
        User: options.user,
        WorkingDir: folder,
        Env: [
          "HOME=/tmp/home",
          ...(typeof proxy === "string"
            ? [
                `HTTPS_PROXY=${proxy}`,
                `HTTP_PROXY=${proxy}`,
                `NO_PROXY=${["localhost", "127.0.0.1", ...(noProxy as string[])].join(",")}`,
              ]
            : []),
          ...(settingsJson
            ? [`AGENTLINK_EDITOR_SETTINGS=${settingsJson}`]
            : []),
        ],
        Labels: { [EDITOR_LABEL]: id },
        ExposedPorts: { [`${EDITOR_PORT}/tcp`]: {} },
        HostConfig: {
          ...mounts,
          NetworkMode: editor.network,
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "size=1g,mode=1777" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Init: true,
          Memory: options.limits.memory,
          NanoCpus: Math.round(options.limits.cpus * 1e9),
          PidsLimit: options.limits.pids,
          LogConfig: {
            Type: "json-file",
            Config: { "max-size": "10m", "max-file": "2" },
          },
        },
      },
    );
    if (created.status !== 201) throw dockerError("create an editor", created);
    const started = await docker("POST", `/containers/${name}/start`);
    if (started.status !== 204 && started.status !== 304) {
      throw dockerError("start an editor", started);
    }
    options.log(`Started editor ${name} (${body.mode})`);
    return { url: `http://${name}:${EDITOR_PORT}` };
  };

  const stopAllEditors = async () => {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [EDITOR_LABEL] }),
    );
    const listed = await docker(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    if (listed.status !== 200) throw dockerError("list editors", listed);
    let stopped = 0;
    for (const container of (listed.body ?? []) as Array<{
      Labels?: Record<string, string>;
    }>) {
      const id = container.Labels?.[EDITOR_LABEL];
      if (id && RUNNER_ID_PATTERN.test(id)) {
        await removeEditor(id);
        stopped += 1;
      }
    }
    return { stopped };
  };

  const removeBrowser = async (id: string) => {
    const result = await docker(
      "DELETE",
      `/containers/${browserContainerName(id)}?force=true`,
    );
    if (result.status !== 204 && result.status !== 404) {
      throw dockerError("remove a browser", result);
    }
  };

  /**
   * A throwaway browser: headless Chromium with a fresh profile in /tmp, no
   * mounts at all, no credentials or environment from the caller, a
   * read-only root filesystem, the runners' limits, and only the browsers'
   * internal network. Everything it fetches goes through `proxy` (the
   * egress gateway); the caller answers the gateway's challenge over the
   * DevTools protocol, so no credentials are in the container.
   */
  const startBrowser = async (body: Record<string, unknown>) => {
    const browser = options.browser;
    if (!browser) throw new HttpError(409, "browsers_not_configured");
    const id = body.id;
    if (typeof id !== "string" || !RUNNER_ID_PATTERN.test(id)) {
      throw new HttpError(400, "browser_id_invalid");
    }
    const proxy = body.proxy;
    if (typeof proxy !== "string" || !BROWSER_PROXY_PATTERN.test(proxy)) {
      throw new HttpError(400, "browser_proxy_invalid");
    }
    const name = browserContainerName(id);
    await removeBrowser(id);
    const created = await docker(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      {
        Image: browser.image,
        Entrypoint: [BROWSER_ENTRYPOINT],
        Cmd: [`--proxy-server=${proxy}`],
        User: options.user,
        Env: ["HOME=/tmp/home"],
        Labels: { [BROWSER_LABEL]: id },
        ExposedPorts: { [`${BROWSER_PORT}/tcp`]: {} },
        HostConfig: {
          NetworkMode: browser.network,
          ReadonlyRootfs: true,
          Tmpfs: { "/tmp": "size=1g,mode=1777" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Init: true,
          Memory: options.limits.memory,
          NanoCpus: Math.round(options.limits.cpus * 1e9),
          PidsLimit: options.limits.pids,
          LogConfig: {
            Type: "json-file",
            Config: { "max-size": "10m", "max-file": "2" },
          },
        },
      },
    );
    if (created.status !== 201) throw dockerError("create a browser", created);
    const started = await docker("POST", `/containers/${name}/start`);
    if (started.status !== 204 && started.status !== 304) {
      throw dockerError("start a browser", started);
    }
    options.log(`Started browser ${name}`);
    return { host: name, port: BROWSER_PORT };
  };

  const stopAllBrowsers = async () => {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [BROWSER_LABEL] }),
    );
    const listed = await docker(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    if (listed.status !== 200) throw dockerError("list browsers", listed);
    let stopped = 0;
    for (const container of (listed.body ?? []) as Array<{
      Labels?: Record<string, string>;
    }>) {
      const id = container.Labels?.[BROWSER_LABEL];
      if (id && RUNNER_ID_PATTERN.test(id)) {
        await removeBrowser(id);
        stopped += 1;
      }
    }
    return { stopped };
  };

  const server: RunnerHttpServer = await startRunnerHttpServer({
    host: options.host,
    port: options.port,
    authorize: (presented) =>
      sameToken(options.token, presented) ? true : undefined,
    routes: () => ({
      "/browsers/start": async (body) => await startBrowser(body),
      "/browsers/stop": async (body) => {
        if (typeof body.id !== "string" || !RUNNER_ID_PATTERN.test(body.id)) {
          throw new HttpError(400, "browser_id_invalid");
        }
        await removeBrowser(body.id);
        return { stopped: true };
      },
      "/browsers/stop-all": async () =>
        options.browser ? await stopAllBrowsers() : { stopped: 0 },
      "/editors/start": async (body) => await startEditor(body),
      "/editors/stop": async (body) => {
        if (typeof body.id !== "string" || !RUNNER_ID_PATTERN.test(body.id)) {
          throw new HttpError(400, "editor_id_invalid");
        }
        await removeEditor(body.id);
        return { stopped: true };
      },
      "/editors/stop-all": async () =>
        options.editor ? await stopAllEditors() : { stopped: 0 },
      "/runners/start": async (body) => await start(body),
      "/runners/stop": async (body) => {
        if (typeof body.id !== "string" || !RUNNER_ID_PATTERN.test(body.id)) {
          throw new HttpError(400, "runner_id_invalid");
        }
        await remove(body.id);
        return { stopped: true };
      },
      "/runners/stop-all": async () => await stopAll(),
    }),
  });
  return {
    port: server.port,
    close: () => server.close(),
  };
}

/** The control plane's side: start and stop runners. */
export function createRunnerManagerClient(options: {
  readonly host: string;
  readonly port: number;
  readonly readToken: () => Promise<string>;
}) {
  let token: string | undefined;
  const client = createRunnerHttpClient({
    baseUrl: `http://${options.host}:${options.port}`,
    token: () => token ?? "",
  });
  const withToken = async <T>(run: () => Promise<T>) => {
    token = await options.readToken();
    return await run();
  };
  return {
    start: (request: {
      readonly id: string;
      readonly folder: string;
      readonly dataFolder: string;
      readonly env: Readonly<Record<string, string>>;
    }) =>
      withToken(() =>
        client.call<{ url: string }>("/runners/start", { ...request }),
      ),
    stop: (id: string) => withToken(() => client.call("/runners/stop", { id })),
    stopAll: () =>
      withToken(() =>
        client.call<{ stopped: number }>("/runners/stop-all", {}),
      ),
    ping: () => withToken(() => client.health()),
    startEditor: (request: {
      readonly id: string;
      readonly folder: string;
      readonly mode: "ro" | "rw";
      readonly proxy?: string;
      readonly settings?: Record<string, unknown>;
      readonly noProxy?: readonly string[];
    }) =>
      withToken(() =>
        client.call<{ url: string }>("/editors/start", { ...request }),
      ),
    stopEditor: (id: string) =>
      withToken(() => client.call("/editors/stop", { id })),
    stopAllEditors: () =>
      withToken(() =>
        client.call<{ stopped: number }>("/editors/stop-all", {}),
      ),
    startBrowser: (request: { readonly id: string; readonly proxy: string }) =>
      withToken(() =>
        client.call<{ host: string; port: number }>("/browsers/start", {
          ...request,
        }),
      ),
    stopBrowser: (id: string) =>
      withToken(() => client.call("/browsers/stop", { id })),
    stopAllBrowsers: () =>
      withToken(() =>
        client.call<{ stopped: number }>("/browsers/stop-all", {}),
      ),
  };
}

export type RunnerManagerClient = ReturnType<typeof createRunnerManagerClient>;
