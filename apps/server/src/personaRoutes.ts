import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  DEFAULT_PERSONA_TEXT,
  PersonaInputError,
  parsePersonaPatch,
  type PersonaSettings,
  type PersonaStore,
} from "./persona.js";

/**
 * Owner-only persona settings:
 *
 * - `GET /api/settings/persona`: `{ settings, defaultPersona }`
 * - `PATCH /api/settings/persona`: the fields to change (`null` resets the
 *   persona text, clears the owner's name, or turns quiet hours off);
 *   `expectedUpdatedAt` refuses a change made from stale settings
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks.
 */

const PATH = "/api/settings/persona";
const MAX_BODY_BYTES = 16 * 1024;

export function createPersonaRoutes(options: {
  readonly store: PersonaStore;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly onChanged?: (settings: PersonaSettings) => void;
  readonly now?: () => number;
}): {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
} {
  const now = options.now ?? Date.now;
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (url.pathname !== PATH) return false;
      if (!options.isOwner(auth)) {
        throw new HttpError(403, "settings_forbidden");
      }
      const method = (request.method ?? "GET").toUpperCase();
      if (method === "GET") {
        sendJson(response, 200, {
          settings: options.store.get(),
          defaultPersona: DEFAULT_PERSONA_TEXT,
        });
        return true;
      }
      if (method !== "PATCH") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      const { expectedUpdatedAt, ...fields } = body;
      if (
        expectedUpdatedAt !== undefined &&
        expectedUpdatedAt !== options.store.get().updatedAt
      ) {
        throw new HttpError(409, "settings_changed");
      }
      let patch;
      try {
        patch = parsePersonaPatch(fields);
      } catch (error) {
        if (error instanceof PersonaInputError) {
          throw new HttpError(400, error.code);
        }
        throw error;
      }
      if ((await auth.revalidate()).valid !== true) {
        throw new HttpError(401, "authentication_required");
      }
      const settings = await options.store.update(patch, now());
      options.onChanged?.(settings);
      sendJson(response, 200, { settings });
      return true;
    },
  };
}
