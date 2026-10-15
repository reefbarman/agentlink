import { defineTool, type HostToolResolver } from "@agentlink/core";

import type { GitHubConnectionStore } from "./githubConnections.js";
import type {
  DirectoryConnection,
  DirectoryRepository,
  RepositoryDirectory,
} from "./githubRepositories.js";

/**
 * `list_repositories`: the chat's way to find the owner's repositories,
 * public and private, without asking for a URL. It reads the repository
 * directory (what each GitHub connection can reach, through the publisher,
 * plus configured and project repositories). No approval: it returns names
 * and metadata only, never a token or file contents.
 */

/** Where the owner adds repositories to the GitHub App. */
export const GITHUB_APP_INSTALLATIONS_URL =
  "https://github.com/settings/installations";
const MAX_RESULTS = 30;
const MAX_QUERY_LENGTH = 200;

/** Repositories matching the query's words, best first. */
export function searchRepositories(
  repositories: readonly DirectoryRepository[],
  query: string | undefined,
): DirectoryRepository[] {
  const words = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 2);
  if (words.length === 0) return [...repositories];
  const scored = repositories.flatMap((entry) => {
    const [owner = "", name = ""] = entry.fullName.toLowerCase().split("/");
    const description = entry.description?.toLowerCase() ?? "";
    let score = 0;
    for (const word of words) {
      if (name === word) score += 6;
      else if (name.includes(word)) score += 3;
      if (owner.includes(word)) score += 2;
      if (description.includes(word)) score += 1;
    }
    return score > 0 ? [{ entry, score }] : [];
  });
  // Stable: equal scores keep the directory's order (most recently pushed).
  return scored
    .sort((left, right) => right.score - left.score)
    .map(({ entry }) => entry);
}

/** A connection problem in the owner's words. */
export function describeConnectionProblem(
  connection: DirectoryConnection,
): string {
  const who = connection.login ?? "a GitHub";
  switch (connection.error) {
    case "connection_signed_out":
      return `The ${who} connection is signed out: the owner must sign it in again in the Assistant's GitHub panel.`;
    case "connection_missing":
      return `The ${who} connection lost its sign-in: the owner must connect it again in the GitHub panel.`;
    case "publisher_unavailable":
      return `The ${who} connection could not be checked: the publisher is not reachable right now.`;
    default:
      return `GitHub would not list the ${who} connection's repositories (${connection.error ?? "unknown error"}).`;
  }
}

export function createRepositoryTools(options: {
  readonly directory: RepositoryDirectory;
  readonly connections: Pick<GitHubConnectionStore, "get">;
}): HostToolResolver {
  const login = (id: string) => options.connections.get(id)?.login ?? id;

  const describeEntry = (entry: DirectoryRepository): string => {
    const facts = [
      entry.private === undefined
        ? undefined
        : entry.private
          ? "private"
          : "public",
      entry.archived ? "archived" : undefined,
      entry.defaultBranch ? `default branch ${entry.defaultBranch}` : undefined,
      entry.connectionIds.length > 0
        ? `reachable by ${entry.connectionIds.map(login).join(", ")}`
        : undefined,
      entry.configured?.validation.length
        ? `checks: ${entry.configured.validation.join(" && ")}`
        : undefined,
      entry.configured?.publishConnectionId
        ? `publishes draft PRs as ${login(entry.configured.publishConnectionId)}`
        : undefined,
      entry.projectIds?.length
        ? `cloned in project ${entry.projectIds.join(", ")}`
        : undefined,
    ].filter(Boolean);
    return [
      `- ${entry.fullName}: ${entry.repository}${facts.length ? ` (${facts.join("; ")})` : ""}`,
      ...(entry.description ? [`  ${entry.description}`] : []),
    ].join("\n");
  };

  const listRepositories = defineTool({
    name: "list_repositories",
    description:
      'Find the owner\'s repositories, public and private: every repository their GitHub connections can reach (the AgentLink Assistant GitHub App\'s installations), plus repositories configured for tasks and ones cloned into projects. Use it before asking the owner for a repository URL, and before start_task. Returns names, URLs, visibility, default branch and description; never file contents. Pass words from the request as query (for example "website" or "agentlink"); omit it to list the most recently pushed. If a query finds nothing, list without one and choose by name and description (a website may be named after its domain). Set refresh when a repository the owner just added is missing.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          maxLength: MAX_QUERY_LENGTH,
          description:
            "Words to match against owner, name and description; omit for all",
        },
        refresh: {
          type: "boolean",
          description:
            "Ask GitHub again instead of using the list from the last five minutes",
        },
      },
    },
    effect: "read",
    parallelSafe: true,
    presentation: { title: "Find repositories" },
    handler: async (input) => {
      const query =
        typeof input.query === "string"
          ? input.query.slice(0, MAX_QUERY_LENGTH)
          : undefined;
      const listed = await options.directory.list({
        refresh: input.refresh === true,
      });
      const problems = listed.connections
        .filter((connection) => connection.status === "failed")
        .map(describeConnectionProblem);
      const truncated = listed.connections
        .filter((connection) => connection.truncated)
        .map(
          (connection) =>
            `The ${connection.login ?? connection.id} connection reaches more repositories than are listed.`,
        );
      const notes: string[] = [];
      if (!listed.publisherConfigured) {
        notes.push(
          "GitHub is not set up on this server (no publisher), so only public repositories and ones configured by hand are known. Public repositories can still be used by URL.",
        );
      } else if (listed.connections.length === 0) {
        notes.push(
          "No GitHub account is connected. The owner can connect one in the Assistant's GitHub panel; until then only public repositories can be used, by URL.",
        );
      }
      notes.push(...problems, ...truncated);

      const matches = searchRepositories(listed.repositories, query);
      const shown = matches.slice(0, MAX_RESULTS);
      const lines: string[] = [];
      if (shown.length === 0) {
        lines.push(
          query
            ? `No repository matched "${query}".`
            : "No repositories are known.",
          `If it is one of the owner's, the AgentLink Assistant GitHub App is probably not installed on it: they can add it at ${GITHUB_APP_INSTALLATIONS_URL} (or in their organisation's settings), then ask again (call this with refresh true). A public repository can also be used directly by its https://github.com/owner/name URL.`,
        );
      } else {
        lines.push(
          `${matches.length} repositor${matches.length === 1 ? "y" : "ies"}${query ? ` matching "${query}"` : ""}${matches.length > shown.length ? `, showing the first ${shown.length}` : ""}:`,
          ...shown.map(describeEntry),
        );
      }
      return {
        modelContent: [...lines, ...(notes.length ? ["", ...notes] : [])].join(
          "\n",
        ),
        displayContent: { repositories: shown.length },
      };
    },
  });

  return () => [listRepositories];
}

/**
 * Guidance for the chat on how to handle requests, so the owner never has
 * to name modes, projects or URLs it can work out itself.
 */
export function assistantRoutingInstructions(capabilities: {
  readonly tasks: boolean;
  readonly repositories: boolean;
}): string {
  return [
    "How to handle the owner's requests: do what they ask and work out how yourself. Never ask them to choose a mode, a project or a setting you can look up, and never answer in terms of internal states or error codes.",
    "- Questions, research and writing: answer in this chat, using web tools when needed.",
    ...(capabilities.tasks
      ? [
          "- A change to code or content in a repository (fix, update, add, refactor, open a PR): propose it with start_task. It runs in its own fresh clone from any chat, so never ask the owner to switch project first. Write the objective as a complete instruction, because the task's chat does not see this one. The owner approves the card; follow progress with list_tasks.",
        ]
      : []),
    ...(capabilities.repositories
      ? [
          '- To find a repository, call list_repositories with words from the request (for example "website") instead of asking for a URL or guessing from github.com pages. It covers the owner\'s private repositories too. Ask only when several plausible repositories match, and then name them.',
          `- If a repository cannot be found or reached, tell the owner the fix in one plain sentence, for example: "The AgentLink Assistant app isn't installed on that repository yet. Add it at ${GITHUB_APP_INSTALLATIONS_URL}, then ask me again."`,
        ]
      : []),
    "- Anything that should happen on a schedule or repeatedly: propose it with schedule_job.",
  ].join("\n");
}
