import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import type { CheckpointStatus } from "./auditCheckpoint.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import { modelsByKey } from "./jobRoutes.js";
import { singleHeader } from "./requestGuard.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";
import type { GitHubConnectionStore } from "./githubConnections.js";
import { parseGitHubRepository } from "./githubApi.js";
import type {
  TaskAudit,
  TaskAuditAction,
  TaskAuditActor,
} from "./taskAudit.js";
import {
  parseValidationCommands,
  type RepositorySettingsStore,
} from "./taskRepositories.js";
import type { TaskEditors } from "./taskEditors.js";
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
 * - `GET /api/tasks/:id/audit`: the task's audit entries (kept after it is
 *   deleted), whether the whole log's hash chain is intact, and the audit
 *   checkpoints' status (last checkpoint, and whether the log still matches
 *   the checkpoints in the backup store)
 * - `POST /api/tasks/:id/stop`, `POST /api/tasks/:id/resume`
 * - `POST /api/tasks/:id/editor` (`{ action: "open" | "take_over" |
 *   "hand_back" }`): open the task's folder in the browser editor
 *   (read-only, or writable while the owner has taken it over), take it
 *   over (stops the task, which becomes `editing`), or hand it back (stops
 *   the editor and continues the task). `open` and `take_over` return the
 *   one-time `url` to open on the editor origin.
 * - `POST /api/tasks/:id/publish` (`{ allowUnreviewed? }`): push a ready
 *   task and open its draft pull request, within the repository's
 *   standing permission
 * - `GET /api/tasks/repositories`, `PUT /api/tasks/repositories`
 *   (`{ repository, validation?, connectionId? }`): each repository's
 *   validation commands, and the GitHub connection its tasks publish with
 *   (`null` revokes the permission)
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks; mutations re-check the sign-in before they apply.
 */

const MAX_TASK_BODY_BYTES = 64 * 1024;
const TASK_ROUTE =
  /^\/api\/tasks\/([^/]+)(?:\/(stop|resume|publish|audit|editor))?$/u;
const EDITOR_ACTIONS = new Set(["open", "take_over", "hand_back"]);
const REPOSITORY_FIELDS = new Set(["repository", "validation", "connectionId"]);
const PUBLISH_FIELDS = new Set(["allowUnreviewed"]);

export interface TaskRoutesOptions {
  readonly store: TaskStore;
  readonly repositories: RepositorySettingsStore;
  /** Connections a repository's permission may name. */
  readonly connections?: Pick<GitHubConnectionStore, "get">;
  /** Undefined when the server has no `projectsRoot` for clones. */
  readonly runner: TaskRunner | undefined;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  /** The audit log: read for `/audit`, told who asked for each action. */
  readonly audit?: Pick<TaskAudit, "entries" | "request" | "verify">;
  /** The audit checkpoints' status, when they are running. */
  readonly checkpoints?: () => CheckpointStatus | undefined;
  readonly models: readonly AssistantServerModelChoice[];
  /** Browser editors for task folders, when configured. */
  readonly editors?: TaskEditorRoutes;
  readonly now?: () => number;
}

export interface TaskEditorRoutes {
  /** The editor listener's port, on the host the app is using. */
  readonly port: number;
  readonly editors: Pick<TaskEditors, "open" | "stop" | "running">;
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
  /** Who asked: the owner, on this device. */
  const owner = (auth: AssistantServerAuth): TaskAuditActor => ({
    kind: "owner",
    device: auth.session.deviceLabel,
  });
  const requested = async (
    taskId: string,
    action: TaskAuditAction,
    auth: AssistantServerAuth,
    detail?: Record<string, unknown>,
  ) => {
    await options.audit
      ?.request(taskId, action, owner(auth), now(), detail)
      .catch(() => undefined);
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
      if (body.validation === undefined && body.connectionId === undefined) {
        throw new HttpError(400, "repository_change_required");
      }
      const validation =
        body.validation === undefined
          ? undefined
          : parseValidationCommands(body.validation);
      let connectionId: string | null | undefined;
      if (body.connectionId !== undefined) {
        if (body.connectionId === null) {
          connectionId = null;
        } else if (
          typeof body.connectionId !== "string" ||
          !options.connections?.get(body.connectionId)
        ) {
          throw new HttpError(400, "connection_not_found");
        } else if (!parseGitHubRepository(body.repository)) {
          // Only github.com repositories can be published.
          throw new HttpError(400, "repository_not_github");
        } else {
          connectionId = body.connectionId;
        }
      }
      await requireValid(auth);
      let saved = repositories.get(body.repository);
      if (validation !== undefined) {
        saved = await repositories.set(body.repository, validation, now());
      }
      if (connectionId !== undefined) {
        saved = await repositories.setPublish(
          body.repository,
          connectionId ?? undefined,
          now(),
        );
      }
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
      const created = await runner.create(taskRequest);
      await requested(created.id, "create", auth);
      sendJson(response, 202, { task: created });
      return true;
    }

    const match = TASK_ROUTE.exec(pathname);
    if (!match) return false;
    const taskId = decodeURIComponent(match[1]!);
    const action = match[2];
    if (action === "audit") {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      if (!TASK_ID_PATTERN.test(taskId) || !options.audit) {
        throw new HttpError(404, "task_not_found");
      }
      const entries = options.audit.entries(taskId);
      if (entries.length === 0 && !store.get(taskId)) {
        throw new HttpError(404, "task_not_found");
      }
      const checkpoints = options.checkpoints?.();
      sendJson(response, 200, {
        entries,
        verification: await options.audit.verify(),
        ...(checkpoints ? { checkpoints } : {}),
      });
      return true;
    }
    if (action) {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      requireTask(taskId);
      const runner = requireRunner();
      if (action === "editor") {
        const editors = options.editors;
        if (!editors) throw new HttpError(409, "editors_not_configured");
        const body = await readJsonBody(
          request,
          MAX_TASK_BODY_BYTES,
          auth.signal,
        );
        const editorAction = body.action;
        if (
          typeof editorAction !== "string" ||
          !EDITOR_ACTIONS.has(editorAction) ||
          Object.keys(body).some((key) => key !== "action")
        ) {
          throw new HttpError(400, "editor_action_invalid");
        }
        await requireValid(auth);
        if (editorAction === "hand_back") {
          await requested(taskId, "hand_back", auth);
          await editors.editors.stop(taskId);
          sendJson(response, 202, {
            task: describeTask(await runner.handBack(taskId)),
          });
          return true;
        }
        let task = requireTask(taskId);
        if (editorAction === "take_over") {
          await requested(taskId, "take_over", auth);
          task = await runner.takeOver(taskId);
        }
        const mode = task.state === "editing" ? "rw" : "ro";
        if (editorAction === "open") {
          await requested(taskId, "open_editor", auth, { mode });
        }
        const { token } = await editors.editors.open(task, mode);
        const host = new URL(
          `https://${singleHeader(request.headers.host) ?? "localhost"}`,
        ).hostname;
        const url = new URL(`https://${host}`);
        url.port = String(editors.port);
        url.pathname = "/open";
        url.searchParams.set("token", token);
        sendJson(response, 200, {
          task: describeTask(task),
          mode,
          url: url.href,
        });
        return true;
      }
      if (action === "publish") {
        const body = await readJsonBody(
          request,
          MAX_TASK_BODY_BYTES,
          auth.signal,
        );
        if (Object.keys(body).some((key) => !PUBLISH_FIELDS.has(key))) {
          throw new HttpError(400, "publish_field_unknown");
        }
        if (
          body.allowUnreviewed !== undefined &&
          typeof body.allowUnreviewed !== "boolean"
        ) {
          throw new HttpError(400, "allow_unreviewed_invalid");
        }
        await requireValid(auth);
        await requested(
          taskId,
          "publish",
          auth,
          body.allowUnreviewed === true ? { allowUnreviewed: true } : {},
        );
        sendJson(response, 202, {
          task: describeTask(
            await runner.publish(taskId, {
              allowUnreviewed: body.allowUnreviewed === true,
            }),
          ),
        });
        return true;
      }
      await requireValid(auth);
      await requested(taskId, action === "stop" ? "stop" : "resume", auth);
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
        publish: repositories.get(task.repository)?.publish ?? null,
        // Whether the browser editor is available, and open now.
        editor: options.editors
          ? {
              enabled: true,
              ...(options.editors.editors.running(taskId)
                ? { mode: options.editors.editors.running(taskId)!.mode }
                : {}),
            }
          : { enabled: false },
      });
      return true;
    }
    if (method === "DELETE") {
      requireTask(taskId);
      const runner = requireRunner();
      await requireValid(auth);
      await requested(taskId, "delete", auth);
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
