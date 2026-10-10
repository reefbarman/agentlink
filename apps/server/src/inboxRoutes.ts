import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import { MAX_INBOX_ENTRIES, type InboxStore } from "./inboxStore.js";

/**
 * Owner-only inbox API:
 *
 * - `GET /api/inbox`: entries, newest first, and the unread count
 * - `POST /api/inbox/read`: `{ ids: [...] }` or `{ all: true }`
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks.
 */

const MAX_READ_BODY_BYTES = 64 * 1024;

export interface InboxRoutesOptions {
  readonly store: InboxStore;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  /** After entries are marked read, so open apps update their count. */
  readonly onChanged?: () => void;
}

export interface InboxRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

export function createInboxRoutes(options: InboxRoutesOptions): InboxRoutes {
  const { store } = options;
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (url.pathname !== "/api/inbox" && url.pathname !== "/api/inbox/read") {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "inbox_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/inbox") {
        if (method !== "GET") throw new HttpError(405, "method_not_allowed");
        sendJson(response, 200, {
          entries: store.list(),
          unread: store.unreadCount(),
        });
        return true;
      }
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(
        request,
        MAX_READ_BODY_BYTES,
        auth.signal,
      );
      let ids: readonly string[] | "all";
      if (body.all === true) ids = "all";
      else if (
        Array.isArray(body.ids) &&
        body.ids.length <= MAX_INBOX_ENTRIES &&
        body.ids.every((id) => typeof id === "string")
      ) {
        ids = body.ids as string[];
      } else {
        throw new HttpError(400, "invalid_request");
      }
      const marked = await store.markRead(ids);
      if (marked > 0) options.onChanged?.();
      sendJson(response, 200, {
        ok: true,
        marked,
        unread: store.unreadCount(),
      });
      return true;
    },
  };
}
