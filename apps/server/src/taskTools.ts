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

import { HttpError } from "./httpJson.js";
import { modelsByKey } from "./jobRoutes.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import type { RepositorySettingsStore } from "./taskRepositories.js";
import { taskModelError } from "./taskRoutes.js";
import type { TaskRunner } from "./taskRunner.js";
import {
  MAX_TASKS,
  parseTaskRequest,
  type TaskRequest,
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
 *   base branch, model and objective, and exactly that task starts once
 *   approved.
 */

export const TASK_TOOL_NAMES = ["start_task"] as const;
/** Shorter than the API's limit so the approval card shows all of it. */
export const MAX_TOOL_OBJECTIVE_LENGTH = 4_000;
const MAX_LISTED_MODELS = 20;
const MAX_LISTED_TASKS = 20;

export interface TaskToolsOptions {
  readonly store: TaskStore;
  /** The owner's validation commands, shown on the approval card. */
  readonly repositories?: Pick<RepositorySettingsStore, "get">;
  readonly runner: Pick<TaskRunner, "create">;
  readonly models: readonly AssistantServerModelChoice[];
}

export interface TaskTools {
  readonly readTools: HostToolResolver;
  readonly approvalTools: WorkspaceApprovalHostTools;
}

/** Model input never has this key: the schema refuses unknown fields. */
const PREPARED_KEY = "preparedTask";

export function createTaskTools(options: TaskToolsOptions): TaskTools {
  const { store, runner } = options;
  const models = modelsByKey(options.models);

  const explain = (code: string): string => {
    switch (code) {
      case "repository_required":
      case "repository_url_invalid":
        return "repository must be an https:// clone URL with no credentials, for example https://github.com/owner/name (private repositories need a GitHub connection set for them in the GitHub panel)";
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

  const prepare = (
    input: Readonly<Record<string, unknown>>,
  ): WorkspaceHostToolApproval => {
    try {
      if (
        typeof input.objective === "string" &&
        input.objective.length > MAX_TOOL_OBJECTIVE_LENGTH
      ) {
        throw new HttpError(400, "objective_too_long");
      }
      const request = parseTaskRequest({ ...input });
      check(request);
      const validation =
        options.repositories?.get(request.repository)?.validation ?? [];
      const display: TaskStartDisplay = {
        kind: TASK_START_DISPLAY_KIND,
        action: "create",
        text: [
          "Start a coding task in its own fresh clone:",
          "",
          `Repository: ${request.repository}`,
          `Starts from: ${request.baseBranch ?? "the default branch"}`,
          `Model: ${request.model ?? "the server's default"}`,
          "It works on a new agentlink/ branch and commits there, without asking before each edit or command. Nothing is pushed.",
          validation.length > 0
            ? `Then the server runs: ${validation.join(" && ")}`
            : "No validation commands are set for this repository.",
          "Then a model from another provider reviews the commit; it may be sent back to fix findings twice.",
          "Objective:",
          request.objective,
        ].join("\n"),
      };
      return {
        decision: "require_user",
        summary: `Start a coding task in ${request.repository}?`,
        displayContent: display,
        preparedInput: { [PREPARED_KEY]: request },
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
      "Start a coding task: the server makes a fresh clone of a repository (public, or private with a GitHub connection set for it) on a new agentlink/ branch and runs a separate chat there that implements the objective and commits it. The owner always approves the exact task first, so propose it directly rather than asking. Write the objective as a complete, self-contained instruction: that chat does not see this conversation. Use list_tasks to follow its progress.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: {
          type: "string",
          description:
            "https:// clone URL with no credentials, for example https://github.com/owner/name",
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
      const task = await runner.create(request);
      return {
        modelContent: [
          `Started coding task ${task.id} on branch ${task.branch}.`,
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
        return typeof request === "string"
          ? { ok: false, reason: request }
          : { ok: true };
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

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
