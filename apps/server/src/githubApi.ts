/**
 * The few GitHub calls the publisher makes: the GitHub App device flow and
 * its token refresh, the signed-in user, the repositories a connection can
 * reach, and finding, opening and updating a task's draft pull request.
 * Only `github.com` and `api.github.com` are ever contacted. Errors carry
 * GitHub's message but never a token.
 */

export const GITHUB_WEB = "https://github.com";
export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "agentlink-assistant-publisher";
const MAX_ERROR_DETAIL = 500;

export type Fetch = typeof fetch;

export class GitHubError extends Error {
  constructor(
    /** Stable code for the caller. */
    readonly code: string,
    /** GitHub's own words, shortened; never contains a token. */
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GitHubError";
  }
}

export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;

/** `https://github.com/<owner>/<name>[.git]`, or undefined for anything else. */
export function parseGitHubRepository(
  repository: string,
): GitHubRepository | undefined {
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const parts = url.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts as [string, string];
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return undefined;
  if (name === "." || name === "..") return undefined;
  return { owner, name };
}

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Seconds between polls. */
  readonly interval: number;
  /** Seconds until the code expires. */
  readonly expiresIn: number;
}

export interface UserToken {
  readonly accessToken: string;
  /** Absent when the app's tokens do not expire. */
  readonly expiresIn?: number;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresIn?: number;
}

/** A poll of the device flow: a token, or why not yet. */
export type DevicePoll =
  | { readonly kind: "token"; readonly token: UserToken }
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down"; readonly interval?: number }
  | { readonly kind: "expired" }
  | { readonly kind: "denied" };

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
}

/** A repository a connection can reach: names and metadata, nothing else. */
export interface ReachableRepository {
  readonly owner: string;
  readonly name: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly defaultBranch?: string;
  /** Shortened to `MAX_DESCRIPTION_LENGTH`. */
  readonly description?: string;
  /** ISO time of the last push, when GitHub says. */
  readonly pushedAt?: string;
}

/** At most this many repositories per connection. */
export const MAX_REACHABLE_REPOSITORIES = 1_000;
const MAX_DESCRIPTION_LENGTH = 200;
const PAGE_SIZE = 100;
/** Pages read per list, whatever GitHub answers. */
const MAX_PAGES = MAX_REACHABLE_REPOSITORIES / PAGE_SIZE + 1;
/** Installations looked at per app connection. */
const MAX_INSTALLATIONS = 50;

/** One repository from GitHub's JSON, or undefined when it is malformed. */
export function reachableRepository(
  item: unknown,
): ReachableRepository | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const fullName = record.full_name;
  if (typeof fullName !== "string") return undefined;
  const [owner, name, ...rest] = fullName.split("/");
  if (
    rest.length > 0 ||
    !owner ||
    !name ||
    !NAME_PATTERN.test(owner) ||
    !NAME_PATTERN.test(name)
  ) {
    return undefined;
  }
  const description =
    typeof record.description === "string"
      ? record.description.replace(/\s+/gu, " ").trim()
      : "";
  return {
    owner,
    name,
    private: record.private === true,
    archived: record.archived === true,
    ...(typeof record.default_branch === "string" && record.default_branch
      ? { defaultBranch: record.default_branch }
      : {}),
    ...(description
      ? { description: description.slice(0, MAX_DESCRIPTION_LENGTH) }
      : {}),
    ...(typeof record.pushed_at === "string"
      ? { pushedAt: record.pushed_at }
      : {}),
  };
}

export interface GitHubApi {
  requestDeviceCode(clientId: string): Promise<DeviceCode>;
  pollDeviceToken(clientId: string, deviceCode: string): Promise<DevicePoll>;
  /** Device-flow tokens refresh with the client ID alone. */
  refreshToken(clientId: string, refreshToken: string): Promise<UserToken>;
  /** The account a token belongs to. */
  user(token: string): Promise<{ readonly login: string }>;
  /** The open pull request from `branch` in the same repository, if any. */
  findOpenPull(
    token: string,
    repository: GitHubRepository,
    branch: string,
  ): Promise<PullRequest | undefined>;
  createDraftPull(
    token: string,
    repository: GitHubRepository,
    request: {
      readonly branch: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    },
  ): Promise<PullRequest>;
  updatePull(
    token: string,
    repository: GitHubRepository,
    number: number,
    request: { readonly title: string; readonly body: string },
  ): Promise<PullRequest>;
  /**
   * The repositories a token can reach: for a GitHub App user token, those
   * of the installations it can see; for a pasted token, `/user/repos`.
   * Stops at `MAX_REACHABLE_REPOSITORIES` (`truncated`).
   */
  listRepositories(
    token: string,
    kind: "app" | "token",
  ): Promise<{
    readonly repositories: readonly ReachableRepository[];
    readonly truncated: boolean;
  }>;
}

export function createGitHubApi(
  options: {
    readonly fetch?: Fetch;
    readonly timeoutMs?: number;
  } = {},
): GitHubApi {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const send = async (
    url: string,
    init: {
      readonly method: string;
      readonly token?: string;
      readonly body?: Record<string, unknown>;
      readonly form?: Record<string, string>;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: {
          accept: url.startsWith(GITHUB_API)
            ? "application/vnd.github+json"
            : "application/json",
          "user-agent": USER_AGENT,
          ...(url.startsWith(GITHUB_API)
            ? { "x-github-api-version": API_VERSION }
            : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.form
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        ...(init.form
          ? { body: new URLSearchParams(init.form).toString() }
          : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GitHubError(
        "github_unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        } else if (Array.isArray(parsed)) {
          body = { items: parsed };
        }
      } catch {
        body = {};
      }
    }
    return { status: response.status, body };
  };

  const fail = (
    code: string,
    result: { status: number; body: Record<string, unknown> },
  ): never => {
    const message =
      typeof result.body.message === "string"
        ? result.body.message
        : typeof result.body.error_description === "string"
          ? result.body.error_description
          : typeof result.body.error === "string"
            ? result.body.error
            : `HTTP ${result.status}`;
    throw new GitHubError(
      result.status === 401 ? "github_unauthorized" : code,
      message.slice(0, MAX_ERROR_DETAIL),
      result.status,
    );
  };

  const userToken = (body: Record<string, unknown>): UserToken => {
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new GitHubError("github_token_invalid");
    }
    return {
      accessToken: body.access_token,
      ...(typeof body.expires_in === "number"
        ? { expiresIn: body.expires_in }
        : {}),
      ...(typeof body.refresh_token === "string" && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : {}),
      ...(typeof body.refresh_token_expires_in === "number"
        ? { refreshTokenExpiresIn: body.refresh_token_expires_in }
        : {}),
    };
  };

  const pullRequest = (body: Record<string, unknown>): PullRequest => {
    if (typeof body.number !== "number" || typeof body.html_url !== "string") {
      throw new GitHubError("github_response_invalid");
    }
    return {
      number: body.number,
      url: body.html_url,
      draft: body.draft === true,
    };
  };

  const repoPath = (repository: GitHubRepository) =>
    `${GITHUB_API}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;

  return {
    async requestDeviceCode(clientId) {
      const result = await send(`${GITHUB_WEB}/login/device/code`, {
        method: "POST",
        form: { client_id: clientId },
      });
      const body = result.body;
      if (
        result.status !== 200 ||
        typeof body.device_code !== "string" ||
        typeof body.user_code !== "string" ||
        typeof body.verification_uri !== "string"
      ) {
        return fail("device_flow_failed", result);
      }
      return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        interval: typeof body.interval === "number" ? body.interval : 5,
        expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
      };
    },
    async pollDeviceToken(clientId, deviceCode) {
      const result = await send(`${GITHUB_WEB}/login/oauth/access_token`, {
        method: "POST",
        form: {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      });
      const error = result.body.error;
      if (result.status === 200 && error === undefined) {
        return { kind: "token", token: userToken(result.body) };
      }
      switch (error) {
        case "authorization_pending":
          return { kind: "pending" };
        case "slow_down":
          return {
            kind: "slow_down",
            ...(typeof result.body.interval === "number"
              ? { interval: result.body.interval }
              : {}),
          };
        case "expired_token":
          return { kind: "expired" };
        case "access_denied":
          return { kind: "denied" };
        default:
          return fail("device_flow_failed", result);
      }
    },
    async refreshToken(clientId, refreshToken) {
      const result = await send(`${GITHUB_WEB}/login/oauth/access_token`, {
        method: "POST",
        form: {
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
      });
      if (result.status !== 200 || result.body.error !== undefined) {
        return fail("refresh_failed", result);
      }
      return userToken(result.body);
    },
    async user(token) {
      const result = await send(`${GITHUB_API}/user`, {
        method: "GET",
        token,
      });
      if (result.status !== 200 || typeof result.body.login !== "string") {
        return fail("github_user_failed", result);
      }
      return { login: result.body.login };
    },
    async findOpenPull(token, repository, branch) {
      const query = new URLSearchParams({
        head: `${repository.owner}:${branch}`,
        state: "open",
        per_page: "10",
      });
      const result = await send(`${repoPath(repository)}/pulls?${query}`, {
        method: "GET",
        token,
      });
      if (result.status !== 200 || !Array.isArray(result.body.items)) {
        return fail("github_pulls_failed", result);
      }
      const [first] = result.body.items as Record<string, unknown>[];
      return first ? pullRequest(first) : undefined;
    },
    async createDraftPull(token, repository, request) {
      const result = await send(`${repoPath(repository)}/pulls`, {
        method: "POST",
        token,
        body: {
          title: request.title,
          head: request.branch,
          base: request.base,
          body: request.body,
          draft: true,
          maintainer_can_modify: false,
        },
      });
      if (result.status !== 201) return fail("pull_request_failed", result);
      return pullRequest(result.body);
    },
    async updatePull(token, repository, number, request) {
      const result = await send(`${repoPath(repository)}/pulls/${number}`, {
        method: "PATCH",
        token,
        body: { title: request.title, body: request.body },
      });
      if (result.status !== 200) return fail("pull_request_failed", result);
      return pullRequest(result.body);
    },
    async listRepositories(token, kind) {
      const found = new Map<string, ReachableRepository>();
      let truncated = false;
      /** Read pages of `url` until one is short; false once full. */
      const collect = async (
        url: string,
        items: (body: Record<string, unknown>) => unknown,
      ): Promise<boolean> => {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const separator = url.includes("?") ? "&" : "?";
          const result = await send(
            `${url}${separator}per_page=${PAGE_SIZE}&page=${page}`,
            { method: "GET", token },
          );
          const list = items(result.body);
          if (result.status !== 200 || !Array.isArray(list)) {
            return fail("github_repositories_failed", result);
          }
          for (const item of list) {
            const repository = reachableRepository(item);
            if (!repository) continue;
            if (found.size >= MAX_REACHABLE_REPOSITORIES) {
              truncated = true;
              return false;
            }
            found.set(
              `${repository.owner}/${repository.name}`.toLowerCase(),
              repository,
            );
          }
          if (list.length < PAGE_SIZE) return true;
        }
        truncated = true;
        return false;
      };
      if (kind === "token") {
        await collect(`${GITHUB_API}/user/repos?sort=pushed`, (body) =>
          Array.isArray(body.items) ? body.items : undefined,
        );
        return { repositories: [...found.values()], truncated };
      }
      const installations: number[] = [];
      for (
        let page = 1;
        installations.length < MAX_INSTALLATIONS && page <= MAX_PAGES;
        page += 1
      ) {
        const result = await send(
          `${GITHUB_API}/user/installations?per_page=${PAGE_SIZE}&page=${page}`,
          { method: "GET", token },
        );
        const list = result.body.installations;
        if (result.status !== 200 || !Array.isArray(list)) {
          return fail("github_installations_failed", result);
        }
        for (const item of list as Record<string, unknown>[]) {
          if (typeof item?.id === "number") installations.push(item.id);
        }
        if (list.length < PAGE_SIZE) break;
      }
      for (const id of installations.slice(0, MAX_INSTALLATIONS)) {
        const more = await collect(
          `${GITHUB_API}/user/installations/${id}/repositories`,
          (body) => body.repositories,
        );
        if (!more) break;
      }
      return { repositories: [...found.values()], truncated };
    },
  };
}
