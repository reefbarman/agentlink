import type {
  DirectoryRepository,
  RepositoryDirectoryList,
} from "./githubRepositories.js";
import {
  assistantRoutingInstructions,
  createRepositoryTools,
  searchRepositories,
} from "./repositoryTools.js";
import { describe, expect, it, vi } from "vitest";

interface RunnableTool {
  readonly definition: { readonly name: string };
  executeValidated(
    input: Record<string, unknown>,
    context: never,
  ): Promise<{ modelContent: unknown }>;
}

const entry = (
  fullName: string,
  extra: Partial<DirectoryRepository> = {},
): DirectoryRepository => ({
  repository: `https://github.com/${fullName}`,
  fullName,
  connectionIds: [],
  ...extra,
});

const SITE = entry("reefbarman/tristancartledge.com", {
  private: true,
  defaultBranch: "main",
  description: "Personal website",
  connectionIds: ["c0ffee000001"],
  configured: {
    validation: ["npm run build"],
    publishConnectionId: "c0ffee000001",
  },
});
const AGENTLINK = entry("reefbarman/agentlink", {
  private: false,
  connectionIds: ["c0ffee000001", "c0ffee000002"],
  projectIds: ["home"],
});
const API = entry("speakeasy/api", { archived: true });

function setup(list: Partial<RepositoryDirectoryList>) {
  const directory = {
    list: vi.fn(async (): Promise<RepositoryDirectoryList> => ({
      publisherConfigured: true,
      connections: [],
      repositories: [],
      ...list,
    })),
    resolveConnection: vi.fn(),
    invalidate: vi.fn(),
  };
  const logins: Record<string, string> = {
    c0ffee000001: "reefbarman",
    c0ffee000002: "TristanSpeakEasy",
  };
  const resolve = createRepositoryTools({
    directory,
    connections: {
      get: (id) =>
        logins[id]
          ? {
              id,
              kind: "app",
              login: logins[id],
              commitName: "x",
              commitEmail: "x@example.com",
              createdAt: 0,
              updatedAt: 0,
            }
          : undefined,
    },
  });
  const run = async (input: Record<string, unknown>) => {
    const [tool] = (await resolve({} as never)) as unknown as RunnableTool[];
    expect(tool!.definition.name).toBe("list_repositories");
    return String(
      (await tool!.executeValidated(input, {} as never)).modelContent,
    );
  };
  return { directory, run };
}

describe("searchRepositories", () => {
  it("ranks name matches over owner and description matches", () => {
    const all = [API, SITE, AGENTLINK];
    expect(searchRepositories(all, "website").map((e) => e.fullName)).toEqual([
      "reefbarman/tristancartledge.com",
    ]);
    expect(
      searchRepositories(all, "the AgentLink repo").map((e) => e.fullName),
    ).toEqual(["reefbarman/agentlink"]);
    expect(
      searchRepositories(all, "reefbarman").map((e) => e.fullName),
    ).toEqual(["reefbarman/tristancartledge.com", "reefbarman/agentlink"]);
    expect(searchRepositories(all, undefined)).toEqual(all);
    expect(searchRepositories(all, "zzz")).toEqual([]);
  });
});

describe("list_repositories", () => {
  it("describes matches with what the owner set up for them", async () => {
    const test = setup({
      connections: [
        {
          id: "c0ffee000001",
          login: "reefbarman",
          status: "ok",
          repositories: 2,
        },
      ],
      repositories: [SITE, AGENTLINK, API],
    });
    const output = await test.run({ query: "agentlink", refresh: true });
    expect(test.directory.list).toHaveBeenCalledWith({ refresh: true });
    expect(output).toContain('1 repository matching "agentlink":');
    expect(output).toContain(
      "- reefbarman/agentlink: https://github.com/reefbarman/agentlink (public; reachable by reefbarman, TristanSpeakEasy; cloned in project home)",
    );
    const all = await test.run({});
    expect(all).toContain("3 repositories:");
    expect(all).toContain(
      "private; default branch main; reachable by reefbarman; checks: npm run build; publishes draft PRs as reefbarman",
    );
    expect(all).toContain("  Personal website");
    expect(all).toContain("archived");
  });

  it("tells the chat how the owner can make a missing repository reachable", async () => {
    const test = setup({ repositories: [AGENTLINK] });
    const output = await test.run({ query: "website" });
    expect(output).toContain('No repository matched "website".');
    expect(output).toContain("https://github.com/settings/installations");
    expect(output).toContain("No GitHub account is connected");
  });

  it("explains connections that could not be listed", async () => {
    const test = setup({
      connections: [
        {
          id: "c0ffee000001",
          login: "reefbarman",
          status: "failed",
          error: "connection_signed_out",
          repositories: 0,
        },
        {
          id: "c0ffee000002",
          login: "TristanSpeakEasy",
          status: "ok",
          repositories: 1000,
          truncated: true,
        },
      ],
      repositories: [API],
    });
    const output = await test.run({});
    expect(output).toContain(
      "The reefbarman connection is signed out: the owner must sign it in again in the Assistant's GitHub panel.",
    );
    expect(output).toContain(
      "The TristanSpeakEasy connection reaches more repositories than are listed.",
    );
  });

  it("says when GitHub is not set up at all", async () => {
    const test = setup({ publisherConfigured: false, repositories: [] });
    expect(await test.run({})).toContain("GitHub is not set up on this server");
  });
});

describe("routing instructions", () => {
  it("covers the tools the chat actually has", () => {
    const full = assistantRoutingInstructions({
      tasks: true,
      repositories: true,
    });
    expect(full).toContain("start_task");
    expect(full).toContain("never ask the owner to switch project");
    expect(full).toContain("list_repositories");
    expect(full).toContain("schedule_job");
    const bare = assistantRoutingInstructions({
      tasks: false,
      repositories: false,
    });
    expect(bare).not.toContain("start_task");
    expect(bare).not.toContain("list_repositories");
    // Instructions are prose for the owner's assistant: no em dashes.
    expect(full).not.toContain("\u2014");
  });
});
