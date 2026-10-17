import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  UpdaterRequestError,
  validateUpdateBody,
  type UpdaterClient,
  type UpdateConfirmation,
  type UpdatePreferences,
} from "./updaterClient.js";

export interface UpdateRoutesOptions {
  client: UpdaterClient | undefined;
  isOwner: (auth: AssistantServerAuth) => boolean;
}
export interface UpdateRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

/** The main server applies shared Host/Origin/fetch-site guards before this adapter. */
export function createUpdateRoutes(options: UpdateRoutesOptions): UpdateRoutes {
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== "/api/updates" &&
        !url.pathname.startsWith("/api/updates/")
      )
        return false;
      if (!options.isOwner(auth)) throw new HttpError(403, "updates_forbidden");
      if (url.search) throw new HttpError(400, "update_request_invalid");
      const action = url.pathname.slice("/api/updates".length);
      const client = options.client;
      if (action === "" && request.method === "GET") {
        if (!client) {
          sendJson(response, 200, { configured: false });
          return true;
        }
        try {
          sendJson(response, 200, { status: await client.status() });
        } catch {
          sendJson(response, 200, {
            configured: true,
            error: "update_unavailable",
          });
        }
        return true;
      }
      if (!["/check", "/preferences", "/apply", "/rollback"].includes(action))
        throw new HttpError(404, "not_found");
      if (request.method !== "POST")
        throw new HttpError(405, "method_not_allowed");
      if (!(await auth.revalidate()).valid)
        throw new HttpError(401, "authentication_required");
      if (!client) throw new HttpError(409, "updates_not_configured");
      const body = validateUpdateBody(
        action.slice(1) as "check" | "preferences" | "apply" | "rollback",
        await readJsonBody(request, 2048, auth.signal),
      );
      // Recheck after the bounded body read, before any unsafe side effect.
      if (!(await auth.revalidate()).valid)
        throw new HttpError(401, "authentication_required");
      try {
        const status =
          action === "/check"
            ? await client.check()
            : action === "/preferences"
              ? await client.preferences(body as UpdatePreferences)
              : action === "/apply"
                ? await client.apply(body as UpdateConfirmation)
                : await client.rollback(body as UpdateConfirmation);
        sendJson(
          response,
          action === "/apply" || action === "/rollback" ? 202 : 200,
          { status },
        );
      } catch (error) {
        if (error instanceof UpdaterRequestError)
          throw new HttpError(error.status, error.code);
        throw new HttpError(503, "update_unavailable");
      }
      return true;
    },
  };
}
