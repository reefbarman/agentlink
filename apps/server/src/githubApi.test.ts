import {
  MAX_REACHABLE_REPOSITORIES,
  createGitHubApi,
  parseGitHubRepository,
} from "./githubApi.js";
import { describe, expect, it } from "vitest";

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseGitHubRepository", () => {
  it("accepts github.com repositories and nothing else", () => {
    expect(parseGitHubRepository("https://github.com/octo/hello.git")).toEqual({
      owner: "octo",
      name: "hello",
    });
    expect(parseGitHubRepository("https://GitHub.com/octo/hello/")).toEqual({
      owner: "octo",
      name: "hello",
    });
    for (const repository of [
      "http://github.com/octo/hello",
      "https://gitlab.com/octo/hello",
      "https://github.com/octo",
      "https://github.com/octo/hello/tree/main",
      "https://user:pw@github.com/octo/hello",
      "https://github.com:8443/octo/hello",
      "https://github.com/octo/..",
      "not a url",
    ]) {
      expect(parseGitHubRepository(repository)).toBeUndefined();
    }
  });
});

describe("GitHub API", () => {
  it("polls the device flow and maps GitHub's answers", async () => {
    const answers = [
      respond(200, { error: "authorization_pending" }),
      respond(200, { error: "slow_down", interval: 10 }),
      respond(200, {
        access_token: "ghu_token",
        expires_in: 28_800,
        refresh_token: "ghr_token",
        refresh_token_expires_in: 15_811_200,
      }),
      respond(200, { error: "access_denied" }),
    ];
    const seen: { url: string; body: string }[] = [];
    const api = createGitHubApi({
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: String(init?.body) });
        return answers.shift()!;
      },
    });
    expect(await api.pollDeviceToken("Iv1.id", "dev")).toEqual({
      kind: "pending",
    });
    expect(await api.pollDeviceToken("Iv1.id", "dev")).toEqual({
      kind: "slow_down",
      interval: 10,
    });
    expect(await api.pollDeviceToken("Iv1.id", "dev")).toEqual({
      kind: "token",
      token: {
        accessToken: "ghu_token",
        expiresIn: 28_800,
        refreshToken: "ghr_token",
        refreshTokenExpiresIn: 15_811_200,
      },
    });
    expect(await api.pollDeviceToken("Iv1.id", "dev")).toEqual({
      kind: "denied",
    });
    expect(seen[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(seen[0]!.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
    // Device-flow tokens refresh without a client secret.
    expect(seen.some((entry) => entry.body.includes("client_secret"))).toBe(
      false,
    );
  });

  it("opens draft pull requests and reports GitHub's error message", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const answers = [
      respond(201, {
        number: 7,
        html_url: "https://github.com/octo/hello/pull/7",
        draft: true,
      }),
      respond(401, { message: "Bad credentials" }),
      respond(422, { message: "Validation Failed" }),
    ];
    const api = createGitHubApi({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return answers.shift()!;
      },
    });
    const repository = { owner: "octo", name: "hello" };
    expect(
      await api.createDraftPull("ghu_x", repository, {
        branch: "agentlink/x-1",
        base: "main",
        title: "T",
        body: "B",
      }),
    ).toEqual({
      number: 7,
      url: "https://github.com/octo/hello/pull/7",
      draft: true,
    });
    const sent = JSON.parse(String(requests[0]!.init?.body)) as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({ draft: true, head: "agentlink/x-1" });
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello/pulls",
    );
    await expect(api.user("ghu_x")).rejects.toMatchObject({
      code: "github_unauthorized",
      detail: "Bad credentials",
    });
    await expect(
      api.updatePull("ghu_x", repository, 7, { title: "T", body: "B" }),
    ).rejects.toMatchObject({
      code: "pull_request_failed",
      detail: "Validation Failed",
    });
  });

  const repo = (fullName: string, extra: Record<string, unknown> = {}) => ({
    full_name: fullName,
    private: false,
    archived: false,
    default_branch: "main",
    ...extra,
  });

  it("lists every installation's repositories for an app token, page by page", async () => {
    const urls: string[] = [];
    const page = Array.from({ length: 100 }, (_, index) =>
      repo(`octo/r${index}`),
    );
    const api = createGitHubApi({
      fetch: async (url, init) => {
        const target = String(url);
        urls.push(target);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer ghu_x",
        );
        if (target.includes("/user/installations?")) {
          return respond(200, { installations: [{ id: 1 }, { id: 2 }] });
        }
        if (target.includes("/installations/1/repositories")) {
          return respond(200, {
            repositories: target.endsWith("&page=1") ? page : [],
          });
        }
        return respond(200, {
          repositories: [
            repo("reefbarman/site", {
              private: true,
              description: "  My\nwebsite ",
              pushed_at: "2026-10-01T00:00:00Z",
            }),
            { full_name: "bad name/../x" },
            repo("octo/r0"),
          ],
        });
      },
    });
    const listed = await api.listRepositories("ghu_x", "app");
    expect(listed.truncated).toBe(false);
    // The duplicate across installations is listed once; malformed skipped.
    expect(listed.repositories).toHaveLength(101);
    expect(listed.repositories.find((entry) => entry.name === "site")).toEqual({
      owner: "reefbarman",
      name: "site",
      private: true,
      archived: false,
      defaultBranch: "main",
      description: "My website",
      pushedAt: "2026-10-01T00:00:00Z",
    });
    expect(urls).toContain(
      "https://api.github.com/user/installations/1/repositories?per_page=100&page=2",
    );
  });

  it("lists /user/repos for a pasted token and stops at the limit", async () => {
    let served = 0;
    const api = createGitHubApi({
      fetch: async (url) => {
        expect(String(url)).toContain("/user/repos?sort=pushed&per_page=100");
        const items = Array.from({ length: 100 }, () =>
          repo(`octo/n${served++}`),
        );
        return respond(200, items);
      },
    });
    const listed = await api.listRepositories("github_pat_x", "token");
    expect(listed.truncated).toBe(true);
    expect(listed.repositories).toHaveLength(MAX_REACHABLE_REPOSITORIES);
  });

  it("reports why GitHub refused to list", async () => {
    const api = createGitHubApi({
      fetch: async () => respond(403, { message: "Resource not accessible" }),
    });
    await expect(api.listRepositories("ghu_x", "app")).rejects.toMatchObject({
      code: "github_installations_failed",
      detail: "Resource not accessible",
    });
  });

  it("stops reading pages that never end", async () => {
    let calls = 0;
    const api = createGitHubApi({
      fetch: async () => {
        calls += 1;
        // The same full page, over and over.
        return respond(
          200,
          Array.from({ length: 100 }, (_, index) => repo(`octo/same${index}`)),
        );
      },
    });
    const listed = await api.listRepositories("github_pat_x", "token");
    expect(listed).toMatchObject({ truncated: true });
    expect(listed.repositories).toHaveLength(100);
    expect(calls).toBe(11);
  });
});
