/**
 * The few GitHub calls the publisher makes: the GitHub App device flow and
 * its token refresh, the signed-in user, and finding, opening and updating
 * a task's draft pull request. Only `github.com` and `api.github.com` are
 * ever contacted. Errors carry GitHub's message but never a token.
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
  };
}
