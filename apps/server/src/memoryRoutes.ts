import type { IncomingMessage, ServerResponse } from "node:http";

import { MemoryInputError, type AssistantMemory } from "./assistantMemory.js";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";

/**
 * Owner-only memory API:
 *
 * - `GET /api/memory?q=`: memories (active and contested), newest first
 * - `PATCH /api/memory/:id`: `{ statement, expectedRevision }`, a new revision
 * - `POST /api/memory/:id/forget`: forget it (and what it replaced); the
 *   text is removed from the store on disk
 * - `POST /api/memory/forget-all`: forget everything
 * - `GET /api/memory/export`: every memory as a JSON archive
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks.
 */

const PREFIX = "/api/memory";
const MAX_BODY_BYTES = 16 * 1024;

export function createMemoryRoutes(options: {
  readonly memory: AssistantMemory;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
}): {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
} {
  const { memory } = options;
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "memory_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      const rest = url.pathname.slice(PREFIX.length);
      try {
        if (rest === "" || rest === "/") {
          if (method !== "GET") throw new HttpError(405, "method_not_allowed");
          sendJson(response, 200, {
            memories: await memory.list(url.searchParams.get("q") ?? ""),
          });
          return true;
        }
        if (rest === "/export") {
          if (method !== "GET") throw new HttpError(405, "method_not_allowed");
          response.setHeader(
            "content-disposition",
            'attachment; filename="agentlink-assistant-memory.json"',
          );
          sendJson(response, 200, await memory.exportArchive());
          return true;
        }
        if (rest === "/forget-all") {
          if (method !== "POST") throw new HttpError(405, "method_not_allowed");
          await revalidate(auth);
          sendJson(response, 200, { forgotten: await memory.forgetAll() });
          return true;
        }
        const match = /^\/([^/]+)(\/forget)?$/u.exec(rest);
        if (!match) throw new HttpError(404, "not_found");
        const id = decodeURIComponent(match[1]!);
        if (match[2]) {
          if (method !== "POST") throw new HttpError(405, "method_not_allowed");
          await revalidate(auth);
          await memory.forget(id);
          sendJson(response, 200, { forgotten: true });
          return true;
        }
        if (method !== "PATCH") throw new HttpError(405, "method_not_allowed");
        const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
        if (
          typeof body.statement !== "string" ||
          typeof body.expectedRevision !== "number"
        ) {
          throw new HttpError(400, "memory_statement_invalid");
        }
        await revalidate(auth);
        sendJson(response, 200, {
          memory: await memory.update(
            id,
            body.statement,
            body.expectedRevision,
          ),
        });
        return true;
      } catch (error) {
        if (error instanceof MemoryInputError) {
          throw new HttpError(
            error.code === "memory_not_found"
              ? 404
              : error.code === "memory_changed"
                ? 409
                : 400,
            error.code,
          );
        }
        throw error;
      }
    },
  };
}

async function revalidate(auth: AssistantServerAuth): Promise<void> {
  if ((await auth.revalidate()).valid !== true) {
    throw new HttpError(401, "authentication_required");
  }
}
