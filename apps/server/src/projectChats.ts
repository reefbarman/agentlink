import { isCoreReasoningEffort } from "@agentlink/protocol";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { BAKED_BROWSER_GATEWAY_THEME } from "../../../src/browser-gateway/browserGatewayThemeCache.js";
import { modelKey, type AskAgentBridge } from "./askAgentBridge.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { writeFileAtomic } from "./atomicFile.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  PROJECT_ID_PATTERN,
  ProjectCloneError,
  type AssistantProjectEntry,
  type AssistantProjectSettingsPatch,
  type CloneRepository,
  type ProjectCatalog,
} from "./projectCatalog.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";

/**
 * Projects for the chat app. Each project has its own chat bridge (chats,
 * titles, running turn); this router serves the project endpoints and sends
 * every other `/api/ask-agent/*` request to the bridge of the project this
 * browser selected, remembered in a cookie so devices switch independently.
 */

export const PROJECT_COOKIE = "agentlink_project";
const PROJECT_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_CREATE_BODY_BYTES = 64 * 1024;
const SETTINGS_ROUTE = /^\/api\/ask-agent\/projects\/([^/]+)\/settings$/u;

export interface ProjectChatsOptions {
  readonly catalog: ProjectCatalog;
  /** Bridges of the projects that opened at startup. */
  readonly bridges: ReadonlyMap<string, AskAgentBridge>;
  readonly models: readonly AssistantServerModelChoice[];
  /** Open a newly created project (workspace host, routes, bridge). */
  readonly openProject: (
    entry: AssistantProjectEntry,
  ) => Promise<AskAgentBridge>;
  /** Absent when repositories cannot be cloned here. */
  readonly clone?: CloneRepository;
  readonly log?: (line: string) => void;
}

export interface ProjectChats {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
  readonly theme: BrowserGatewayThemeSnapshot;
  close(): Promise<void>;
}

export function createProjectChats(options: ProjectChatsOptions): ProjectChats {
  const { catalog } = options;
  const bridges = new Map(options.bridges);
  const modelKeys = new Set(options.models.map((model) => modelKey(model)));
  let closed = false;

  const available = () =>
    catalog.list().filter((project) => bridges.has(project.id));

  /** The project this browser selected, or the first one. */
  const activeProject = (request: IncomingMessage) => {
    const projects = available();
    const selected = readCookie(request, PROJECT_COOKIE);
    return projects.find((project) => project.id === selected) ?? projects[0];
  };

  const selectCookie = (response: ServerResponse, projectId: string) => {
    response.setHeader(
      "set-cookie",
      `${PROJECT_COOKIE}=${projectId}; Path=/; Max-Age=${PROJECT_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Strict`,
    );
  };

  const describe = (project: AssistantProjectEntry) => ({
    id: project.id,
    label: project.label,
    origin: project.origin,
    path: project.root,
    repositories: project.repositories,
    ...(project.createdAt ? { createdAt: project.createdAt } : {}),
    settings: project.settings,
  });

  const listResponse = (activeId: string | undefined) => ({
    activeProjectId: activeId ?? null,
    canCreate: catalog.canCreate,
    canClone: catalog.canCreate && options.clone !== undefined,
    projects: available().map(describe),
  });

  const requireValid = async (auth: AssistantServerAuth) => {
    if (!(await auth.revalidate()).valid) {
      throw new HttpError(401, "authentication_required");
    }
  };

  const handleCreate = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ) => {
    const body = await readJsonBody(
      request,
      MAX_CREATE_BODY_BYTES,
      auth.signal,
    );
    const name = typeof body.name === "string" ? body.name : "";
    const repositories = body.repositories ?? [];
    if (
      !Array.isArray(repositories) ||
      !repositories.every((url): url is string => typeof url === "string")
    ) {
      throw new HttpError(400, "repositories_invalid");
    }
    const urls = repositories.map((url) => url.trim()).filter(Boolean);
    if (urls.length > 0 && !options.clone) {
      throw new HttpError(409, "project_clone_unavailable");
    }
    if (closed) throw new HttpError(503, "server_closing");
    await requireValid(auth);
    let entry: AssistantProjectEntry;
    try {
      entry = await catalog.create(
        { label: name, repositories: urls },
        options.clone ?? (() => Promise.reject(new Error("unreachable"))),
      );
    } catch (error) {
      if (error instanceof ProjectCloneError) {
        sendJson(response, error.status, {
          error: error.code,
          url: error.url,
          detail: error.detail,
        });
        return;
      }
      throw error;
    }
    options.log?.(
      `Created project "${entry.id}" (${entry.repositories.length} repositor${entry.repositories.length === 1 ? "y" : "ies"})`,
    );
    const bridge = await options.openProject(entry);
    if (closed) {
      await bridge.close();
      throw new HttpError(503, "server_closing");
    }
    bridges.set(entry.id, bridge);
    selectCookie(response, entry.id);
    sendJson(response, 201, { ok: true, project: describe(entry) });
  };

  const instructionsPath = (project: AssistantProjectEntry) =>
    path.join(project.root, INSTRUCTIONS_FILE);

  const readInstructions = async (project: AssistantProjectEntry) => {
    try {
      const handle = await fs.open(instructionsPath(project), "r");
      try {
        const buffer = Buffer.alloc(MAX_INSTRUCTIONS_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          instructions: buffer
            .subarray(0, Math.min(bytesRead, MAX_INSTRUCTIONS_BYTES))
            .toString("utf8"),
          instructionsTruncated: bytesRead > MAX_INSTRUCTIONS_BYTES,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { instructions: "", instructionsTruncated: false };
      }
      throw error;
    }
  };

  const handleSettings = async (
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    method: string,
  ) => {
    const project = PROJECT_ID_PATTERN.test(projectId)
      ? available().find((candidate) => candidate.id === projectId)
      : undefined;
    if (!project) throw new HttpError(404, "project_not_found");
    if (method === "GET") {
      sendJson(response, 200, {
        project: describe(project),
        ...(await readInstructions(project)),
      });
      return;
    }
    if (method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await readJsonBody(
      request,
      MAX_INSTRUCTIONS_BYTES + 16 * 1024,
      auth.signal,
    );
    const patch: {
      -readonly [
        Key in keyof AssistantProjectSettingsPatch
      ]: AssistantProjectSettingsPatch[Key];
    } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string")
        throw new HttpError(400, "name_invalid");
      patch.label = body.name;
    }
    if (body.defaultModel !== undefined) {
      if (body.defaultModel === null || body.defaultModel === "") {
        patch.defaultModel = null;
      } else if (
        typeof body.defaultModel === "string" &&
        modelKeys.has(body.defaultModel)
      ) {
        patch.defaultModel = body.defaultModel;
      } else {
        throw new HttpError(400, "invalid_model");
      }
    }
    if (body.defaultReasoningEffort !== undefined) {
      if (
        body.defaultReasoningEffort === null ||
        body.defaultReasoningEffort === ""
      ) {
        patch.defaultReasoningEffort = null;
      } else if (
        typeof body.defaultReasoningEffort === "string" &&
        isCoreReasoningEffort(body.defaultReasoningEffort)
      ) {
        patch.defaultReasoningEffort = body.defaultReasoningEffort;
      } else {
        throw new HttpError(400, "invalid_reasoning_effort");
      }
    }
    let instructions: string | undefined;
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== "string") {
        throw new HttpError(400, "instructions_invalid");
      }
      if (Buffer.byteLength(body.instructions) > MAX_INSTRUCTIONS_BYTES) {
        throw new HttpError(413, "instructions_too_large");
      }
      instructions = body.instructions;
    }
    await requireValid(auth);
    const updated = await catalog.update(project.id, patch);
    if (instructions !== undefined) {
      const file = instructionsPath(project);
      if (instructions.trim()) {
        await writeFileAtomic(
          file,
          instructions.endsWith("\n") ? instructions : `${instructions}\n`,
          0o644,
        );
      } else {
        await fs.rm(file, { force: true });
      }
    }
    sendJson(response, 200, {
      ok: true,
      project: describe(updated),
      ...(await readInstructions(updated)),
    });
  };

  const handleProjectRoute = async (
    pathname: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean> => {
    if (pathname === "/api/ask-agent/projects") {
      if (method === "GET") {
        sendJson(response, 200, listResponse(activeProject(request)?.id));
        return true;
      }
      if (method === "POST") {
        await handleCreate(request, response, auth);
        return true;
      }
      throw new HttpError(405, "method_not_allowed");
    }
    if (pathname === "/api/ask-agent/projects/select") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, undefined, auth.signal);
      const projectId =
        typeof body.projectId === "string" ? body.projectId : "";
      if (!available().some((project) => project.id === projectId)) {
        throw new HttpError(404, "project_not_found");
      }
      selectCookie(response, projectId);
      sendJson(response, 200, { ok: true, ...listResponse(projectId) });
      return true;
    }
    const settings = SETTINGS_ROUTE.exec(pathname);
    if (settings) {
      await handleSettings(
        decodeURIComponent(settings[1]!),
        request,
        response,
        auth,
        method,
      );
      return true;
    }
    return false;
  };

  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      const method = (request.method ?? "GET").toUpperCase();
      if (
        url.pathname === "/api/ask-agent/projects" ||
        url.pathname.startsWith("/api/ask-agent/projects/")
      ) {
        return await handleProjectRoute(
          url.pathname,
          method,
          request,
          response,
          auth,
        );
      }
      const project = activeProject(request);
      const bridge = project ? bridges.get(project.id) : undefined;
      return bridge
        ? await bridge.handleRequest(request, response, auth)
        : false;
    },
    get theme() {
      return (
        bridges.values().next().value?.theme ?? BAKED_BROWSER_GATEWAY_THEME
      );
    },
    async close() {
      closed = true;
      for (const bridge of bridges.values()) await bridge.close();
    },
  };
}

function readCookie(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}
