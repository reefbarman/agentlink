import type {
  DirectoryRepository,
  RepositoryDirectoryList,
} from "./githubRepositories.js";
import type {
  RepositorySnapshot,
  RepositorySnapshots,
} from "./repositorySnapshots.js";
import {
  assistantRoutingInstructions,
  createRepositoryTools,
  searchRepositories,
} from "./repositoryTools.js";
import { describe, expect, it, vi } from "vitest";

import { PublisherRequestError } from "./publisherClient.js";

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

function snapshotOf(
  files: Record<string, string | Buffer>,
): RepositorySnapshot {
  const entries = new Map(
    Object.entries(files)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([filePath, content], index) => [
        filePath,
        { offset: index, size: Buffer.from(content).length },
      ]),
  );
  return {
    repository: "https://github.com/reefbarman/site",
    branch: "main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    fetchedAt: 0,
    files: entries,
    truncated: false,
    read: async (filePath, maxBytes) =>
      Buffer.from(files[filePath]!).subarray(0, maxBytes),
  };
}

function readSetup(options: {
  readonly snapshot?: RepositorySnapshot;
  readonly error?: unknown;
  readonly reaches?: boolean;
}) {
  const snapshots: RepositorySnapshots = {
    get: vi.fn(async () => {
      if (options.error) throw options.error;
      return options.snapshot!;
    }),
    sweep: vi.fn(),
  };
  const resolve = createRepositoryTools({
    directory: {
      list: vi.fn(),
      resolveConnection: vi.fn(),
      invalidate: vi.fn(),
    },
    connections: { get: () => undefined },
    snapshots,
    reaches: async () => options.reaches ?? false,
  });
  const run = async (input: Record<string, unknown>) => {
    const tools = (await resolve({} as never)) as unknown as RunnableTool[];
    const tool = tools.find(
      (candidate) => candidate.definition.name === "read_repository",
    );
    const result = (await tool!.executeValidated(input, {} as never)) as {
      modelContent: unknown;
      isError?: boolean;
    };
    return { text: String(result.modelContent), isError: result.isError };
  };
  return { snapshots, run };
}

describe("read_repository", () => {
  const SNAPSHOT = snapshotOf({
    "README.md": "# Site\nBuilt with Astro.\n",
    "package.json": '{"scripts":{"build":"astro build","test":"vitest"}}\n',
    "src/pages/index.astro": "<h1>Hello</h1>\n",
    "src/pages/about.astro": "<h1>About me</h1>\n",
    "public/logo.png": Buffer.from([0x89, 0x50, 0x00, 0x01]),
  });

  it("is only offered with snapshots", async () => {
    const names = async (snapshots?: RepositorySnapshots) => {
      const resolve = createRepositoryTools({
        directory: {
          list: vi.fn(),
          resolveConnection: vi.fn(),
          invalidate: vi.fn(),
        },
        connections: { get: () => undefined },
        ...(snapshots ? { snapshots } : {}),
      });
      const tools = (await resolve({} as never)) as unknown as Array<
        RunnableTool & { displayInput?: (input: unknown) => unknown }
      >;
      // Each tool card shows what was asked for, not an empty {}.
      for (const tool of tools) {
        expect(tool.displayInput?.({ repository: "a/b" })).toEqual({
          repository: "a/b",
        });
      }
      return tools.map((tool) => tool.definition.name);
    };
    expect(await names()).toEqual(["list_repositories"]);
    expect(await names(readSetup({ snapshot: SNAPSHOT }).snapshots)).toEqual([
      "list_repositories",
      "read_repository",
    ]);
  });

  it("lists files, reads one, lists a folder and searches", async () => {
    const test = readSetup({ snapshot: SNAPSHOT });
    const listing = await test.run({ repository: "reefbarman/site" });
    expect(test.snapshots.get).toHaveBeenCalledWith(
      "https://github.com/reefbarman/site",
      { refresh: false },
    );
    expect(listing.text).toContain(
      "reefbarman/site at main (commit 0123456789ab), 5 files",
    );
    expect(listing.text).toContain("untrusted data");
    expect(listing.text).toContain("5 files:");
    expect(listing.text).toContain("src/pages/about.astro");

    const file = await test.run({
      repository: "https://github.com/reefbarman/site",
      path: "package.json",
      refresh: true,
    });
    expect(test.snapshots.get).toHaveBeenLastCalledWith(
      "https://github.com/reefbarman/site",
      { refresh: true },
    );
    expect(file.text).toContain('"build":"astro build"');

    const folder = await test.run({
      repository: "reefbarman/site",
      path: "src/pages/",
    });
    expect(folder.text).toContain("2 files under src/pages:");
    expect(folder.text).not.toContain("README.md");

    const search = await test.run({
      repository: "reefbarman/site",
      query: "ABOUT",
    });
    expect(search.text).toContain("src/pages/about.astro:1: <h1>About me</h1>");
    expect(search.text).not.toContain("index.astro");

    const binary = await test.run({
      repository: "reefbarman/site",
      path: "public/logo.png",
    });
    expect(binary.text).toContain(
      "public/logo.png is a binary file of 4 bytes.",
    );

    const missing = await test.run({
      repository: "reefbarman/site",
      path: "nope",
    });
    expect(missing.text).toContain("No file or folder named nope.");
  });

  it("refuses something that is not a GitHub repository", async () => {
    const test = readSetup({ snapshot: SNAPSHOT });
    const result = await test.run({ repository: "https://gitlab.com/a/b" });
    expect(result.isError).toBe(true);
    expect(test.snapshots.get).not.toHaveBeenCalled();
  });

  it("explains a private repository no connection reaches", async () => {
    const test = readSetup({
      error: new PublisherRequestError(502, "fetch_failed"),
    });
    const result = await test.run({ repository: "someone/secret" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "someone/secret is private or does not exist. If it is one of the owner's, add the AgentLink Assistant app to it at https://github.com/settings/installations",
    );
  });

  it("explains failures for a repository a connection reaches", async () => {
    const reached = readSetup({
      error: new PublisherRequestError(502, "fetch_failed"),
      reaches: true,
    });
    expect(
      (await reached.run({ repository: "reefbarman/site" })).text,
    ).toContain("GitHub would not let the owner's connection fetch");
    const large = readSetup({
      error: new PublisherRequestError(413, "repository_too_large"),
      reaches: true,
    });
    expect((await large.run({ repository: "reefbarman/site" })).text).toContain(
      "too large to read here",
    );
  });
});

describe("routing instructions", () => {
  it("asks for checks on the card once read_repository exists", () => {
    const withRead = assistantRoutingInstructions({
      tasks: true,
      repositories: true,
      read: true,
    });
    expect(withRead).toContain("read_repository");
    expect(withRead).toContain("start_task's validation");
    expect(withRead).toContain("start_task's references");
    expect(withRead).not.toContain("\u2014");
    expect(
      assistantRoutingInstructions({ tasks: true, repositories: true }),
    ).not.toContain("read_repository");
  });

  it("covers the tools the chat actually has", () => {
    const full = assistantRoutingInstructions({
      tasks: true,
      repositories: true,
    });
    expect(full).toContain("start_task");
    expect(full).toContain("continue_task");
    expect(full).toContain("comes back to this chat by itself");
    // The four ways, chosen by the assistant, never by the owner.
    for (const way of [
      "Answer here",
      "Work here",
      "Start a work session",
      "Schedule",
    ]) {
      expect(full).toContain(`- ${way}:`);
    }
    expect(full).toContain("here: true");
    expect(full).toContain("Never ask them to choose a mode");
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
