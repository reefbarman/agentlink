import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DevicePoll,
  GitHubApi,
  GitHubRepository,
  PullRequest,
  UserToken,
} from "./githubApi.js";
import { GitHubError } from "./githubApi.js";
import {
  PublisherError,
  createPublisherService,
  parseArchive,
  parsePublish,
  parseSnapshot,
  startPublisher,
  type LocalGit,
  type PublishRequest,
} from "./publisher.js";
import { createPublisherClient } from "./publisherClient.js";
import { openCredentialVault } from "./publisherVault.js";

const KEY = Buffer.alloc(32, 7);
const TOKEN = "ghu_secrettoken0123456789abcdef";
const CONNECTION = "c0ffee000001";
const REPOSITORY = "https://github.com/octo/hello";
const REMOTE_URL = "https://github.com/octo/hello.git";
const BRANCH = "agentlink/add-docs-0123456789ab";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

/** A remote (bare) and a task clone on the task branch with one commit. */
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "publisher-")),
  );
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const tasksRoot = path.join(root, "tasks");
  const workspace = path.join(tasksRoot, "0123456789ab", "hello");
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "hello\n");
  git(workspace, "add", "README.md");
  git(workspace, "commit", "-q", "-m", "base");
  git(workspace, "push", "-q", "origin", "HEAD:main");
  git(workspace, "checkout", "-q", "-b", BRANCH);
  await fs.writeFile(path.join(workspace, "DOCS.md"), "docs\n");
  git(workspace, "add", "DOCS.md");
  git(workspace, "commit", "-q", "-m", "Add docs");
  const commit = git(workspace, "rev-parse", "HEAD");
  const scratchRoot = path.join(root, "scratch");
  await fs.mkdir(scratchRoot);
  const calls: {
    args: readonly string[];
    environment: Record<string, string>;
  }[] = [];
  // Real git, with GitHub's URL pointed at the local bare remote.
  const localGit: LocalGit = async (args, options) => {
    calls.push({ args, environment: { ...options.environment } });
    const mapped = args.map((arg) => (arg === REMOTE_URL ? remote : arg));
    try {
      const output = execFileSync("git", mapped, {
        cwd: options.cwd,
        env: { ...options.environment },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, output };
    } catch (error) {
      const failure = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: failure.status ?? 1,
        output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  };
  return {
    root,
    remote,
    tasksRoot,
    workspace,
    commit,
    scratchRoot,
    calls,
    localGit,
  };
}

function fakeGitHub(overrides: Partial<GitHubApi> = {}) {
  const pulls: (PullRequest & {
    branch: string;
    title: string;
    body: string;
  })[] = [];
  const api: GitHubApi = {
    requestDeviceCode: async () => ({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    }),
    pollDeviceToken: async (): Promise<DevicePoll> => ({ kind: "pending" }),
    refreshToken: async (): Promise<UserToken> => ({
      accessToken: "ghu_refreshedtoken0123456789",
      expiresIn: 28_800,
      refreshToken: "ghr_next0123456789abcdefgh",
      refreshTokenExpiresIn: 15_000_000,
    }),
    user: async () => ({ login: "reefbarman" }),
    findOpenPull: async (_token, _repository: GitHubRepository, branch) =>
      pulls.find((pull) => pull.branch === branch),
    createDraftPull: async (_token, _repository, request) => {
      const pull = {
        number: pulls.length + 1,
        url: `https://github.com/octo/hello/pull/${pulls.length + 1}`,
        draft: true,
        ...request,
      };
      pulls.push(pull);
      return pull;
    },
    updatePull: async (_token, _repository, number, request) => {
      const pull = pulls.find((entry) => entry.number === number)!;
      Object.assign(pull, request);
      return pull;
    },
    listRepositories: async () => ({
      repositories: [
        { owner: "reefbarman", name: "site", private: true, archived: false },
      ],
      truncated: false,
    }),
    ...overrides,
  };
  return { api, pulls };
}

async function service(options: {
  readonly fixture: Awaited<ReturnType<typeof fixture>>;
  readonly github?: GitHubApi;
  readonly now?: () => number;
  readonly withCredential?: boolean;
  readonly expiresAt?: number;
  readonly maxArchiveBytes?: number;
}) {
  const vault = await openCredentialVault({
    file: path.join(options.fixture.root, "vault", "connections.enc"),
    key: KEY,
  });
  if (options.withCredential !== false) {
    await vault.put({
      id: CONNECTION,
      kind: "app",
      login: "reefbarman",
      accessToken: TOKEN,
      ...(options.expiresAt !== undefined
        ? {
            accessTokenExpiresAt: options.expiresAt,
            refreshToken: "ghr_first0123456789abcdefgh",
          }
        : {}),
      updatedAt: 1,
    });
  }
  return {
    vault,
    publisher: createPublisherService({
      vault,
      github: options.github ?? fakeGitHub().api,
      git: options.fixture.localGit,
      tasksRoot: options.fixture.tasksRoot,
      scratchRoot: options.fixture.scratchRoot,
      clientId: "Iv1.clientid",
      now: options.now ?? (() => 1_000),
      log: () => undefined,
      ...(options.maxArchiveBytes !== undefined
        ? { maxArchiveBytes: options.maxArchiveBytes }
        : {}),
    }),
  };
}

function request(
  setup: Awaited<ReturnType<typeof fixture>>,
  patch: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    connectionId: CONNECTION,
    repository: REPOSITORY,
    workspace: setup.workspace,
    branch: BRANCH,
    commit: setup.commit,
    baseBranch: "main",
    title: "Add docs",
    body: "Opened by AgentLink Assistant.",
    ...patch,
  };
}

describe("parsePublish", () => {
  const valid = {
    connectionId: CONNECTION,
    repository: REPOSITORY,
    workspace: "/srv/agentlink/projects/.tasks/0123456789ab/hello",
    branch: BRANCH,
    commit: "a".repeat(40),
    baseBranch: "main",
    title: "Add docs",
    body: "",
  };

  it("accepts a task branch and refuses every other branch", () => {
    expect(parsePublish(valid).branch).toBe(BRANCH);
    for (const branch of [
      "main",
      "feature/x",
      "agentlink",
      "agentlink/../main",
    ]) {
      expect(() => parsePublish({ ...valid, branch })).toThrow(
        "branch_not_allowed",
      );
    }
  });

  it("refuses unknown fields, short commits and bad connection IDs", () => {
    expect(() => parsePublish({ ...valid, force: true })).toThrow(
      "field_unknown",
    );
    expect(() => parsePublish({ ...valid, commit: "abc123" })).toThrow(
      "commit_invalid",
    );
    expect(() => parsePublish({ ...valid, connectionId: "../x" })).toThrow(
      "connectionId_invalid",
    );
  });
});

describe("publishing", { timeout: 30_000 }, () => {
  it("pushes the exact commit to the task branch and opens one draft PR", async () => {
    const setup = await fixture();
    const github = fakeGitHub();
    const { publisher } = await service({ fixture: setup, github: github.api });

    const first = await publisher.publish(request(setup));
    expect(first.push).toBe("created");
    expect(first.pullRequest).toMatchObject({ number: 1, created: true });
    expect(git(setup.remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(
      setup.commit,
    );
    expect(github.pulls[0]).toMatchObject({
      branch: BRANCH,
      base: "main",
      draft: true,
    });

    // Again (a restart, a lost response): nothing new is created.
    const second = await publisher.publish(
      request(setup, { body: "Updated body" }),
    );
    expect(second.push).toBe("unchanged");
    expect(second.pullRequest).toMatchObject({ number: 1, created: false });
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]!.body).toBe("Updated body");
  });

  it("fast-forwards a later commit and refuses a rewritten branch", async () => {
    const setup = await fixture();
    const { publisher } = await service({ fixture: setup });
    await publisher.publish(request(setup));

    await fs.writeFile(path.join(setup.workspace, "MORE.md"), "more\n");
    git(setup.workspace, "add", "MORE.md");
    git(setup.workspace, "commit", "-q", "-m", "More");
    const later = git(setup.workspace, "rev-parse", "HEAD");
    const updated = await publisher.publish(request(setup, { commit: later }));
    expect(updated.push).toBe("updated");

    // History rewritten in the clone: never forced over the remote.
    git(setup.workspace, "reset", "-q", "--hard", "HEAD~2");
    await fs.writeFile(path.join(setup.workspace, "OTHER.md"), "other\n");
    git(setup.workspace, "add", "OTHER.md");
    git(setup.workspace, "commit", "-q", "-m", "Other");
    const rewritten = git(setup.workspace, "rev-parse", "HEAD");
    await expect(
      publisher.publish(request(setup, { commit: rewritten })),
    ).rejects.toMatchObject({ code: "push_rejected" });
    expect(git(setup.remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(later);
  });

  it("refuses a commit the branch no longer points at", async () => {
    const setup = await fixture();
    const { publisher } = await service({ fixture: setup });
    await expect(
      publisher.publish(request(setup, { commit: "b".repeat(40) })),
    ).rejects.toMatchObject({ code: "commit_moved" });
  });

  it("refuses workspaces outside the tasks root and non-GitHub repositories", async () => {
    const setup = await fixture();
    const { publisher } = await service({ fixture: setup });
    await expect(
      publisher.publish(request(setup, { workspace: setup.remote })),
    ).rejects.toMatchObject({ code: "workspace_invalid" });
    await expect(
      publisher.publish(
        request(setup, {
          workspace: path.join(setup.tasksRoot, "..", "tasks"),
        }),
      ),
    ).rejects.toMatchObject({ code: "workspace_invalid" });
    await expect(
      publisher.publish(
        request(setup, { repository: "https://gitlab.com/octo/hello" }),
      ),
    ).rejects.toMatchObject({ code: "repository_invalid" });
  });

  it("only uses the requested connection's token, and never on a command line", async () => {
    const setup = await fixture();
    const { publisher } = await service({
      fixture: setup,
      withCredential: false,
    });
    await expect(publisher.publish(request(setup))).rejects.toMatchObject({
      code: "connection_missing",
    });

    const { publisher: withToken } = await service({ fixture: setup });
    await withToken.publish(request(setup));
    for (const call of setup.calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
    }
    const authenticated = setup.calls.filter((call) =>
      Object.values(call.environment).some((value) =>
        value.includes(
          Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
        ),
      ),
    );
    // Only the push carries the token, and only through its environment.
    expect(authenticated).toHaveLength(1);
    expect(authenticated[0]!.args).toContain("push");
    // Fetching from the clone and pushing never run its hooks.
    for (const call of setup.calls) {
      expect(call.args.slice(0, 2)).toEqual(["-c", "core.hooksPath=/dev/null"]);
    }
  });

  it("keeps the token out of error details", async () => {
    const setup = await fixture();
    const vault = await openCredentialVault({
      file: path.join(setup.root, "vault", "connections.enc"),
      key: KEY,
    });
    await vault.put({
      id: CONNECTION,
      kind: "token",
      login: "reefbarman",
      accessToken: TOKEN,
      updatedAt: 1,
    });
    const leaky: LocalGit = async (args, options) => {
      if (args.includes("push")) {
        return {
          exitCode: 128,
          output: `fatal: could not read ${TOKEN} ${options.environment.GIT_CONFIG_VALUE_0}`,
        };
      }
      return setup.localGit(args, options);
    };
    const publisher = createPublisherService({
      vault,
      github: fakeGitHub().api,
      git: leaky,
      tasksRoot: setup.tasksRoot,
      scratchRoot: setup.scratchRoot,
      clientId: undefined,
      now: () => 1,
      log: () => undefined,
    });
    const failure = await publisher
      .publish(request(setup))
      .catch((error: unknown) => error as PublisherError);
    expect(failure).toBeInstanceOf(PublisherError);
    expect((failure as PublisherError).code).toBe("push_failed");
    expect((failure as PublisherError).detail).not.toContain(TOKEN);
    expect((failure as PublisherError).detail).toContain("[token]");
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });
});

describe("connections", { timeout: 30_000 }, () => {
  it("signs in with the device flow and stores the token encrypted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const setup = await fixture();
    let polls = 0;
    const github = fakeGitHub({
      pollDeviceToken: async () => {
        polls += 1;
        return polls < 2
          ? { kind: "pending" }
          : {
              kind: "token",
              token: {
                accessToken: TOKEN,
                expiresIn: 28_800,
                refreshToken: "ghr_first0123456789abcdefgh",
                refreshTokenExpiresIn: 15_000_000,
              },
            };
      },
    });
    const { publisher } = await service({
      fixture: setup,
      github: github.api,
      withCredential: false,
      now: () => Date.now(),
    });
    const started = await publisher.startDeviceFlow("c0ffee000002");
    expect(started).toMatchObject({
      status: "pending",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    expect(await publisher.status("c0ffee000002")).toMatchObject({
      status: "pending",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    // Storing the token is real file I/O: wait for it to land.
    await vi.waitFor(async () => {
      expect(await publisher.status("c0ffee000002")).toMatchObject({
        status: "connected",
        kind: "app",
        login: "reefbarman",
        signedIn: true,
      });
    });
    const sealed = await fs.readFile(
      path.join(setup.root, "vault", "connections.enc"),
      "utf8",
    );
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain("reefbarman");
    const reopened = await openCredentialVault({
      file: path.join(setup.root, "vault", "connections.enc"),
      key: KEY,
    });
    expect(reopened.get("c0ffee000002")?.accessToken).toBe(TOKEN);
    await expect(
      openCredentialVault({
        file: path.join(setup.root, "vault", "connections.enc"),
        key: Buffer.alloc(32, 9),
      }),
    ).rejects.toThrow("unreadable with this key");
  });

  it("reports a denied sign-in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const setup = await fixture();
    const github = fakeGitHub({
      pollDeviceToken: async () => ({ kind: "denied" }),
    });
    const { publisher } = await service({
      fixture: setup,
      github: github.api,
      withCredential: false,
    });
    await publisher.startDeviceFlow("c0ffee000003");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await publisher.status("c0ffee000003")).toEqual({
      status: "denied",
    });
  });

  it("refreshes an expiring token once, even for concurrent publishes", async () => {
    const setup = await fixture();
    let refreshes = 0;
    const github = fakeGitHub({
      refreshToken: async () => {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          accessToken: "ghu_refreshedtoken0123456789",
          expiresIn: 28_800,
          refreshToken: "ghr_next0123456789abcdefgh",
        };
      },
    });
    const { publisher, vault } = await service({
      fixture: setup,
      github: github.api,
      expiresAt: 1_000,
      now: () => 10_000,
    });
    const second = await fixture();
    void second;
    await Promise.all([
      publisher.status(CONNECTION),
      publisher.publish(request(setup)),
    ]);
    expect(refreshes).toBe(1);
    expect(vault.get(CONNECTION)?.accessToken).toBe(
      "ghu_refreshedtoken0123456789",
    );
  });

  it("asks for a new sign-in when the refresh fails", async () => {
    const setup = await fixture();
    const github = fakeGitHub({
      refreshToken: async () => {
        throw new Error("bad_refresh_token");
      },
    });
    const { publisher } = await service({
      fixture: setup,
      github: github.api,
      expiresAt: 1_000,
      now: () => 10_000,
    });
    await expect(publisher.publish(request(setup))).rejects.toMatchObject({
      code: "connection_signed_out",
    });
  });

  it("checks a pasted token with GitHub before keeping it", async () => {
    const setup = await fixture();
    const github = fakeGitHub({
      user: async (token) => {
        if (token !== TOKEN) throw new Error("Bad credentials");
        return { login: "reefbarman" };
      },
    });
    const { publisher } = await service({
      fixture: setup,
      github: github.api,
      withCredential: false,
    });
    await expect(
      publisher.importToken("c0ffee000004", "github_pat_wrong0123456789"),
    ).rejects.toMatchObject({ code: "token_rejected" });
    await expect(
      publisher.importToken("c0ffee000004", "not a token"),
    ).rejects.toMatchObject({ code: "token_invalid" });
    expect(await publisher.importToken("c0ffee000004", TOKEN)).toMatchObject({
      status: "connected",
      kind: "token",
      login: "reefbarman",
    });
    expect(await publisher.remove("c0ffee000004")).toBe(true);
    expect(await publisher.status("c0ffee000004")).toEqual({
      status: "missing",
    });
  });
});

describe("repository listing", { timeout: 30_000 }, () => {
  it("lists with the connection's own token and kind, returning no token", async () => {
    const setup = await fixture();
    const seen: { token: string; kind: string }[] = [];
    const github = fakeGitHub({
      listRepositories: async (token, kind) => {
        seen.push({ token, kind });
        return {
          repositories: [
            {
              owner: "reefbarman",
              name: "site",
              private: true,
              archived: false,
            },
          ],
          truncated: false,
        };
      },
    });
    const { publisher } = await service({ fixture: setup, github: github.api });
    const listed = await publisher.listRepositories(CONNECTION);
    expect(seen).toEqual([{ token: TOKEN, kind: "app" }]);
    expect(listed).toEqual({
      login: "reefbarman",
      repositories: [
        { owner: "reefbarman", name: "site", private: true, archived: false },
      ],
      truncated: false,
    });
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    await expect(
      publisher.listRepositories("0123456789ab"),
    ).rejects.toMatchObject({ code: "connection_missing" });
  });

  it("reports a signed-out connection instead of GitHub's 401", async () => {
    const setup = await fixture();
    const github = fakeGitHub({
      listRepositories: async () => {
        throw new GitHubError("github_unauthorized", "Bad credentials", 401);
      },
    });
    const { publisher } = await service({ fixture: setup, github: github.api });
    await expect(publisher.listRepositories(CONNECTION)).rejects.toMatchObject({
      code: "connection_signed_out",
    });
  });
});

describe("snapshots", { timeout: 30_000 }, () => {
  it("bundles the default or chosen branch with the token only in git's environment", async () => {
    const setup = await fixture();
    git(setup.workspace, "push", "-q", "origin", "HEAD:release");
    const { publisher } = await service({ fixture: setup });

    const main = await publisher.snapshot({
      connectionId: CONNECTION,
      repository: REPOSITORY,
    });
    expect(main.branch).toBe("main");
    expect(main.bundle.startsWith(setup.scratchRoot)).toBe(true);
    const heads = git(setup.root, "bundle", "list-heads", main.bundle);
    expect(heads).toBe(
      `${git(setup.remote, "rev-parse", "main")} refs/heads/main`,
    );
    await main.release();
    expect(await fs.readdir(setup.scratchRoot)).toEqual([]);

    const release = await publisher.snapshot({
      connectionId: CONNECTION,
      repository: REPOSITORY,
      baseBranch: "release",
    });
    expect(release.branch).toBe("release");
    expect(git(setup.root, "bundle", "list-heads", release.bundle)).toBe(
      `${setup.commit} refs/heads/release`,
    );
    await release.release();

    // The token is never an argument, only an environment header.
    for (const call of setup.calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
    }
    const remoteCalls = setup.calls.filter((call) =>
      call.args.includes(REMOTE_URL),
    );
    expect(remoteCalls.length).toBeGreaterThan(0);
    for (const call of remoteCalls) {
      expect(call.environment.GIT_CONFIG_VALUE_0).toContain("basic ");
    }
  });

  it("fails cleanly for a missing branch or connection", async () => {
    const setup = await fixture();
    const { publisher } = await service({ fixture: setup });
    await expect(
      publisher.snapshot({
        connectionId: CONNECTION,
        repository: REPOSITORY,
        baseBranch: "nope",
      }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    await expect(
      publisher.snapshot({
        connectionId: "c0ffee00000f",
        repository: REPOSITORY,
      }),
    ).rejects.toMatchObject({ code: "connection_missing" });
    await expect(
      publisher.snapshot({
        connectionId: CONNECTION,
        repository: "https://gitlab.com/octo/hello",
      }),
    ).rejects.toMatchObject({ code: "repository_invalid" });
    expect(await fs.readdir(setup.scratchRoot)).toEqual([]);
  });

  it("parses snapshot requests strictly", () => {
    const valid = { connectionId: CONNECTION, repository: REPOSITORY };
    expect(parseSnapshot(valid)).toEqual(valid);
    expect(parseSnapshot({ ...valid, baseBranch: "develop" })).toMatchObject({
      baseBranch: "develop",
    });
    expect(() => parseSnapshot({ ...valid, token: "x" })).toThrow(
      "field_unknown",
    );
    expect(() => parseSnapshot({ ...valid, baseBranch: "../x" })).toThrow(
      "baseBranch_invalid",
    );
    expect(() => parseSnapshot({ ...valid, connectionId: "../x" })).toThrow(
      "connectionId_invalid",
    );
  });
});

describe("archives", { timeout: 30_000 }, () => {
  it("archives the default branch head with the connection's token only in git's environment", async () => {
    const setup = await fixture();
    const { publisher } = await service({ fixture: setup });
    const archive = await publisher.archive({
      connectionId: CONNECTION,
      repository: REPOSITORY,
    });
    expect(archive.branch).toBe("main");
    expect(archive.commit).toBe(git(setup.remote, "rev-parse", "main"));
    expect(archive.file.startsWith(setup.scratchRoot)).toBe(true);
    const listed = execFileSync("tar", ["-tf", archive.file], {
      encoding: "utf8",
    });
    expect(listed.trim().split("\n")).toEqual(["README.md"]);
    await archive.release();
    expect(await fs.readdir(setup.scratchRoot)).toEqual([]);

    for (const call of setup.calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
    }
    const remoteCalls = setup.calls.filter((call) =>
      call.args.includes(REMOTE_URL),
    );
    expect(remoteCalls.length).toBeGreaterThan(0);
    for (const call of remoteCalls) {
      expect(call.environment.GIT_CONFIG_VALUE_0).toContain("basic ");
    }
  });

  it("fetches a public repository with no connection and no token", async () => {
    const setup = await fixture();
    const { publisher } = await service({
      fixture: setup,
      withCredential: false,
    });
    const archive = await publisher.archive({ repository: REPOSITORY });
    expect(archive.branch).toBe("main");
    await archive.release();
    for (const call of setup.calls) {
      expect(call.environment.GIT_CONFIG_VALUE_0).toBeUndefined();
    }
  });

  it("refuses an archive over the size limit and leaves nothing behind", async () => {
    const setup = await fixture();
    const { publisher } = await service({
      fixture: setup,
      maxArchiveBytes: 100,
    });
    await expect(
      publisher.archive({ connectionId: CONNECTION, repository: REPOSITORY }),
    ).rejects.toMatchObject({ status: 413, code: "repository_too_large" });
    expect(await fs.readdir(setup.scratchRoot)).toEqual([]);
  });

  it("fails cleanly for a missing connection or repository", async () => {
    const setup = await fixture();
    const { publisher } = await service({ fixture: setup });
    await expect(
      publisher.archive({
        connectionId: "c0ffee00000f",
        repository: REPOSITORY,
      }),
    ).rejects.toMatchObject({ code: "connection_missing" });
    await expect(
      publisher.archive({ repository: "https://gitlab.com/octo/hello" }),
    ).rejects.toMatchObject({ code: "repository_invalid" });
    // A repository git cannot fetch (private, with no token, or gone).
    await fs.rm(setup.remote, { recursive: true, force: true });
    await expect(
      publisher.archive({ repository: REPOSITORY }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(await fs.readdir(setup.scratchRoot)).toEqual([]);
  });

  it("parses archive requests strictly", () => {
    expect(parseArchive({ repository: REPOSITORY })).toEqual({
      repository: REPOSITORY,
    });
    expect(
      parseArchive({ connectionId: CONNECTION, repository: REPOSITORY }),
    ).toEqual({ connectionId: CONNECTION, repository: REPOSITORY });
    expect(() =>
      parseArchive({ repository: REPOSITORY, baseBranch: "main" }),
    ).toThrow("field_unknown");
    expect(() =>
      parseArchive({ repository: REPOSITORY, connectionId: "../x" }),
    ).toThrow("connectionId_invalid");
    expect(() => parseArchive({})).toThrow("repository_invalid");
  });
});

describe("publisher HTTP", { timeout: 30_000 }, () => {
  it("streams an archive to the server's client", async () => {
    const setup = await fixture();
    const dataDirectory = path.join(setup.root, "publisher-data");
    const publisher = await startPublisher({
      host: "127.0.0.1",
      port: 0,
      token: "shared-token",
      tasksRoot: setup.tasksRoot,
      dataDirectory,
      vaultKey: KEY,
      github: fakeGitHub().api,
      git: setup.localGit,
    });
    try {
      const client = createPublisherClient({
        host: "127.0.0.1",
        port: publisher.port,
        token: async () => "shared-token",
      });
      const destination = path.join(setup.root, "files.tar");
      await expect(
        client.archive({ repository: REPOSITORY }, destination),
      ).resolves.toEqual({
        branch: "main",
        commit: git(setup.remote, "rev-parse", "main"),
      });
      expect(
        execFileSync("tar", ["-tf", destination], { encoding: "utf8" }).trim(),
      ).toBe("README.md");
      await fs.rm(setup.remote, { recursive: true, force: true });
      await expect(
        client.archive(
          { repository: REPOSITORY },
          path.join(setup.root, "other.tar"),
        ),
      ).rejects.toMatchObject({ code: "fetch_failed" });
      await vi.waitFor(async () =>
        expect(await fs.readdir(path.join(dataDirectory, "scratch"))).toEqual(
          [],
        ),
      );
    } finally {
      await publisher.close();
    }
  });

  it("streams a snapshot to the server's client", async () => {
    const setup = await fixture();
    const dataDirectory = path.join(setup.root, "publisher-data");
    const vault = await openCredentialVault({
      file: path.join(dataDirectory, "connections.enc"),
      key: KEY,
    });
    await vault.put({
      id: CONNECTION,
      kind: "app",
      login: "reefbarman",
      accessToken: TOKEN,
      updatedAt: 1,
    });
    const publisher = await startPublisher({
      host: "127.0.0.1",
      port: 0,
      token: "shared-token",
      tasksRoot: setup.tasksRoot,
      dataDirectory,
      vaultKey: KEY,
      github: fakeGitHub().api,
      git: setup.localGit,
    });
    try {
      const client = createPublisherClient({
        host: "127.0.0.1",
        port: publisher.port,
        token: async () => "shared-token",
      });
      const destination = path.join(setup.root, "base.bundle");
      await expect(
        client.snapshot(
          { connectionId: CONNECTION, repository: REPOSITORY },
          destination,
        ),
      ).resolves.toEqual({ branch: "main" });
      expect(git(setup.root, "bundle", "list-heads", destination)).toContain(
        "refs/heads/main",
      );
      await expect(
        client.snapshot(
          { connectionId: "c0ffee00000f", repository: REPOSITORY },
          path.join(setup.root, "other.bundle"),
        ),
      ).rejects.toMatchObject({ status: 404, code: "connection_missing" });
      // Nothing left in the publisher's scratch area.
      await vi.waitFor(async () =>
        expect(await fs.readdir(path.join(dataDirectory, "scratch"))).toEqual(
          [],
        ),
      );
    } finally {
      await publisher.close();
    }
  });

  it("answers only requests with the shared token", async () => {
    const setup = await fixture();
    const publisher = await startPublisher({
      host: "127.0.0.1",
      port: 0,
      token: "shared-token",
      tasksRoot: setup.tasksRoot,
      dataDirectory: path.join(setup.root, "publisher-data"),
      vaultKey: KEY,
      github: fakeGitHub().api,
      git: setup.localGit,
    });
    try {
      const base = `http://127.0.0.1:${publisher.port}`;
      const refused = await fetch(`${base}/v1/health`);
      expect(refused.status).toBe(401);
      const wrong = await fetch(`${base}/v1/health`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
      const health = await fetch(`${base}/v1/health`, {
        headers: { authorization: "Bearer shared-token" },
      });
      expect(await health.json()).toEqual({
        protocol: 1,
        build: { version: "dev", id: "dev" },
        deviceFlow: false,
      });
      const device = await fetch(`${base}/v1/connections/c0ffee000005/device`, {
        method: "POST",
        headers: { authorization: "Bearer shared-token" },
      });
      expect(device.status).toBe(409);
      expect(await device.json()).toEqual({
        error: "github_app_not_configured",
      });
    } finally {
      await publisher.close();
    }
  });
});
