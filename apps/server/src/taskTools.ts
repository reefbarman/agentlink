import {
  defineTool,
  type HostTool,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";
import type {
  WorkspaceApprovalHostTools,
  WorkspaceHostToolApproval,
} from "@agentlink/workspace-host";

import type { GitHubConnectionStore } from "./githubConnections.js";
import type { RepositoryDirectory } from "./githubRepositories.js";
import { HttpError } from "./httpJson.js";
import { modelsByKey } from "./jobRoutes.js";
import { CONNECTION_ID_PATTERN } from "./publisherVault.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import {
  parseValidationCommands,
  type RepositorySettingsStore,
} from "./taskRepositories.js";
import { taskModelError } from "./taskRoutes.js";
import type { TaskRunner } from "./taskRunner.js";
import { GITHUB_APP_INSTALLATIONS_URL } from "./repositoryTools.js";
import {
  MAX_TASKS,
  parseTaskRequest,
  type TaskRequest,
  type TaskRun,
  type TaskStore,
} from "./taskStore.js";
import {
  TASK_START_DISPLAY_KIND,
  type TaskStartDisplay,
} from "./taskStartDisplay.js";

/**
 * Chat tools for coding tasks:
 *
 * - `list_tasks` reads the tasks, with no approval.
 * - `start_task` starts one. It always stops for the owner's approval,
 *   whatever the chat's approval mode: the card shows the exact repository,
 *   base branch, model, checks, publishing and objective, and exactly that
 *   task starts once approved. For a repository not set up yet, the card
 *   also carries its setup: the checks the chat proposed, and standing
 *   permission to publish with the one GitHub account that reaches it.
 *   Approving saves them, unless the owner set them meanwhile.
 */

export const TASK_TOOL_NAMES = ["start_task"] as const;
/** Shorter than the API's limit so the approval card shows all of it. */
export const MAX_TOOL_OBJECTIVE_LENGTH = 4_000;
const MAX_LISTED_MODELS = 20;
const MAX_LISTED_TASKS = 20;

export interface TaskToolsOptions {
  readonly store: TaskStore;
  /** The owner's settings per repository: shown on the card, saved on it. */
  readonly repositories?: Pick<
    RepositorySettingsStore,
    "get" | "set" | "setPublish"
  >;
  /** Which connection reaches a repository, to offer publishing with it. */
  readonly directory?: Pick<RepositoryDirectory, "resolveConnection">;
  readonly connections?: Pick<GitHubConnectionStore, "get">;
  readonly runner: Pick<TaskRunner, "create">;
  readonly models: readonly AssistantServerModelChoice[];
  readonly now?: () => number;
}

/** What approving the card also saves for the repository. */
interface TaskSetup {
  /** Checks for a repository that had none. */
  readonly validation?: readonly string[];
  /** Standing permission to publish, for a repository that had none. */
  readonly publishConnectionId?: string;
}

export interface TaskTools {
  readonly readTools: HostToolResolver;
  readonly approvalTools: WorkspaceApprovalHostTools;
}

/** Model input never has these keys: the schema refuses unknown fields. */
const PREPARED_KEY = "preparedTask";
const SETUP_KEY = "preparedSetup";

export function createTaskTools(options: TaskToolsOptions): TaskTools {
  const { store, runner } = options;
  const models = modelsByKey(options.models);
  const now = options.now ?? Date.now;
  const accountName = (connectionId: string) => {
    const connection = options.connections?.get(connectionId);
    return connection?.login ? `@${connection.login}` : "your GitHub account";
  };

  const explain = (code: string): string => {
    switch (code) {
      case "repository_required":
      case "repository_url_invalid":
        return "repository must be an https:// clone URL with no credentials, for example https://github.com/owner/name; use list_repositories to find the owner's repositories, private ones included";
      case "objective_required":
        return "objective must describe what the task should achieve";
      case "objective_too_long":
        return `objective must be at most ${MAX_TOOL_OBJECTIVE_LENGTH} characters`;
      case "base_branch_invalid":
        return "baseBranch must be a plain branch name, for example main or release/1.2";
      case "model_invalid":
      case "model_not_available":
        return `model must be one of: ${[...models.keys()].slice(0, MAX_LISTED_MODELS).join(", ")}; omit it for the server's default`;
      case "task_field_unknown":
        return "unknown field";
      case "validation_invalid":
      case "validation_command_invalid":
      case "too_many_validation_commands":
        return "validation must be at most 10 shell commands, each one line of at most 1,000 characters";
      case "task_limit_reached":
        return `there are already ${MAX_TASKS} tasks; the owner must delete some first`;
      default:
        return code;
    }
  };

  const check = (request: TaskRequest) => {
    const modelError = taskModelError(request.model, models);
    if (modelError) throw new HttpError(400, modelError);
    if (store.list().length >= MAX_TASKS) {
      throw new HttpError(409, "task_limit_reached");
    }
  };

  /** How the task will publish, and whether the card grants it. */
  const publishPlan = async (
    repository: string,
  ): Promise<{ line: string; grant?: string }> => {
    const settings = options.repositories?.get(repository);
    if (settings?.publish) {
      return {
        line: `When it passes review, it opens a draft pull request as ${accountName(settings.publish.connectionId)}.`,
      };
    }
    const resolved =
      options.directory && options.repositories
        ? await options.directory.resolveConnection(repository).catch(() => ({
            kind: "none" as const,
          }))
        : { kind: "none" as const };
    if (resolved.kind === "one") {
      return {
        line: `When it passes review, it opens a draft pull request as ${accountName(resolved.connectionId)}, and may do so for future tasks on this repository too.`,
        grant: resolved.connectionId,
      };
    }
    return {
      line:
        resolved.kind === "ambiguous"
          ? `Nothing is pushed: several GitHub accounts reach this repository (${resolved.connectionIds.map(accountName).join(", ")}). Choose one under GitHub to publish its tasks.`
          : "Nothing is pushed: none of your GitHub accounts can publish to this repository. The finished work stays ready under Tasks.",
    };
  };

  const prepare = async (
    input: Readonly<Record<string, unknown>>,
  ): Promise<WorkspaceHostToolApproval> => {
    try {
      if (
        typeof input.objective === "string" &&
        input.objective.length > MAX_TOOL_OBJECTIVE_LENGTH
      ) {
        throw new HttpError(400, "objective_too_long");
      }
      const { validation: proposedInput, ...rest } = input;
      const request = parseTaskRequest({ ...rest });
      check(request);
      const proposed =
        proposedInput === undefined
          ? []
          : parseValidationCommands(proposedInput);
      const saved =
        options.repositories?.get(request.repository)?.validation ?? [];
      // The owner's checks win; a proposal only fills a repository with none.
      const saveValidation =
        saved.length === 0 && proposed.length > 0 && options.repositories
          ? proposed
          : undefined;
      const checks = saved.length > 0 ? saved : (saveValidation ?? []);
      const publish = await publishPlan(request.repository);
      const setup: TaskSetup = {
        ...(saveValidation ? { validation: saveValidation } : {}),
        ...(publish.grant ? { publishConnectionId: publish.grant } : {}),
      };
      const display: TaskStartDisplay = {
        kind: TASK_START_DISPLAY_KIND,
        action: "create",
        text: [
          "Start a coding task in its own fresh clone:",
          "",
          `Repository: ${request.repository}`,
          `Starts from: ${request.baseBranch ?? "the default branch"}`,
          `Model: ${request.model ?? "the server's default"}`,
          "It works on a new agentlink/ branch and commits there, without asking before each edit or command.",
          checks.length > 0
            ? `Checks the server runs on its commit: ${checks.join(" && ")}${saveValidation ? " (saved for future tasks on this repository)" : ""}`
            : "No checks: review only.",
          "Then a model from another provider reviews the commit; it may be sent back to fix findings twice.",
          publish.line,
          "Objective:",
          request.objective,
        ].join("\n"),
      };
      const setsUp = saveValidation || publish.grant;
      return {
        decision: "require_user",
        summary: setsUp
          ? `Start a coding task in ${request.repository}, and save its setup?`
          : `Start a coding task in ${request.repository}?`,
        displayContent: display,
        preparedInput: { [PREPARED_KEY]: request, [SETUP_KEY]: setup },
      };
    } catch (error) {
      if (error instanceof HttpError) {
        return { decision: "deny", reason: explain(error.code) };
      }
      throw error;
    }
  };

  /** The approved request, checked again now that it is about to start. */
  const approvedRequest = (
    input: Readonly<Record<string, unknown>>,
  ): TaskRequest | string => {
    const prepared = input[PREPARED_KEY];
    if (!prepared || typeof prepared !== "object") {
      return "This task was not approved by the owner";
    }
    try {
      const request = parseTaskRequest({
        ...(prepared as Record<string, unknown>),
      });
      check(request);
      return request;
    } catch (error) {
      if (error instanceof HttpError) return explain(error.code);
      throw error;
    }
  };

  /** The setup the card showed; nothing when it carried none. */
  const approvedSetup = (
    input: Readonly<Record<string, unknown>>,
  ): TaskSetup => {
    const raw = input[SETUP_KEY];
    if (!raw || typeof raw !== "object") return {};
    const { validation, publishConnectionId } = raw as Record<string, unknown>;
    return {
      ...(validation !== undefined
        ? { validation: parseValidationCommands(validation) }
        : {}),
      ...(typeof publishConnectionId === "string" &&
      CONNECTION_ID_PATTERN.test(publishConnectionId)
        ? { publishConnectionId }
        : {}),
    };
  };

  /**
   * Save what the card set up, except what the owner changed meanwhile.
   * Returns notes for the chat about anything not saved.
   */
  const applySetup = async (
    repository: string,
    setup: TaskSetup,
  ): Promise<string[]> => {
    const repositories = options.repositories;
    if (!repositories) return [];
    const notes: string[] = [];
    if (setup.validation?.length) {
      const current = repositories.get(repository)?.validation ?? [];
      if (current.length === 0) {
        await repositories.set(repository, setup.validation, now());
      } else if (current.join("\n") !== setup.validation.join("\n")) {
        notes.push(
          `The owner set other checks for this repository meanwhile; theirs apply: ${current.join(" && ")}`,
        );
      }
    }
    if (setup.publishConnectionId) {
      const current = repositories.get(repository)?.publish;
      if (!options.connections?.get(setup.publishConnectionId)) {
        notes.push(
          "The GitHub account the card named was removed meanwhile, so publishing was not allowed.",
        );
      } else if (!current) {
        await repositories.setPublish(
          repository,
          setup.publishConnectionId,
          now(),
        );
      } else if (current.connectionId !== setup.publishConnectionId) {
        notes.push(
          `The owner chose ${accountName(current.connectionId)} to publish this repository meanwhile; that applies.`,
        );
      }
    }
    return notes;
  };

  const listTasks = defineTool({
    name: "list_tasks",
    description:
      "List the owner's coding tasks, newest first: id, state, repository, branch, objective, and the latest commit or error.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    effect: "read",
    parallelSafe: true,
    presentation: { title: "List coding tasks" },
    handler: async () => {
      const tasks = store.list().slice(0, MAX_LISTED_TASKS);
      if (tasks.length === 0) {
        return { modelContent: "There are no coding tasks." };
      }
      return {
        modelContent: tasks
          .map((task) =>
            [
              `- ${task.id}: ${task.state}${task.error ? ` (${task.error})` : ""}`,
              ...(taskProblemHint(task)
                ? [`  What to tell the owner: ${taskProblemHint(task)}`]
                : []),
              `  Repository: ${task.repository} → ${task.branch}`,
              `  Objective: ${oneLine(task.objective, 300)}`,
              ...(task.commits?.length
                ? [
                    `  Commits: ${task.commits.length}, latest ${task.headCommit?.slice(0, 12) ?? "?"}`,
                  ]
                : []),
              ...(task.summary
                ? [`  Summary: ${oneLine(task.summary, 300)}`]
                : []),
            ].join("\n"),
          )
          .join("\n"),
        displayContent: { tasks: tasks.length },
      };
    },
  });

  const startTask = defineTool({
    name: "start_task",
    description:
      "Start a coding task: the server makes a fresh clone of a repository (public, or private when one of the owner's GitHub connections can reach it; find its URL with list_repositories rather than asking) on a new agentlink/ branch and runs a separate chat there that implements the objective and commits it. The owner always approves the exact task first, so propose it directly rather than asking. Write the objective as a complete, self-contained instruction: that chat does not see this conversation. Use list_tasks to follow its progress.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: {
          type: "string",
          description:
            "https:// clone URL with no credentials, for example https://github.com/owner/name",
        },
        validation: {
          type: "array",
          maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 1_000 },
          description:
            'Checks to propose for a repository that has none yet (list_repositories shows a repository\'s checks): shell commands the server runs in order on the task\'s commit, all of which must pass, for example ["npm ci", "npm test"]. Read the repository with read_repository first and take them from its package.json scripts, Makefile or CI workflow. The owner approves them on the card and they are saved for future tasks. Ignored when the repository already has checks; omit when there is nothing sensible to run.',
        },
        objective: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TOOL_OBJECTIVE_LENGTH,
          description: "What the task must achieve, in full",
        },
        baseBranch: {
          type: "string",
          description: "Branch to start from; omit for the default branch",
        },
        model: {
          type: "string",
          description: '"providerId/modelId"; omit for the server\'s default',
        },
      },
      required: ["repository", "objective"],
    },
    effect: "write",
    authorization: "required",
    presentation: { title: "Start a coding task" },
    handler: async (input): Promise<HostToolResult> => {
      const request = approvedRequest(input);
      if (typeof request === "string") {
        return { modelContent: `Not started: ${request}`, isError: true };
      }
      let notes: string[];
      try {
        notes = await applySetup(request.repository, approvedSetup(input));
      } catch (error) {
        if (error instanceof HttpError) {
          return {
            modelContent: `Not started: ${explain(error.code)}`,
            isError: true,
          };
        }
        throw error;
      }
      const task = await runner.create(request);
      return {
        modelContent: [
          `Started coding task ${task.id} on branch ${task.branch}.`,
          ...notes,
          "It runs in its own chat; call list_tasks to see its state. The owner sees it under Tasks.",
        ].join("\n"),
        displayContent: { taskId: task.id, branch: task.branch },
      };
    },
  });

  const approvalTools: HostTool[] = [startTask];
  return {
    readTools: () => [listTasks],
    approvalTools: {
      toolNames: TASK_TOOL_NAMES,
      resolveTools: () => approvalTools,
      prepare: (request) => prepare(request.input),
      validatePending: ({ input }) => {
        const request = approvedRequest(input);
        if (typeof request === "string") return { ok: false, reason: request };
        try {
          approvedSetup(input);
        } catch {
          return { ok: false, reason: "The task's setup is not valid" };
        }
        return { ok: true };
      },
    },
  };
}

/**
 * One set of approval tools from several: each call goes to the set that
 * offers that tool.
 */
export function combineApprovalHostTools(
  sets: readonly WorkspaceApprovalHostTools[],
): WorkspaceApprovalHostTools {
  const owner = (toolName: string) => {
    const set = sets.find((candidate) =>
      candidate.toolNames.includes(toolName),
    );
    if (!set) throw new Error(`No approval tool named ${toolName}`);
    return set;
  };
  return {
    toolNames: sets.flatMap((set) => set.toolNames),
    resolveTools: async (request) =>
      (await Promise.all(sets.map((set) => set.resolveTools(request)))).flat(),
    prepare: (request) => owner(request.toolName).prepare(request),
    validatePending: (request) =>
      owner(request.toolName).validatePending?.(request) ?? { ok: true },
  };
}

/**
 * What the owner should do about a task's problem, in plain words, for the
 * errors they can fix themselves.
 */
export function taskProblemHint(
  task: Pick<TaskRun, "error" | "connectionId" | "state">,
): string | undefined {
  switch (task.error) {
    case "clone_failed":
      return task.connectionId
        ? "The repository could not be cloned with its GitHub connection; check the branch exists and the connection can still reach it."
        : `The repository could not be cloned. If it is private, the AgentLink Assistant GitHub App is not installed on it: add it at ${GITHUB_APP_INSTALLATIONS_URL}, then resume the task.`;
    case "fetch_failed":
    case "default_branch_unknown":
      return `GitHub would not let the connection fetch the repository. The AgentLink Assistant app may no longer be installed on it: check ${GITHUB_APP_INSTALLATIONS_URL}, then resume the task.`;
    case "connection_signed_out":
    case "connection_missing":
      return "The GitHub connection is signed out: the owner must sign it in again in the Assistant's GitHub panel, then resume the task.";
    case "publish_permission_missing":
      return "It is ready but was not published: the repository has no GitHub account chosen to publish with. The owner can choose one in the GitHub panel, then publish it from Tasks.";
    default:
      if (task.state === "blocked_auth") {
        return "A model provider's sign-in has expired: the owner must sign in again, then resume the task.";
      }
      if (task.state === "blocked_quota") {
        return "A model provider's usage limit was reached: resume the task once it resets.";
      }
      return undefined;
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
