import { parseGitHubRepository } from "./githubApi.js";
import type { GitHubConnectionStore } from "./githubConnections.js";
import {
  PublisherRequestError,
  type PublisherClient,
} from "./publisherClient.js";
import {
  repositoryKey,
  type RepositorySettingsStore,
} from "./taskRepositories.js";

/**
 * The repositories the owner works with, in one list: every repository
 * each GitHub connection can reach (asked of the publisher, which keeps
 * the tokens), the repositories the owner configured for tasks, and the
 * ones cloned into projects. Chats search it with `list_repositories`, and
 * tasks use it to pick the connection to clone a repository with when the
 * owner did not choose one.
 *
 * What the connections reach is cached for `ttlMs` (5 minutes); a refresh
 * asks again.
 */

export const DIRECTORY_TTL_MS = 5 * 60 * 1_000;
/** A repository not found is looked for again after this long. */
const MISS_REFRESH_MS = 30 * 1_000;

export interface DirectoryRepository {
  /** `https://github.com/<owner>/<name>` (or the configured clone URL). */
  readonly repository: string;
  /** `owner/name` for GitHub, `host/path` otherwise. */
  readonly fullName: string;
  readonly private?: boolean;
  readonly archived?: boolean;
  readonly defaultBranch?: string;
  readonly description?: string;
  readonly pushedAt?: string;
  /** Connections that can reach it, in the order they were added. */
  readonly connectionIds: readonly string[];
  /** The owner's settings for it, when there are any. */
  readonly configured?: {
    readonly validation: readonly string[];
    readonly publishConnectionId?: string;
  };
  /** Projects holding a clone of it. */
  readonly projectIds?: readonly string[];
}

export interface DirectoryConnection {
  readonly id: string;
  readonly login?: string;
  /** `failed` with `error`: the publisher could not list it. */
  readonly status: "ok" | "failed";
  readonly error?: string;
  readonly repositories: number;
  /** More than the publisher lists: some were left out. */
  readonly truncated?: boolean;
}

export interface RepositoryDirectoryList {
  readonly publisherConfigured: boolean;
  /** When the connections were last asked; absent when never. */
  readonly fetchedAt?: number;
  readonly connections: readonly DirectoryConnection[];
  readonly repositories: readonly DirectoryRepository[];
}

/** Which connection a task on a repository should use. */
export type ConnectionResolution =
  | { readonly kind: "one"; readonly connectionId: string }
  | { readonly kind: "ambiguous"; readonly connectionIds: readonly string[] }
  | { readonly kind: "none" };

export interface RepositoryDirectory {
  list(options?: {
    readonly refresh?: boolean;
  }): Promise<RepositoryDirectoryList>;
  /**
   * The one connection that can reach this repository. When several can,
   * the one whose account owns it; otherwise the owner has to choose.
   */
  resolveConnection(repository: string): Promise<ConnectionResolution>;
  /** Forget what the connections reach (a connection changed). */
  invalidate(): void;
}

interface Reached {
  readonly at: number;
  readonly byConnection: ReadonlyMap<
    string,
    | {
        readonly login: string;
        readonly repositories: readonly {
          readonly owner: string;
          readonly name: string;
          readonly private: boolean;
          readonly archived: boolean;
          readonly defaultBranch?: string;
          readonly description?: string;
          readonly pushedAt?: string;
        }[];
        readonly truncated: boolean;
      }
    | { readonly error: string }
  >;
}

export function createRepositoryDirectory(options: {
  readonly connections: Pick<GitHubConnectionStore, "list" | "get">;
  /** Undefined when the server has no publisher. */
  readonly publisher: Pick<PublisherClient, "repositories"> | undefined;
  readonly settings?: Pick<RepositorySettingsStore, "list">;
  /** Clone URLs of each project's repositories. */
  readonly projectRepositories?: () => readonly {
    readonly projectId: string;
    readonly url: string;
  }[];
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): RepositoryDirectory {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DIRECTORY_TTL_MS;
  let reached: Reached | undefined;
  let loading: Promise<Reached> | undefined;
  /** Bumped by `invalidate`, so a load already running is not kept. */
  let generation = 0;

  const load = async (refresh: boolean): Promise<Reached | undefined> => {
    const publisher = options.publisher;
    if (!publisher) return undefined;
    if (!refresh && reached && now() - reached.at < ttlMs) return reached;
    if (loading) return loading;
    const started = generation;
    const pending = (async (): Promise<Reached> => {
      const byConnection = new Map<
        string,
        Reached["byConnection"] extends ReadonlyMap<string, infer V> ? V : never
      >();
      await Promise.all(
        options.connections.list().map(async (connection) => {
          try {
            const listed = await publisher.repositories(connection.id);
            byConnection.set(connection.id, listed);
          } catch (error) {
            const code =
              error instanceof PublisherRequestError
                ? error.code
                : "publisher_unavailable";
            options.log?.(
              `GitHub: could not list connection ${connection.id}'s repositories: ${code}`,
            );
            byConnection.set(connection.id, { error: code });
          }
        }),
      );
      return { at: now(), byConnection };
    })();
    loading = pending;
    try {
      const result = await pending;
      if (generation === started) reached = result;
      return result;
    } finally {
      if (loading === pending) loading = undefined;
    }
  };

  const build = (data: Reached | undefined): RepositoryDirectoryList => {
    const entries = new Map<
      string,
      {
        repository: string;
        fullName: string;
        private?: boolean;
        archived?: boolean;
        defaultBranch?: string;
        description?: string;
        pushedAt?: string;
        connectionIds: string[];
        configured?: DirectoryRepository["configured"];
        projectIds?: string[];
      }
    >();
    const entryFor = (url: string) => {
      let key: string;
      try {
        key = repositoryKey(url);
      } catch {
        return undefined;
      }
      let entry = entries.get(key);
      if (!entry) {
        const github = parseGitHubRepository(url);
        entry = {
          repository: github
            ? `https://github.com/${github.owner}/${github.name}`
            : key,
          fullName: github
            ? `${github.owner}/${github.name}`
            : key.replace(/^https:\/\//u, ""),
          connectionIds: [],
        };
        entries.set(key, entry);
      }
      return entry;
    };

    const connections: DirectoryConnection[] = [];
    for (const connection of options.connections.list()) {
      const result = data?.byConnection.get(connection.id);
      if (!result) continue;
      if ("error" in result) {
        connections.push({
          id: connection.id,
          ...(connection.login ? { login: connection.login } : {}),
          status: "failed",
          error: result.error,
          repositories: 0,
        });
        continue;
      }
      connections.push({
        id: connection.id,
        login: result.login,
        status: "ok",
        repositories: result.repositories.length,
        ...(result.truncated ? { truncated: true } : {}),
      });
      for (const found of result.repositories) {
        const entry = entryFor(
          `https://github.com/${found.owner}/${found.name}`,
        );
        if (!entry) continue;
        // GitHub's own spelling of the name wins.
        entry.repository = `https://github.com/${found.owner}/${found.name}`;
        entry.fullName = `${found.owner}/${found.name}`;
        entry.private = found.private;
        entry.archived = found.archived;
        if (found.defaultBranch) entry.defaultBranch = found.defaultBranch;
        if (found.description) entry.description = found.description;
        if (found.pushedAt) entry.pushedAt = found.pushedAt;
        if (!entry.connectionIds.includes(connection.id)) {
          entry.connectionIds.push(connection.id);
        }
      }
    }
    for (const settings of options.settings?.list() ?? []) {
      const entry = entryFor(settings.repository);
      if (!entry) continue;
      entry.configured = {
        validation: settings.validation,
        ...(settings.publish
          ? { publishConnectionId: settings.publish.connectionId }
          : {}),
      };
    }
    for (const { projectId, url } of options.projectRepositories?.() ?? []) {
      const entry = entryFor(url);
      if (!entry) continue;
      entry.projectIds = [...(entry.projectIds ?? []), projectId];
    }
    return {
      publisherConfigured: options.publisher !== undefined,
      ...(data ? { fetchedAt: data.at } : {}),
      connections,
      repositories: [...entries.values()].sort(
        (left, right) =>
          (right.pushedAt ?? "").localeCompare(left.pushedAt ?? "") ||
          left.fullName.localeCompare(right.fullName),
      ),
    };
  };

  const reaching = (data: Reached | undefined, key: string): string[] => {
    if (!data) return [];
    return options.connections
      .list()
      .filter((connection) => {
        const result = data.byConnection.get(connection.id);
        return (
          result !== undefined &&
          !("error" in result) &&
          result.repositories.some(
            (found) =>
              `https://github.com/${found.owner}/${found.name}`.toLowerCase() ===
              key,
          )
        );
      })
      .map((connection) => connection.id);
  };

  return {
    async list(listOptions) {
      return build(await load(listOptions?.refresh === true));
    },
    async resolveConnection(repository) {
      const github = parseGitHubRepository(repository);
      if (!github || !options.publisher) return { kind: "none" };
      const key =
        `https://github.com/${github.owner}/${github.name}`.toLowerCase();
      let data = await load(false);
      let ids = reaching(data, key);
      // Perhaps just added to the app's installation: look once more.
      if (ids.length === 0 && data && now() - data.at >= MISS_REFRESH_MS) {
        data = await load(true);
        ids = reaching(data, key);
      }
      if (ids.length === 0) return { kind: "none" };
      if (ids.length === 1) return { kind: "one", connectionId: ids[0]! };
      const owners = ids.filter(
        (id) =>
          options.connections.get(id)?.login?.toLowerCase() ===
          github.owner.toLowerCase(),
      );
      if (owners.length === 1) {
        return { kind: "one", connectionId: owners[0]! };
      }
      return { kind: "ambiguous", connectionIds: ids };
    },
    invalidate() {
      generation += 1;
      reached = undefined;
    },
  };
}
