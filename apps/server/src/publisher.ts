import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { tokensMatch } from "./commandWorkerProtocol.js";
import {
  GitHubError,
  createGitHubApi,
  parseGitHubRepository,
  type GitHubApi,
  type PullRequest,
  type ReachableRepository,
} from "./githubApi.js";
import {
  CONNECTION_ID_PATTERN,
  openCredentialVault,
  type CredentialVault,
  type StoredCredential,
} from "./publisherVault.js";
import { TASK_BRANCH_PREFIX, isSafeBranchName } from "./taskStore.js";

/**
 * The publisher holds every GitHub connection's token and makes the only
 * GitHub effects a task can have: push its commit to its own `agentlink/*`
 * branch (never forced) and open or update its draft pull request. It runs
 * in its own container with the task workspaces mounted read-only, and
 * answers only the assistant server, which authenticates with a shared
 * token over a private network. Tokens never leave this process.
 *
 * It never runs git inside a task's clone: the agent controls that folder,
 * including its hooks and config. Each publish fetches the task branch into
 * a scratch repository of its own, checks it is exactly the commit asked
 * for, and pushes from there.
 *
 * It also fetches a repository's base branch for a new task (`snapshot`),
 * so private repositories can be cloned without their token reaching the
 * server: the server receives a git bundle and clones from that. And it
 * lists the repositories each connection can reach (names and metadata
 * only), so the assistant can find them without a token.
 */

export const PUBLISHER_PROTOCOL = 1;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 256;
const MAX_PR_BODY_LENGTH = 60_000;
/** Refresh a token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const GIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_GIT_OUTPUT = 64 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/u;
/** Header naming the branch a snapshot bundle holds. */
export const SNAPSHOT_BRANCH_HEADER = "x-agentlink-branch";

export class PublisherError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PublisherError";
  }
}

export interface GitRunResult {
  readonly exitCode: number | undefined;
  readonly output: string;
}

/** Runs git on this machine with exactly the given environment. */
export type LocalGit = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  },
) => Promise<GitRunResult>;

export interface PublisherOptions {
  readonly host: string;
  readonly port: number;
  /** Shared with the assistant server. */
  readonly token: string;
  /** Where task workspaces are mounted (read-only), at the server's path. */
  readonly tasksRoot: string;
  /** Holds the encrypted connections and scratch repositories. */
  readonly dataDirectory: string;
  readonly vaultKey: Buffer;
  /** The GitHub App's client ID; without it only pasted tokens work. */
  readonly clientId?: string;
  readonly github?: GitHubApi;
  readonly git?: LocalGit;
  readonly gitExecutable?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface Publisher {
  readonly port: number;
  close(): Promise<void>;
}

/** What the server asks the publisher to publish. */
export interface PublishRequest {
  readonly connectionId: string;
  /** `https://github.com/<owner>/<name>`. */
  readonly repository: string;
  /** The task's clone, under the tasks root. */
  readonly workspace: string;
  /** `agentlink/...`. */
  readonly branch: string;
  /** The exact commit to publish; the branch must point at it. */
  readonly commit: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
}

/** What the server asks for when a task starts on a connected repository. */
export interface SnapshotRequest {
  readonly connectionId: string;
  /** `https://github.com/<owner>/<name>`. */
  readonly repository: string;
  /** The branch to start from; the repository's default when absent. */
  readonly baseBranch?: string;
}

/** A git bundle of one branch, in the publisher's scratch area. */
export interface Snapshot {
  readonly bundle: string;
  readonly branch: string;
  /** Delete the bundle once it has been sent. */
  release(): Promise<void>;
}

/** What a connection can reach, for the server's repository directory. */
export interface ReachableRepositories {
  readonly login: string;
  readonly repositories: readonly ReachableRepository[];
  /** More than `MAX_REACHABLE_REPOSITORIES`: the rest were left out. */
  readonly truncated: boolean;
}

export interface PublishResult {
  /** `created`: a new branch. `updated`: fast-forwarded. `unchanged`. */
  readonly push: "created" | "updated" | "unchanged";
  readonly pullRequest: PullRequest & { readonly created: boolean };
}

export type ConnectionStatus =
  | {
      readonly status: "pending";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
    }
  | {
      readonly status: "connected";
      readonly kind: "app" | "token";
      readonly login: string;
      /** The connection can still get a working token without a sign-in. */
      readonly signedIn: boolean;
      readonly accessTokenExpiresAt?: number;
      readonly refreshTokenExpiresAt?: number;
    }
  | { readonly status: "denied" | "expired" | "missing" }
  | { readonly status: "failed"; readonly error: string };

interface DeviceFlow {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  result: ConnectionStatus | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export async function startPublisher(
  options: PublisherOptions,
): Promise<Publisher> {
  if (!options.token.trim()) throw new Error("Publisher token is empty");
  if (!path.isAbsolute(options.tasksRoot)) {
    throw new Error(`--tasks-root must be absolute: ${options.tasksRoot}`);
  }
  const tasksRoot = await fs.realpath(options.tasksRoot);
  await fs.mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const vault = await openCredentialVault({
    file: path.join(options.dataDirectory, "connections.enc"),
    key: options.vaultKey,
  });
  const scratchRoot = path.join(options.dataDirectory, "scratch");
  // Leftovers from a publish a previous process did not finish.
  await fs.rm(scratchRoot, { recursive: true, force: true });
  await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 });

  const github = options.github ?? createGitHubApi();
  const git = options.git ?? localGit(options.gitExecutable ?? "/usr/bin/git");
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const flows = new Map<string, DeviceFlow>();
  const refreshes = new Map<string, Promise<StoredCredential>>();
  /** One publish per connection and branch at a time. */
  const publishing = new Set<string>();

  const service = createPublisherService({
    vault,
    github,
    git,
    tasksRoot,
    scratchRoot,
    clientId: options.clientId,
    now,
    log,
    flows,
    refreshes,
    publishing,
  });

  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof PublisherError) {
        sendJson(response, error.status, {
          error: error.code,
          ...(error.detail ? { detail: error.detail } : {}),
        });
        return;
      }
      log(`publisher: ${describe(error)}`);
      sendJson(response, 500, { error: "publisher_error" });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const header = request.headers.authorization;
    const presented =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
    if (!tokensMatch(options.token, presented)) {
      log("publisher: rejected a request with a bad token");
      throw new PublisherError(401, "unauthorized");
    }
    const url = new URL(request.url ?? "/", "http://publisher");
    const method = request.method ?? "GET";
    if (url.pathname === "/v1/health" && method === "GET") {
      sendJson(response, 200, {
        protocol: PUBLISHER_PROTOCOL,
        deviceFlow: options.clientId !== undefined,
      });
      return;
    }
    if (url.pathname === "/v1/publish" && method === "POST") {
      const body = await readBody(request);
      sendJson(response, 200, await service.publish(parsePublish(body)));
      return;
    }
    if (url.pathname === "/v1/snapshot" && method === "POST") {
      const body = await readBody(request);
      const snapshot = await service.snapshot(parseSnapshot(body));
      try {
        const { size } = await fs.stat(snapshot.bundle);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": size,
          "cache-control": "no-store",
          [SNAPSHOT_BRANCH_HEADER]: snapshot.branch,
        });
        await pipeline(createReadStream(snapshot.bundle), response);
      } finally {
        await snapshot.release();
      }
      return;
    }
    const match =
      /^\/v1\/connections\/([^/]+)(\/device|\/token|\/repositories)?$/u.exec(
        url.pathname,
      );
    if (match) {
      const id = match[1]!;
      if (!CONNECTION_ID_PATTERN.test(id)) {
        throw new PublisherError(400, "connection_id_invalid");
      }
      const action = match[2];
      if (!action && method === "GET") {
        sendJson(response, 200, await service.status(id));
        return;
      }
      if (!action && method === "DELETE") {
        sendJson(response, 200, { removed: await service.remove(id) });
        return;
      }
      if (action === "/device" && method === "POST") {
        sendJson(response, 200, await service.startDeviceFlow(id));
        return;
      }
      if (action === "/repositories" && method === "GET") {
        sendJson(response, 200, await service.listRepositories(id));
        return;
      }
      if (action === "/token" && method === "PUT") {
        const body = await readBody(request);
        if (typeof body.token !== "string") {
          throw new PublisherError(400, "token_required");
        }
        sendJson(response, 200, await service.importToken(id, body.token));
        return;
      }
    }
    throw new PublisherError(404, "not_found");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    async close() {
      for (const flow of flows.values()) {
        if (flow.timer) clearTimeout(flow.timer);
      }
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

/** The publisher's behaviour, without its HTTP listener (for tests too). */
export function createPublisherService(dependencies: {
  readonly vault: CredentialVault;
  readonly github: GitHubApi;
  readonly git: LocalGit;
  readonly tasksRoot: string;
  readonly scratchRoot: string;
  readonly clientId: string | undefined;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly flows?: Map<string, DeviceFlow>;
  readonly refreshes?: Map<string, Promise<StoredCredential>>;
  readonly publishing?: Set<string>;
}) {
  const { vault, github, git, now, log } = dependencies;
  const flows = dependencies.flows ?? new Map<string, DeviceFlow>();
  const refreshes =
    dependencies.refreshes ?? new Map<string, Promise<StoredCredential>>();
  const publishing = dependencies.publishing ?? new Set<string>();

  const connected = (credential: StoredCredential): ConnectionStatus => {
    const signedIn =
      credential.accessTokenExpiresAt === undefined ||
      credential.accessTokenExpiresAt > now() ||
      (credential.refreshToken !== undefined &&
        (credential.refreshTokenExpiresAt === undefined ||
          credential.refreshTokenExpiresAt > now()));
    return {
      status: "connected",
      kind: credential.kind,
      login: credential.login,
      signedIn,
      ...(credential.accessTokenExpiresAt !== undefined
        ? { accessTokenExpiresAt: credential.accessTokenExpiresAt }
        : {}),
      ...(credential.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: credential.refreshTokenExpiresAt }
        : {}),
    };
  };

  const expiry = (seconds: number | undefined) =>
    seconds === undefined ? undefined : now() + seconds * 1_000;

  const storeToken = async (
    id: string,
    kind: "app" | "token",
    token: {
      accessToken: string;
      expiresIn?: number;
      refreshToken?: string;
      refreshTokenExpiresIn?: number;
    },
    login: string,
  ): Promise<StoredCredential> => {
    const accessTokenExpiresAt = expiry(token.expiresIn);
    const refreshTokenExpiresAt = expiry(token.refreshTokenExpiresIn);
    const credential: StoredCredential = {
      id,
      kind,
      login,
      accessToken: token.accessToken,
      ...(accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt } : {}),
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
      updatedAt: now(),
    };
    await vault.put(credential);
    return credential;
  };

  /** A token that works now, refreshing it first when it is about to expire. */
  const usableToken = async (id: string): Promise<string> => {
    const credential = vault.get(id);
    if (!credential) throw new PublisherError(404, "connection_missing");
    if (
      credential.accessTokenExpiresAt === undefined ||
      credential.accessTokenExpiresAt - REFRESH_MARGIN_MS > now()
    ) {
      return credential.accessToken;
    }
    const refreshable =
      credential.refreshToken !== undefined &&
      dependencies.clientId !== undefined &&
      (credential.refreshTokenExpiresAt === undefined ||
        credential.refreshTokenExpiresAt > now());
    if (!refreshable) {
      throw new PublisherError(409, "connection_signed_out");
    }
    // A refresh token works once: concurrent requests share one refresh.
    let pending = refreshes.get(id);
    if (!pending) {
      pending = (async () => {
        try {
          const token = await github.refreshToken(
            dependencies.clientId!,
            credential.refreshToken!,
          );
          return await storeToken(id, credential.kind, token, credential.login);
        } finally {
          refreshes.delete(id);
        }
      })();
      refreshes.set(id, pending);
    }
    try {
      return (await pending).accessToken;
    } catch (error) {
      log(`publisher: refreshing connection ${id} failed: ${describe(error)}`);
      throw new PublisherError(
        409,
        "connection_signed_out",
        error instanceof GitHubError ? error.detail : undefined,
      );
    }
  };

  const pollLater = (id: string, flow: DeviceFlow, deviceCode: string) => {
    let interval = 5;
    const poll = async () => {
      flow.timer = undefined;
      if (flows.get(id) !== flow || flow.result) return;
      if (now() >= flow.expiresAt) {
        flow.result = { status: "expired" };
        return;
      }
      try {
        const result = await github.pollDeviceToken(
          dependencies.clientId!,
          deviceCode,
        );
        if (flows.get(id) !== flow) return;
        switch (result.kind) {
          case "pending":
            break;
          case "slow_down":
            interval = result.interval ?? interval + 5;
            break;
          case "expired":
          case "denied":
            flow.result = { status: result.kind };
            return;
          case "token": {
            const { login } = await github.user(result.token.accessToken);
            const credential = await storeToken(id, "app", result.token, login);
            flow.result = connected(credential);
            log(`publisher: connection ${id} signed in as ${login}`);
            return;
          }
        }
      } catch (error) {
        flow.result = {
          status: "failed",
          error:
            error instanceof GitHubError ? error.code : "device_flow_failed",
        };
        log(`publisher: connection ${id} sign-in failed: ${describe(error)}`);
        return;
      }
      flow.timer = setTimeout(() => void poll(), interval * 1_000);
      flow.timer.unref?.();
    };
    flow.timer = setTimeout(() => void poll(), interval * 1_000);
    flow.timer.unref?.();
  };

  return {
    async startDeviceFlow(id: string) {
      if (!dependencies.clientId) {
        throw new PublisherError(409, "github_app_not_configured");
      }
      const previous = flows.get(id);
      if (previous?.timer) clearTimeout(previous.timer);
      const code = await github
        .requestDeviceCode(dependencies.clientId)
        .catch((error: unknown) => {
          throw new PublisherError(
            502,
            "device_flow_failed",
            error instanceof GitHubError ? error.detail : undefined,
          );
        });
      const flow: DeviceFlow = {
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt: now() + code.expiresIn * 1_000,
        result: undefined,
        timer: undefined,
      };
      flows.set(id, flow);
      pollLater(id, flow, code.deviceCode);
      return {
        status: "pending" as const,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        expiresAt: flow.expiresAt,
      };
    },
    async status(id: string): Promise<ConnectionStatus> {
      const flow = flows.get(id);
      if (flow) {
        if (!flow.result && now() >= flow.expiresAt) {
          flow.result = { status: "expired" };
        }
        if (!flow.result) {
          return {
            status: "pending",
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            expiresAt: flow.expiresAt,
          };
        }
        if (flow.result.status !== "connected") return flow.result;
      }
      const credential = vault.get(id);
      return credential ? connected(credential) : { status: "missing" };
    },
    async importToken(id: string, token: string) {
      if (!TOKEN_PATTERN.test(token)) {
        throw new PublisherError(400, "token_invalid");
      }
      const user = await github.user(token).catch((error: unknown) => {
        throw new PublisherError(
          400,
          "token_rejected",
          error instanceof GitHubError ? error.detail : undefined,
        );
      });
      const flow = flows.get(id);
      if (flow?.timer) clearTimeout(flow.timer);
      flows.delete(id);
      return connected(
        await storeToken(id, "token", { accessToken: token }, user.login),
      );
    },
    /** The repositories this connection can reach; never its token. */
    async listRepositories(id: string): Promise<ReachableRepositories> {
      const token = await usableToken(id);
      const credential = vault.get(id)!;
      const listed = await github
        .listRepositories(token, credential.kind)
        .catch(rethrowGitHub);
      return {
        login: credential.login,
        repositories: listed.repositories,
        truncated: listed.truncated,
      };
    },
    async remove(id: string): Promise<boolean> {
      const flow = flows.get(id);
      if (flow?.timer) clearTimeout(flow.timer);
      const hadFlow = flows.delete(id);
      return (await vault.delete(id)) || hadFlow;
    },
    async publish(request: PublishRequest): Promise<PublishResult> {
      const repository = parseGitHubRepository(request.repository);
      if (!repository) throw new PublisherError(400, "repository_invalid");
      const workspace = await canonicalWorkspace(
        request.workspace,
        dependencies.tasksRoot,
      );
      const lock = `${request.connectionId}:${request.repository}:${request.branch}`;
      if (publishing.has(lock)) throw new PublisherError(409, "publish_busy");
      publishing.add(lock);
      try {
        const token = await usableToken(request.connectionId);
        const push = await pushCommit({
          git,
          scratchRoot: dependencies.scratchRoot,
          workspace,
          remote: `https://github.com/${repository.owner}/${repository.name}.git`,
          branch: request.branch,
          commit: request.commit,
          token,
        });
        const existing = await github
          .findOpenPull(token, repository, request.branch)
          .catch(rethrowGitHub);
        if (existing) {
          const updated = await github
            .updatePull(token, repository, existing.number, {
              title: request.title,
              body: request.body,
            })
            .catch(rethrowGitHub);
          return { push, pullRequest: { ...updated, created: false } };
        }
        let created: PullRequest;
        try {
          created = await github.createDraftPull(token, repository, {
            branch: request.branch,
            base: request.baseBranch,
            title: request.title,
            body: request.body,
          });
        } catch (error) {
          // Opened meanwhile (or a response was lost): use that one.
          const raced = await github
            .findOpenPull(token, repository, request.branch)
            .catch(() => undefined);
          if (raced) return { push, pullRequest: { ...raced, created: false } };
          return rethrowGitHub(error);
        }
        log(
          `publisher: opened draft PR #${created.number} for ${repository.owner}/${repository.name} ${request.branch}`,
        );
        return { push, pullRequest: { ...created, created: true } };
      } finally {
        publishing.delete(lock);
      }
    },
    /**
     * Fetch the base branch with the connection's token into a scratch
     * repository and bundle it. Works for private repositories; the token
     * stays here.
     */
    async snapshot(request: SnapshotRequest): Promise<Snapshot> {
      const repository = parseGitHubRepository(request.repository);
      if (!repository) throw new PublisherError(400, "repository_invalid");
      const token = await usableToken(request.connectionId);
      const scratch = await fs.mkdtemp(
        path.join(dependencies.scratchRoot, "snapshot-"),
      );
      const release = () => fs.rm(scratch, { recursive: true, force: true });
      try {
        const remote = `https://github.com/${repository.owner}/${repository.name}.git`;
        const { run } = githubGit({ git, scratch, token });
        let branch = request.baseBranch;
        if (!branch) {
          const head = await run(
            ["ls-remote", "--symref", "--", remote, "HEAD"],
            "fetch_failed",
            { authenticated: true },
          );
          branch = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(head)?.[1];
          if (!branch || !isSafeBranchName(branch)) {
            throw new PublisherError(502, "default_branch_unknown");
          }
        }
        await run(["init", "-q", "--bare", "."], "scratch_failed");
        await run(
          [
            "fetch",
            "-q",
            "--no-tags",
            "--no-write-fetch-head",
            "--",
            remote,
            `+refs/heads/${branch}:refs/heads/${branch}`,
          ],
          "fetch_failed",
          { authenticated: true },
        );
        const bundle = path.join(scratch, "base.bundle");
        await run(
          ["bundle", "create", "-q", bundle, `refs/heads/${branch}`],
          "bundle_failed",
        );
        log(
          `publisher: fetched ${repository.owner}/${repository.name} ${branch} for a task`,
        );
        return { bundle, branch, release };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}

/**
 * git in a scratch repository with no user or system config. With
 * `authenticated`, the token reaches git only through its environment, and
 * is redacted from any output reported.
 */
function githubGit(options: {
  readonly git: LocalGit;
  readonly scratch: string;
  readonly token: string;
}) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`;
  const redact = (text: string) =>
    text
      .split(options.token)
      .join("[token]")
      .split(header)
      .join("[token]")
      .trim()
      .slice(-2_000);
  const base: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: options.scratch,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const authenticated: Record<string, string> = {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
  };
  const run = async (
    args: readonly string[],
    code: string,
    flags: { readonly authenticated?: boolean } = {},
  ) => {
    const result = await options.git(
      ["-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: options.scratch,
        environment: flags.authenticated ? authenticated : base,
      },
    );
    if (result.exitCode !== 0) {
      throw new PublisherError(
        code === "push_rejected" ? 409 : 502,
        code,
        redact(result.output),
      );
    }
    return result.output;
  };
  return { run, redact, base, authenticated };
}

function rethrowGitHub(error: unknown): never {
  if (error instanceof PublisherError) throw error;
  if (error instanceof GitHubError) {
    throw new PublisherError(
      error.code === "github_unauthorized" ? 409 : 502,
      error.code === "github_unauthorized"
        ? "connection_signed_out"
        : error.code,
      error.detail,
    );
  }
  throw error;
}

/** The workspace's real path, which must be inside the tasks root. */
async function canonicalWorkspace(
  workspace: string,
  tasksRoot: string,
): Promise<string> {
  if (!path.isAbsolute(workspace) || workspace.includes("\0")) {
    throw new PublisherError(400, "workspace_invalid");
  }
  const canonical = await fs.realpath(workspace).catch(() => undefined);
  const relative = canonical ? path.relative(tasksRoot, canonical) : "..";
  if (
    canonical !== workspace ||
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new PublisherError(400, "workspace_invalid");
  }
  return canonical;
}

/**
 * Fetch the task branch from the clone into a fresh scratch repository,
 * check it is exactly `commit`, and push that commit to the branch without
 * force. The token reaches git only through its environment.
 */
async function pushCommit(options: {
  readonly git: LocalGit;
  readonly scratchRoot: string;
  readonly workspace: string;
  readonly remote: string;
  readonly branch: string;
  readonly commit: string;
  readonly token: string;
}): Promise<PublishResult["push"]> {
  const scratch = await fs.mkdtemp(path.join(options.scratchRoot, "push-"));
  const { run, redact, authenticated } = githubGit({
    git: options.git,
    scratch,
    token: options.token,
  });
  try {
    await run(["init", "-q", "--bare", "."], "scratch_failed");
    await run(
      [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "-q",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        options.workspace,
        `+refs/heads/${options.branch}:refs/heads/task`,
      ],
      "fetch_failed",
    );
    const head = (await run(["rev-parse", "refs/heads/task"], "fetch_failed"))
      .trim()
      .split("\n")
      .pop();
    if (head !== options.commit) {
      throw new PublisherError(
        409,
        "commit_moved",
        `${options.branch} is at ${head ?? "nothing"}, not ${options.commit}`,
      );
    }
    const pushed = await options.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--porcelain",
        "--",
        options.remote,
        `${options.commit}:refs/heads/${options.branch}`,
      ],
      { cwd: scratch, environment: authenticated },
    );
    const output = pushed.output;
    const line = output
      .split("\n")
      .find((entry) => entry.includes(`refs/heads/${options.branch}`));
    if (pushed.exitCode !== 0) {
      throw new PublisherError(
        line?.startsWith("!") ? 409 : 502,
        line?.startsWith("!") ? "push_rejected" : "push_failed",
        redact(output),
      );
    }
    if (line?.startsWith("=")) return "unchanged";
    if (line?.startsWith("*")) return "created";
    return "updated";
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Validate a publish request from the server. Unknown keys are refused. */
export function parsePublish(body: Record<string, unknown>): PublishRequest {
  const keys = [
    "connectionId",
    "repository",
    "workspace",
    "branch",
    "commit",
    "baseBranch",
    "title",
    "body",
  ];
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new PublisherError(400, "field_unknown");
  }
  const text = (key: string) => {
    const value = body[key];
    if (typeof value !== "string") {
      throw new PublisherError(400, `${key}_invalid`);
    }
    return value;
  };
  const request: PublishRequest = {
    connectionId: text("connectionId"),
    repository: text("repository"),
    workspace: text("workspace"),
    branch: text("branch"),
    commit: text("commit"),
    baseBranch: text("baseBranch"),
    title: text("title"),
    body: text("body"),
  };
  if (!CONNECTION_ID_PATTERN.test(request.connectionId)) {
    throw new PublisherError(400, "connectionId_invalid");
  }
  if (
    !request.branch.startsWith(TASK_BRANCH_PREFIX) ||
    !isSafeBranchName(request.branch)
  ) {
    throw new PublisherError(400, "branch_not_allowed");
  }
  if (!isSafeBranchName(request.baseBranch)) {
    throw new PublisherError(400, "baseBranch_invalid");
  }
  if (!COMMIT_PATTERN.test(request.commit)) {
    throw new PublisherError(400, "commit_invalid");
  }
  if (!request.title.trim() || request.title.length > MAX_TITLE_LENGTH) {
    throw new PublisherError(400, "title_invalid");
  }
  if (request.body.length > MAX_PR_BODY_LENGTH) {
    throw new PublisherError(400, "body_invalid");
  }
  return request;
}

/** Validate a snapshot request from the server. Unknown keys are refused. */
export function parseSnapshot(body: Record<string, unknown>): SnapshotRequest {
  if (
    Object.keys(body).some(
      (key) => !["connectionId", "repository", "baseBranch"].includes(key),
    )
  ) {
    throw new PublisherError(400, "field_unknown");
  }
  const { connectionId, repository, baseBranch } = body;
  if (
    typeof connectionId !== "string" ||
    !CONNECTION_ID_PATTERN.test(connectionId)
  ) {
    throw new PublisherError(400, "connectionId_invalid");
  }
  if (typeof repository !== "string") {
    throw new PublisherError(400, "repository_invalid");
  }
  if (
    baseBranch !== undefined &&
    (typeof baseBranch !== "string" || !isSafeBranchName(baseBranch))
  ) {
    throw new PublisherError(400, "baseBranch_invalid");
  }
  return {
    connectionId,
    repository,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  };
}

function localGit(executable: string): LocalGit {
  return (args, options) =>
    new Promise((resolve) => {
      execFile(
        executable,
        [...args],
        {
          cwd: options.cwd,
          env: { ...options.environment },
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_GIT_OUTPUT * 4,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.slice(-MAX_GIT_OUTPUT);
          if (!error) {
            resolve({ exitCode: 0, output });
            return;
          }
          const code = (error as { code?: unknown }).code;
          resolve({
            exitCode: typeof code === "number" ? code : undefined,
            output: output || error.message,
          });
        },
      );
    });
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new PublisherError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PublisherError(400, "body_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PublisherError(400, "body_invalid");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
