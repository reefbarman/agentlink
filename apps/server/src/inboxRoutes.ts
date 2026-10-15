import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  MAX_INBOX_ENTRIES,
  isSessionAlertKind,
  type InboxEntry,
  type InboxStore,
} from "./inboxStore.js";

/**
 * Owner-only inbox API:
 *
 * - `GET /api/inbox`: entries, newest first, and the unread count
 * - `POST /api/inbox/read`: `{ ids: [...] }` or `{ all: true }`
 * - `POST /api/inbox/act`: `{ id, action: "stop" | "keep_going" }` on a
 *   "still working" or "may be stuck" entry; marks it read
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks.
 */

const MAX_READ_BODY_BYTES = 64 * 1024;

export type InboxAction = "stop" | "keep_going";

export interface InboxRoutesOptions {
  readonly store: InboxStore;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  /** After entries are marked read, so open apps update their count. */
  readonly onChanged?: () => void;
  /** Stop the chat an entry is about, or let it keep going. */
  readonly act?: (
    entry: InboxEntry,
    action: InboxAction,
    auth: AssistantServerAuth,
  ) => Promise<void>;
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
      if (
        url.pathname !== "/api/inbox" &&
        url.pathname !== "/api/inbox/read" &&
        url.pathname !== "/api/inbox/act"
      ) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "inbox_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/inbox/act") {
        if (method !== "POST") throw new HttpError(405, "method_not_allowed");
        const body = await readJsonBody(
          request,
          MAX_READ_BODY_BYTES,
          auth.signal,
        );
        if (
          typeof body.id !== "string" ||
          (body.action !== "stop" && body.action !== "keep_going")
        ) {
          throw new HttpError(400, "invalid_request");
        }
        const entry = store
          .list()
          .find((candidate) => candidate.id === body.id);
        if (!entry) throw new HttpError(404, "inbox_entry_not_found");
        if (!isSessionAlertKind(entry.kind) || !options.act) {
          throw new HttpError(409, "inbox_action_unavailable");
        }
        await options.act(entry, body.action, auth);
        const marked = await store.markRead([entry.id]);
        if (marked > 0) options.onChanged?.();
        sendJson(response, 200, { ok: true, unread: store.unreadCount() });
        return true;
      }
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
