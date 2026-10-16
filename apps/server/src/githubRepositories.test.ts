import { describe, expect, it, vi } from "vitest";

import type { GitHubConnection } from "./githubConnections.js";
import { PublisherRequestError } from "./publisherClient.js";
import type { ReachableRepositories } from "./publisher.js";
import { createRepositoryDirectory } from "./githubRepositories.js";

const connection = (id: string, login: string): GitHubConnection => ({
  id,
  kind: "app",
  login,
  commitName: login,
  commitEmail: `${login}@example.com`,
  createdAt: Number.parseInt(id.slice(-1), 16),
  updatedAt: 0,
});

const PERSONAL = connection("c0ffee000001", "reefbarman");
const WORK = connection("c0ffee000002", "TristanSpeakEasy");

const reach = (
  login: string,
  names: readonly string[],
): ReachableRepositories => ({
  login,
  truncated: false,
  repositories: names.map((fullName, index) => {
    const [owner, name] = fullName.split("/") as [string, string];
    return {
      owner,
      name,
      private: true,
      archived: false,
      defaultBranch: "main",
      pushedAt: `2026-10-0${index + 1}T00:00:00Z`,
    };
  }),
});

function setup(
  answers: Record<string, ReachableRepositories | PublisherRequestError>,
  options: { readonly publisher?: false } = {},
) {
  let time = 1_000_000;
  const connections = [PERSONAL, WORK];
  const repositories = vi.fn(async (id: string) => {
    const answer = answers[id];
    if (!answer || answer instanceof PublisherRequestError) {
      throw answer ?? new PublisherRequestError(404, "connection_missing");
    }
    return answer;
  });
  const directory = createRepositoryDirectory({
    connections: {
      list: () => connections,
      get: (id) => connections.find((entry) => entry.id === id),
    },
    publisher: options.publisher === false ? undefined : { repositories },
    settings: {
      list: () => [
        {
          repository: "https://github.com/reefbarman/site",
          validation: ["npm run build"],
          publish: { connectionId: PERSONAL.id, grantedAt: 0 },
          updatedAt: 0,
        },
        {
          repository: "https://gitlab.com/someone/thing",
          validation: ["make"],
          updatedAt: 0,
        },
      ],
    },
    projectRepositories: () => [
      { projectId: "home", url: "https://github.com/reefbarman/agentlink.git" },
    ],
    now: () => time,
  });
  return {
    directory,
    repositories,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("repository directory", () => {
  it("merges what each connection reaches with configured and project repositories", async () => {
    const test = setup({
      [PERSONAL.id]: reach("reefbarman", ["reefbarman/site", "acme/shared"]),
      [WORK.id]: reach("TristanSpeakEasy", ["acme/shared", "speakeasy/api"]),
    });
    const listed = await test.directory.list();
    expect(listed.connections).toEqual([
      { id: PERSONAL.id, login: "reefbarman", status: "ok", repositories: 2 },
      {
        id: WORK.id,
        login: "TristanSpeakEasy",
        status: "ok",
        repositories: 2,
      },
    ]);
    const byName = new Map(
      listed.repositories.map((entry) => [entry.fullName, entry]),
    );
    expect(byName.get("acme/shared")?.connectionIds).toEqual([
      PERSONAL.id,
      WORK.id,
    ]);
    expect(byName.get("reefbarman/site")).toMatchObject({
      repository: "https://github.com/reefbarman/site",
      private: true,
      configured: {
        validation: ["npm run build"],
        publishConnectionId: PERSONAL.id,
      },
    });
    // Configured or cloned but not reached by any connection still shows.
    expect(byName.get("reefbarman/agentlink")).toMatchObject({
      connectionIds: [],
      projectIds: ["home"],
    });
    expect(byName.get("gitlab.com/someone/thing")?.configured).toBeDefined();
    // Never anything that looks like a token.
    expect(JSON.stringify(listed)).not.toMatch(/gh[up]_|github_pat_/u);
  });

  it("caches for five minutes and refreshes on request", async () => {
    const test = setup({
      [PERSONAL.id]: reach("reefbarman", ["reefbarman/site"]),
      [WORK.id]: reach("TristanSpeakEasy", []),
    });
    await test.directory.list();
    await test.directory.list();
    expect(test.repositories).toHaveBeenCalledTimes(2);
    await test.directory.list({ refresh: true });
    expect(test.repositories).toHaveBeenCalledTimes(4);
    test.advance(5 * 60 * 1_000);
    await test.directory.list();
    expect(test.repositories).toHaveBeenCalledTimes(6);
    test.directory.invalidate();
    await test.directory.list();
    expect(test.repositories).toHaveBeenCalledTimes(8);
  });

  it("reports a connection the publisher could not list", async () => {
    const test = setup({
      [PERSONAL.id]: new PublisherRequestError(409, "connection_signed_out"),
      [WORK.id]: reach("TristanSpeakEasy", ["speakeasy/api"]),
    });
    const listed = await test.directory.list();
    expect(listed.connections[0]).toEqual({
      id: PERSONAL.id,
      login: "reefbarman",
      status: "failed",
      error: "connection_signed_out",
      repositories: 0,
    });
    expect(listed.repositories.map((entry) => entry.fullName)).toContain(
      "speakeasy/api",
    );
  });

  it("resolves the one connection that reaches a repository", async () => {
    const test = setup({
      [PERSONAL.id]: reach("reefbarman", ["reefbarman/site", "acme/shared"]),
      [WORK.id]: reach("TristanSpeakEasy", [
        "acme/shared",
        "speakeasy/api",
        "reefbarman/site",
      ]),
    });
    await expect(
      test.directory.resolveConnection("https://github.com/speakeasy/api.git"),
    ).resolves.toEqual({ kind: "one", connectionId: WORK.id });
    // Both reach it: the one whose account owns it.
    await expect(
      test.directory.resolveConnection("https://github.com/ReefBarman/Site"),
    ).resolves.toEqual({ kind: "one", connectionId: PERSONAL.id });
    // Both reach it, neither owns it: the owner has to choose.
    await expect(
      test.directory.resolveConnection("https://github.com/acme/shared"),
    ).resolves.toEqual({
      kind: "ambiguous",
      connectionIds: [PERSONAL.id, WORK.id],
    });
    await expect(
      test.directory.resolveConnection("https://gitlab.com/someone/thing"),
    ).resolves.toEqual({ kind: "none" });
  });

  it("looks again for a repository it has not seen, but not on every call", async () => {
    const answers: Record<string, ReachableRepositories> = {
      [PERSONAL.id]: reach("reefbarman", []),
      [WORK.id]: reach("TristanSpeakEasy", []),
    };
    const test = setup(answers);
    await expect(
      test.directory.resolveConnection("https://github.com/reefbarman/new"),
    ).resolves.toEqual({ kind: "none" });
    expect(test.repositories).toHaveBeenCalledTimes(2);
    // The app was just installed on it.
    answers[PERSONAL.id] = reach("reefbarman", ["reefbarman/new"]);
    test.advance(31_000);
    await expect(
      test.directory.resolveConnection("https://github.com/reefbarman/new"),
    ).resolves.toEqual({ kind: "one", connectionId: PERSONAL.id });
    expect(test.repositories).toHaveBeenCalledTimes(4);
  });

  it("has only configured and project repositories without a publisher", async () => {
    const test = setup({}, { publisher: false });
    const listed = await test.directory.list();
    expect(listed.publisherConfigured).toBe(false);
    expect(listed.connections).toEqual([]);
    expect(listed.repositories).toHaveLength(3);
    await expect(
      test.directory.resolveConnection("https://github.com/reefbarman/site"),
    ).resolves.toEqual({ kind: "none" });
  });
});
