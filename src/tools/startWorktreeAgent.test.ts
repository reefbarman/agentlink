import * as vscode from "vscode";
import { mkdtemp, realpath, rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import {
  findGitRemoteForRepository,
  generatedBranchName,
  handleStartWorktreeAgent,
  parseWorktreeList,
  sanitizePathSegment,
  validateDestinationPath,
  type GitRunner,
} from "./startWorktreeAgent.js";

type GitCall = { args: string[]; cwd: string };

type MockGitRunner = GitRunner & {
  calls: GitCall[];
  mockImplementation: (fn: GitRunner) => unknown;
};

function textPayload(result: ToolResult) {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text result");
  return JSON.parse(first.text) as Record<string, unknown>;
}

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentlink-worktree-tool-"));
  tmpDirs.push(dir);
  return realpath(dir);
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function workspaceFolder(
  folderPath: string,
  scheme = "file",
): vscode.WorkspaceFolder {
  return {
    uri:
      scheme === "file"
        ? vscode.Uri.file(folderPath)
        : ({ scheme, fsPath: folderPath, path: folderPath } as vscode.Uri),
    name: "repo",
    index: 0,
  };
}

function makeGit(outputs: Record<string, string>): MockGitRunner {
  const calls: GitCall[] = [];
  const runner = vi.fn(async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    const key = args.join(" ");
    if (!(key in outputs)) throw new Error(`unexpected git: ${key}`);
    return outputs[key];
  }) as unknown as MockGitRunner;
  runner.calls = calls;
  return runner;
}

describe("startWorktreeAgent utilities", () => {
  it("sanitizes path segments and generated branch names", () => {
    expect(sanitizePathSegment("Try API client refactor!!")).toBe(
      "try-api-client-refactor",
    );
    expect(
      generatedBranchName(
        "Try API client refactor!!",
        "12345678-aaaa-bbbb-cccc-123456789abc",
      ),
    ).toBe("agentlink/try-api-client-refactor-12345678");
  });

  it("parses git worktree porcelain output", () => {
    expect(
      parseWorktreeList(
        [
          "worktree /repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /repo-wt/task",
          "HEAD def456",
          "branch refs/heads/agentlink/task",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "/repo", head: "abc123", branch: "refs/heads/main" },
      {
        path: "/repo-wt/task",
        head: "def456",
        branch: "refs/heads/agentlink/task",
      },
    ]);
  });

  it("rejects destinations inside .git", async () => {
    await expect(
      validateDestinationPath("/repo/.git/worktrees/x", "/repo", "/repo/.git"),
    ).rejects.toThrow(/\.git/);
  });

  it("matches GitHub repositories across HTTPS and SSH remote URLs", () => {
    expect(
      findGitRemoteForRepository(
        [
          "origin https://github.com/owner/repo.git (fetch)",
          "origin https://github.com/owner/repo.git (push)",
        ].join("\n"),
        "owner/repo",
      ),
    ).toBe("origin");
    expect(
      findGitRemoteForRepository(
        "upstream git@github-personal:Owner/Repo.git (fetch)",
        "owner/repo",
      ),
    ).toBe("upstream");
    expect(
      findGitRemoteForRepository(
        "--upload-pack https://github.com/owner/repo.git (fetch)",
        "owner/repo",
      ),
    ).toBeUndefined();
  });
});

describe("handleStartWorktreeAgent", () => {
  function baseGitOutputs(
    repoRoot: string,
    worktreePath: string,
    branch: string,
  ): Record<string, string> {
    return {
      "rev-parse --show-toplevel": `${repoRoot}\n`,
      "rev-parse --git-common-dir": ".git\n",
      "rev-parse HEAD": "abc123\n",
      "status --porcelain": "",
      "worktree list --porcelain": `worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n`,
      [`show-ref --verify --quiet refs/heads/${branch}`]: "",
      [`worktree add ${worktreePath} ${branch}`]: "",
    };
  }

  it("requires explicit sourcePath in multi-root workspaces", async () => {
    const result = await handleStartWorktreeAgent(
      { task: "Task", prompt: "Do task" },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [
          workspaceFolder("/repo-a"),
          workspaceFolder("/repo-b"),
        ],
      },
    );

    expect(textPayload(result)).toMatchObject({
      status: "error",
      error: expect.stringContaining("Multiple workspace folders"),
    });
  });

  it("rejects non-file workspaces", async () => {
    const result = await handleStartWorktreeAgent(
      { task: "Task", prompt: "Do task" },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder("/repo", "vscode-remote")],
      },
    );

    expect(textPayload(result)).toMatchObject({
      status: "error",
      error: expect.stringContaining("only supports local file workspaces"),
    });
  });

  it("returns rejected without creating a worktree when approval is denied", async () => {
    const repoRoot = await makeTmpDir();
    const worktreePath = path.join(await makeTmpDir(), "task");
    const branch = "agentlink/task";
    const git = makeGit(baseGitOutputs(repoRoot, worktreePath, branch));
    const writeIntent = vi.fn();
    const openFolder = vi.fn();
    const onApprovalRequest = vi.fn().mockResolvedValue("deny");

    const result = await handleStartWorktreeAgent(
      {
        task: "Task",
        prompt: "Do task",
        branch,
        worktreePath,
      },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder(repoRoot)],
        runGit: git,
        onApprovalRequest,
        intentStore: { writeIntent } as never,
        openFolder,
      },
    );

    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      decision: "deny",
      worktreePath,
      branch,
      baseRef: "abc123",
      repoRoot,
      sourceTreeDirty: false,
    });
    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "worktree",
        targetPath: worktreePath,
      }),
      undefined,
    );
    expect(git.calls.map((call) => call.args.join(" "))).not.toContain(
      `worktree add ${worktreePath} ${branch}`,
    );
    expect(writeIntent).not.toHaveBeenCalled();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("creates existing branch worktree, writes intent, then opens folder", async () => {
    const repoRoot = await makeTmpDir();
    const worktreePath = path.join(await makeTmpDir(), "task");
    const branch = "agentlink/task";
    const git = makeGit(baseGitOutputs(repoRoot, worktreePath, branch));
    const order: string[] = [];
    const writeIntent = vi.fn(async () => {
      order.push("intent");
      return { id: "intent-1" };
    });
    const openFolder = vi.fn(async () => {
      order.push("open");
    });

    const result = await handleStartWorktreeAgent(
      {
        task: "Task",
        prompt: "Do task",
        branch,
        worktreePath,
        autoSubmit: false,
      },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder(repoRoot)],
        runGit: git,
        onApprovalRequest: vi.fn().mockResolvedValue("approve-autosubmit"),
        intentStore: { writeIntent } as never,
        openFolder,
      },
    );

    expect(textPayload(result)).toMatchObject({
      status: "opened",
      intentId: "intent-1",
      branch,
    });
    expect(git.calls.map((call) => call.args.join(" "))).toContain(
      `worktree add ${worktreePath} ${branch}`,
    );
    expect(writeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath,
        branch,
        prompt: "Do task",
        autoSubmit: true,
      }),
    );
    expect(order).toEqual(["intent", "open"]);
  });

  it("fetches an approved GitHub PR ref before creating the review worktree", async () => {
    const repoRoot = await makeTmpDir();
    const worktreePath = path.join(await makeTmpDir(), "review");
    const branch = "agentlink/review-pr-123-abcdef12";
    const git = makeGit({
      "rev-parse --show-toplevel": `${repoRoot}\n`,
      "rev-parse --git-common-dir": ".git\n",
      "remote -v": [
        "origin git@github.com:owner/repo.git (fetch)",
        "origin git@github.com:owner/repo.git (push)",
      ].join("\n"),
      "status --porcelain": "",
      "worktree list --porcelain": `worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n`,
      "fetch origin refs/pull/123/head": "",
      "rev-parse FETCH_HEAD": "prhead123\n",
      [`worktree add -b ${branch} ${worktreePath} prhead123`]: "",
    });
    const writeIntent = vi.fn(async () => ({ id: "intent-1" }));
    const onApprovalRequest = vi.fn().mockResolvedValue("approve-autosubmit");

    await handleStartWorktreeAgent(
      {
        task: "Review owner/repo#123",
        prompt: "Review the PR",
        branch,
        worktreePath,
        mode: "review",
        autoSubmit: true,
        fetchRef: {
          repository: "owner/repo",
          ref: "refs/pull/123/head",
        },
      },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder(repoRoot)],
        runGit: git,
        onApprovalRequest,
        intentStore: { writeIntent } as never,
        openFolder: vi.fn(async () => undefined),
      },
    );

    const calls = git.calls.map((call) => call.args.join(" "));
    expect(calls.indexOf("fetch origin refs/pull/123/head")).toBeGreaterThan(
      calls.indexOf("worktree list --porcelain"),
    );
    expect(calls.indexOf("fetch origin refs/pull/123/head")).toBeLessThan(
      calls.indexOf(`worktree add -b ${branch} ${worktreePath} prhead123`),
    );
    expect(onApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("origin:refs/pull/123/head"),
      }),
      undefined,
    );
    expect(writeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRef: "prhead123",
        mode: "review",
        autoSubmit: true,
      }),
    );
  });

  it("rejects an existing review branch instead of opening stale PR code", async () => {
    const repoRoot = await makeTmpDir();
    const worktreePath = path.join(await makeTmpDir(), "review-stale");
    const branch = "agentlink/review-pr-123-stale";
    const git = makeGit({
      "rev-parse --show-toplevel": `${repoRoot}\n`,
      "rev-parse --git-common-dir": ".git\n",
      "remote -v": "origin https://github.com/owner/repo.git (fetch)\n",
      "status --porcelain": "",
      "worktree list --porcelain": `worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n`,
      [`show-ref --verify --quiet refs/heads/${branch}`]: "",
    });

    const result = await handleStartWorktreeAgent(
      {
        task: "Review owner/repo#123",
        prompt: "Review the PR",
        branch,
        worktreePath,
        fetchRef: {
          repository: "owner/repo",
          ref: "refs/pull/123/head",
        },
      },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder(repoRoot)],
        runGit: git,
        onApprovalRequest: vi.fn(),
        intentStore: { writeIntent: vi.fn() } as never,
        openFolder: vi.fn(),
      },
    );

    expect(textPayload(result)).toMatchObject({
      status: "error",
      error: expect.stringContaining("fresh branch"),
    });
    expect(git.calls.map((call) => call.args[0])).not.toContain("fetch");
  });

  it("does not fetch a GitHub PR ref when launch approval is denied", async () => {
    const repoRoot = await makeTmpDir();
    const worktreePath = path.join(await makeTmpDir(), "review-denied");
    const branch = "agentlink/review-pr-123-denied";
    const git = makeGit({
      "rev-parse --show-toplevel": `${repoRoot}\n`,
      "rev-parse --git-common-dir": ".git\n",
      "remote -v": "origin https://github.com/owner/repo.git (fetch)\n",
      "status --porcelain": "",
      "worktree list --porcelain": `worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n`,
    });

    await handleStartWorktreeAgent(
      {
        task: "Review owner/repo#123",
        prompt: "Review the PR",
        branch,
        worktreePath,
        fetchRef: {
          repository: "owner/repo",
          ref: "refs/pull/123/head",
        },
      },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder(repoRoot)],
        runGit: git,
        onApprovalRequest: vi.fn().mockResolvedValue("deny"),
        intentStore: { writeIntent: vi.fn() } as never,
        openFolder: vi.fn(),
      },
    );

    expect(git.calls.map((call) => call.args[0])).not.toContain("fetch");
  });

  it("uses git worktree add -b for new branches", async () => {
    const repoRoot = await makeTmpDir();
    const worktreePath = path.join(await makeTmpDir(), "new");
    const branch = "agentlink/new";
    const git = makeGit(baseGitOutputs(repoRoot, worktreePath, branch));
    git.mockImplementation(async (args: string[], cwd: string) => {
      git.calls.push({ args, cwd });
      const key = args.join(" ");
      if (key === `show-ref --verify --quiet refs/heads/${branch}`) {
        throw new Error("missing ref");
      }
      const outputs = {
        ...baseGitOutputs(repoRoot, worktreePath, branch),
        [`worktree add -b ${branch} ${worktreePath} abc123`]: "",
      };
      const value = outputs[key];
      if (value === undefined) throw new Error(`unexpected git: ${key}`);
      return value;
    });

    await handleStartWorktreeAgent(
      {
        task: "New",
        prompt: "Do new",
        branch,
        worktreePath,
      },
      {
        globalStorageUri: vscode.Uri.file("/global"),
        workspaceFolders: [workspaceFolder(repoRoot)],
        runGit: git,
        onApprovalRequest: vi.fn().mockResolvedValue("approve-prefill"),
        intentStore: {
          writeIntent: vi.fn(async () => ({ id: "intent-1" })),
        } as never,
        openFolder: vi.fn(async () => undefined),
      },
    );

    expect(git.calls.map((call) => call.args.join(" "))).toContain(
      `worktree add -b ${branch} ${worktreePath} abc123`,
    );
  });
});
