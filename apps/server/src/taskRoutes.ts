import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import { modelsByKey } from "./jobRoutes.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import {
  parseValidationCommands,
  type RepositorySettingsStore,
} from "./taskRepositories.js";
import type { TaskRunner } from "./taskRunner.js";
import {
  TASK_ID_PATTERN,
  evidenceFor,
  parseTaskRequest,
  type TaskRun,
  type TaskStore,
} from "./taskStore.js";

/**
 * Owner-only coding task API:
 *
 * - `GET /api/tasks`, `POST /api/tasks` (`{ repository, baseBranch?,
 *   objective, model? }`)
 * - `GET /api/tasks/:id` (record and state history), `DELETE` (also removes
 *   its clone)
 * - `POST /api/tasks/:id/stop`, `POST /api/tasks/:id/resume`
 * - `GET /api/tasks/repositories`, `PUT /api/tasks/repositories`
 *   (`{ repository, validation }`): each repository's validation commands
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks; mutations re-check the sign-in before they apply.
 */

const MAX_TASK_BODY_BYTES = 64 * 1024;
const TASK_ROUTE = /^\/api\/tasks\/([^/]+)(?:\/(stop|resume))?$/u;
const REPOSITORY_FIELDS = new Set(["repository", "validation"]);

export interface TaskRoutesOptions {
  readonly store: TaskStore;
  readonly repositories: RepositorySettingsStore;
  /** Undefined when the server has no `projectsRoot` for clones. */
  readonly runner: TaskRunner | undefined;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly models: readonly AssistantServerModelChoice[];
  readonly now?: () => number;
}

/**
 * A task with the evidence that still applies: the latest of each kind
 * recorded for its head commit. Evidence for older commits is stale.
 */
export function describeTask(task: TaskRun) {
  return { ...task, current: evidenceFor(task, task.headCommit) };
}

export interface TaskRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

/** Why a task request cannot run here, as an error code. */
export function taskModelError(
  model: string | undefined,
  models: ReadonlyMap<string, AssistantServerModelChoice>,
): "model_not_available" | undefined {
  return model !== undefined && !models.has(model)
    ? "model_not_available"
    : undefined;
}

export function createTaskRoutes(options: TaskRoutesOptions): TaskRoutes {
  const { store, repositories } = options;
  const now = options.now ?? Date.now;
  const models = modelsByKey(options.models);

  const requireRunner = () => {
    if (!options.runner) throw new HttpError(409, "tasks_disabled");
    return options.runner;
  };
  const requireValid = async (auth: AssistantServerAuth) => {
    if (!(await auth.revalidate()).valid) {
      throw new HttpError(401, "authentication_required");
    }
  };
  const requireTask = (taskId: string) => {
    const task = TASK_ID_PATTERN.test(taskId) ? store.get(taskId) : undefined;
    if (!task) throw new HttpError(404, "task_not_found");
    return task;
  };

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    pathname: string,
    method: string,
  ): Promise<boolean> => {
    if (pathname === "/api/tasks/repositories") {
      if (method === "GET") {
        sendJson(response, 200, { repositories: repositories.list() });
        return true;
      }
      if (method !== "PUT") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(
        request,
        MAX_TASK_BODY_BYTES,
        auth.signal,
      );
      if (Object.keys(body).some((key) => !REPOSITORY_FIELDS.has(key))) {
        throw new HttpError(400, "repository_field_unknown");
      }
      if (typeof body.repository !== "string") {
        throw new HttpError(400, "repository_required");
      }
      const validation = parseValidationCommands(body.validation);
      await requireValid(auth);
      const saved = await repositories.set(body.repository, validation, now());
      sendJson(response, 200, { repository: saved ?? null });
      return true;
    }

    if (pathname === "/api/tasks") {
      if (method === "GET") {
        sendJson(response, 200, {
          tasks: store.list().map(describeTask),
          enabled: options.runner !== undefined,
        });
        return true;
      }
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const runner = requireRunner();
      const body = await readJsonBody(
        request,
        MAX_TASK_BODY_BYTES,
        auth.signal,
      );
      const taskRequest = parseTaskRequest(body);
      const modelError = taskModelError(taskRequest.model, models);
      if (modelError) throw new HttpError(400, modelError);
      await requireValid(auth);
      sendJson(response, 202, { task: await runner.create(taskRequest) });
      return true;
    }

    const match = TASK_ROUTE.exec(pathname);
    if (!match) return false;
    const taskId = decodeURIComponent(match[1]!);
    const action = match[2];
    if (action) {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      requireTask(taskId);
      const runner = requireRunner();
      await requireValid(auth);
      if (action === "stop") {
        sendJson(response, 200, { task: await runner.stop(taskId) });
      } else {
        sendJson(response, 202, { task: await runner.resume(taskId) });
      }
      return true;
    }
    if (method === "GET") {
      const task = requireTask(taskId);
      sendJson(response, 200, {
        task: describeTask(task),
        events: store.events(taskId),
        validation: repositories.get(task.repository)?.validation ?? [],
      });
      return true;
    }
    if (method === "DELETE") {
      requireTask(taskId);
      const runner = requireRunner();
      await requireValid(auth);
      await runner.delete(taskId);
      sendJson(response, 200, { ok: true });
      return true;
    }
    throw new HttpError(405, "method_not_allowed");
  };

  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== "/api/tasks" &&
        !url.pathname.startsWith("/api/tasks/")
      ) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "tasks_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      return route(request, response, auth, url.pathname, method);
    },
  };
}
