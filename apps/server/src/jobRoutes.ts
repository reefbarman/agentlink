import type { IncomingMessage, ServerResponse } from "node:http";

import { modelKey } from "./askAgentBridge.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import type { JobRunner } from "./jobRunner.js";
import {
  JobInputError,
  isActiveRun,
  parseJobFields,
  type JobDefinition,
  type JobStore,
} from "./jobStore.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";

/**
 * Owner-only scheduled job API:
 *
 * - `GET /api/jobs`, `POST /api/jobs`
 * - `GET`, `PATCH`, `DELETE /api/jobs/:id`
 * - `POST /api/jobs/:id/run` (run now)
 * - `GET /api/jobs/:id/runs` (newest first)
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks; mutations re-check the sign-in before they apply.
 */

const MAX_JOB_BODY_BYTES = 64 * 1024;
const JOB_ROUTE = /^\/api\/jobs\/([^/]+)(?:\/(run|runs))?$/u;
const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/u;

export interface JobRoutesOptions {
  readonly store: JobStore;
  readonly runner: JobRunner;
  /** Only the server's owner manages jobs. */
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  /** Whether a project is open on this server. */
  readonly hasProject: (projectId: string) => boolean;
  readonly models: readonly AssistantServerModelChoice[];
  /** For daily and weekly schedules that name no time zone. */
  readonly defaultTimeZone: string;
  /** What a watch has seen, shown with it. */
  readonly watchSummary?: (jobId: string) => WatchSummary | undefined;
  readonly now?: () => number;
}

export interface WatchSummary {
  readonly checkedAt?: number;
  readonly snapshots: number;
  /** Newest first. */
  readonly recentChanges: ReadonlyArray<{
    readonly at: number;
    readonly summary: string;
    readonly notified: boolean;
    readonly sessionId?: string;
  }>;
}

export interface JobRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

/**
 * Why a job could not run here, as an error code: its project is not open,
 * or its model or thinking level is not offered. Undefined when it can.
 */
export function jobRunnableError(
  fields: {
    readonly projectId: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  },
  options: {
    readonly hasProject: (projectId: string) => boolean;
    readonly models: ReadonlyMap<string, AssistantServerModelChoice>;
  },
):
  | "project_not_found"
  | "model_not_available"
  | "reasoning_effort_not_available"
  | undefined {
  if (!options.hasProject(fields.projectId)) return "project_not_found";
  if (fields.model === undefined) return undefined;
  const model = options.models.get(fields.model);
  if (!model) return "model_not_available";
  if (
    fields.reasoningEffort !== undefined &&
    !model.reasoningEfforts?.includes(
      fields.reasoningEffort as NonNullable<
        AssistantServerModelChoice["reasoningEfforts"]
      >[number],
    )
  ) {
    return "reasoning_effort_not_available";
  }
  return undefined;
}

/** Configured models by `providerId/modelId`. */
export function modelsByKey(
  models: readonly AssistantServerModelChoice[],
): ReadonlyMap<string, AssistantServerModelChoice> {
  return new Map(models.map((model) => [modelKey(model), model]));
}

export function createJobRoutes(options: JobRoutesOptions): JobRoutes {
  const { store, runner } = options;
  const now = options.now ?? Date.now;
  const models = modelsByKey(options.models);

  const describe = (job: JobDefinition) => {
    const runs = store.runs(job.id);
    const activeRun = runs.find(isActiveRun);
    const watchState = job.watch ? options.watchSummary?.(job.id) : undefined;
    return {
      ...job,
      ...(runs[0] ? { lastRun: runs[0] } : {}),
      ...(activeRun ? { activeRun } : {}),
      ...(watchState ? { watchState } : {}),
    };
  };

  /** The resulting job's project and model must exist here. */
  const assertRunnable = (fields: {
    readonly projectId: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  }) => {
    const error = jobRunnableError(fields, {
      hasProject: options.hasProject,
      models,
    });
    if (error) throw new HttpError(400, error);
  };

  const requireValid = async (auth: AssistantServerAuth) => {
    if (!(await auth.revalidate()).valid) {
      throw new HttpError(401, "authentication_required");
    }
  };

  const requireJob = (jobId: string) => {
    const job = JOB_ID_PATTERN.test(jobId) ? store.get(jobId) : undefined;
    if (!job) throw new HttpError(404, "job_not_found");
    return job;
  };

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    pathname: string,
    method: string,
  ): Promise<boolean> => {
    if (pathname === "/api/jobs") {
      if (method === "GET") {
        sendJson(response, 200, { jobs: store.list().map(describe) });
        return true;
      }
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, MAX_JOB_BODY_BYTES, auth.signal);
      const fields = parseJobFields(body, {
        partial: false,
        defaultTimeZone: options.defaultTimeZone,
      });
      assertRunnable(fields);
      await requireValid(auth);
      const job = await store.create(fields, now());
      await runner.jobChanged(job.id);
      sendJson(response, 201, { job: describe(store.get(job.id) ?? job) });
      return true;
    }

    const match = JOB_ROUTE.exec(pathname);
    if (!match) return false;
    const jobId = decodeURIComponent(match[1]!);
    const action = match[2];

    if (action === "runs") {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      requireJob(jobId);
      sendJson(response, 200, { runs: store.runs(jobId) });
      return true;
    }
    if (action === "run") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const job = requireJob(jobId);
      assertRunnable(job);
      await requireValid(auth);
      const run = await runner.runNow(jobId);
      sendJson(response, 202, { run });
      return true;
    }

    if (method === "GET") {
      sendJson(response, 200, { job: describe(requireJob(jobId)) });
      return true;
    }
    if (method === "PATCH") {
      const current = requireJob(jobId);
      const body = await readJsonBody(request, MAX_JOB_BODY_BYTES, auth.signal);
      const patch = parseJobFields(body, {
        partial: true,
        defaultTimeZone: options.defaultTimeZone,
      });
      // A job is a watch, a briefing, or neither.
      if (
        (patch.watch && current.briefing) ||
        (patch.briefing && current.watch)
      ) {
        throw new HttpError(400, "job_kind_conflict");
      }
      const model =
        patch.model === null ? undefined : (patch.model ?? current.model);
      const reasoningEffort =
        patch.reasoningEffort === null
          ? undefined
          : (patch.reasoningEffort ?? current.reasoningEffort);
      assertRunnable({
        projectId: patch.projectId ?? current.projectId,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      await requireValid(auth);
      await store.update(jobId, patch, now());
      // Pausing stops a live run; a new schedule starts counting now.
      await runner.jobChanged(jobId);
      sendJson(response, 200, { job: describe(requireJob(jobId)) });
      return true;
    }
    if (method === "DELETE") {
      requireJob(jobId);
      await requireValid(auth);
      await runner.stopJob(jobId, "job_deleted");
      await store.delete(jobId);
      await runner.jobChanged(jobId);
      sendJson(response, 200, { ok: true });
      return true;
    }
    throw new HttpError(405, "method_not_allowed");
  };

  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== "/api/jobs" &&
        !url.pathname.startsWith("/api/jobs/")
      ) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "jobs_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      try {
        return await route(request, response, auth, url.pathname, method);
      } catch (error) {
        if (error instanceof JobInputError) {
          throw new HttpError(statusFor(error.code), error.code);
        }
        throw error;
      }
    },
  };
}

function statusFor(code: string): number {
  if (code === "job_not_found") return 404;
  if (code === "job_busy" || code === "job_limit_reached") return 409;
  return 400;
}
