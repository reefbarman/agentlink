import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import {
  parseCommitIdentity,
  type CommitIdentity,
  type GitHubConnection,
  type GitHubConnectionStore,
} from "./githubConnections.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import type { ConnectionStatus } from "./publisher.js";
import {
  PublisherRequestError,
  type PublisherClient,
} from "./publisherClient.js";
import type { RepositorySettingsStore } from "./taskRepositories.js";

/**
 * Owner-only GitHub connections. The tokens stay in the publisher; these
 * routes only start sign-ins, report statuses and keep each connection's
 * account and commit identity.
 *
 * - `GET /api/github`: whether publishing is set up, and every connection
 *   with its status (`pending`, `connected`, `missing`, ...)
 * - `POST /api/github/connections` (`{ method: "device" | "token",
 *   commitName, commitEmail, token? }`): a new connection; `device` returns
 *   the code to enter at github.com/login/device
 * - `GET /api/github/connections/:id`: one connection's status (poll it
 *   while a sign-in is pending)
 * - `POST /api/github/connections/:id/device`: sign in again
 * - `PUT /api/github/connections/:id/token` (`{ token }`): use a token
 * - `PATCH /api/github/connections/:id` (`{ commitName?, commitEmail? }`)
 * - `DELETE /api/github/connections/:id`: also revokes every repository
 *   permission that uses it
 */

const MAX_BODY_BYTES = 16 * 1024;
const CONNECTION_ROUTE =
  /^\/api\/github\/connections\/([0-9a-f]{12})(?:\/(device|token))?$/u;
const CREATE_FIELDS = new Set(["method", "commitName", "commitEmail", "token"]);
const PATCH_FIELDS = new Set(["commitName", "commitEmail"]);

export interface GitHubRoutesOptions {
  readonly connections: GitHubConnectionStore;
  /** Undefined when the server has no publisher configured. */
  readonly publisher: PublisherClient | undefined;
  readonly repositories: Pick<RepositorySettingsStore, "revokeConnection">;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly now?: () => number;
}

export interface GitHubRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

type StatusView =
  | ConnectionStatus
  | { readonly status: "unavailable"; readonly error: string };

export function createGitHubRoutes(options: GitHubRoutesOptions): GitHubRoutes {
  const { connections } = options;
  const now = options.now ?? Date.now;

  const requirePublisher = () => {
    if (!options.publisher)
      throw new HttpError(409, "publisher_not_configured");
    return options.publisher;
  };
  const requireValid = async (auth: AssistantServerAuth) => {
    if (!(await auth.revalidate()).valid) {
      throw new HttpError(401, "authentication_required");
    }
  };
  const requireConnection = (id: string) => {
    const connection = connections.get(id);
    if (!connection) throw new HttpError(404, "connection_not_found");
    return connection;
  };

  /** The publisher's view, recording the account once it is known. */
  const statusOf = async (
    connection: GitHubConnection,
  ): Promise<{ connection: GitHubConnection; status: StatusView }> => {
    if (!options.publisher) {
      return {
        connection,
        status: { status: "unavailable", error: "publisher_not_configured" },
      };
    }
    let status: ConnectionStatus;
    try {
      status = await options.publisher.status(connection.id);
    } catch (error) {
      return {
        connection,
        status: {
          status: "unavailable",
          error:
            error instanceof PublisherRequestError
              ? error.code
              : "publisher_unavailable",
        },
      };
    }
    if (
      status.status === "connected" &&
      (status.login !== connection.login || status.kind !== connection.kind)
    ) {
      connection = await connections.update(
        connection.id,
        { login: status.login, kind: status.kind },
        now(),
      );
    }
    return { connection, status };
  };

  const readToken = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new HttpError(400, "token_required");
    }
    return value.trim();
  };

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
    pathname: string,
    method: string,
  ): Promise<boolean> => {
    if (pathname === "/api/github") {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed");
      let deviceFlow = false;
      let available = false;
      if (options.publisher) {
        try {
          deviceFlow = (await options.publisher.health()).deviceFlow;
          available = true;
        } catch {
          available = false;
        }
      }
      sendJson(response, 200, {
        configured: options.publisher !== undefined,
        available,
        deviceFlow,
        connections: await Promise.all(connections.list().map(statusOf)),
      });
      return true;
    }

    if (pathname === "/api/github/connections") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      const publisher = requirePublisher();
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      if (Object.keys(body).some((key) => !CREATE_FIELDS.has(key))) {
        throw new HttpError(400, "connection_field_unknown");
      }
      if (body.method !== "device" && body.method !== "token") {
        throw new HttpError(400, "connection_method_invalid");
      }
      const identity = parseCommitIdentity(body) as CommitIdentity;
      const token = body.method === "token" ? readToken(body.token) : undefined;
      if (body.method === "device" && body.token !== undefined) {
        throw new HttpError(400, "connection_field_unknown");
      }
      await requireValid(auth);
      const connection = await connections.create(
        body.method === "device" ? "app" : "token",
        identity,
        now(),
      );
      let status: ConnectionStatus;
      try {
        status =
          token === undefined
            ? await publisher.startDeviceFlow(connection.id)
            : await publisher.importToken(connection.id, token);
      } catch (error) {
        // Nothing to keep: the connection never worked.
        await connections.delete(connection.id);
        throw error;
      }
      const saved =
        status.status === "connected"
          ? await connections.update(
              connection.id,
              { login: status.login },
              now(),
            )
          : connection;
      sendJson(response, 201, { connection: saved, status });
      return true;
    }

    const match = CONNECTION_ROUTE.exec(pathname);
    if (!match) return false;
    const id = match[1]!;
    const action = match[2];
    const connection = requireConnection(id);

    if (action === "device") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      request.resume();
      const publisher = requirePublisher();
      await requireValid(auth);
      const status = await publisher.startDeviceFlow(id);
      const saved =
        connection.kind === "app"
          ? connection
          : await connections.update(id, { kind: "app" }, now());
      sendJson(response, 200, { connection: saved, status });
      return true;
    }
    if (action === "token") {
      if (method !== "PUT") throw new HttpError(405, "method_not_allowed");
      const publisher = requirePublisher();
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      if (Object.keys(body).some((key) => key !== "token")) {
        throw new HttpError(400, "connection_field_unknown");
      }
      const token = readToken(body.token);
      await requireValid(auth);
      const status = await publisher.importToken(id, token);
      const saved =
        status.status === "connected"
          ? await connections.update(
              id,
              { login: status.login, kind: "token" },
              now(),
            )
          : connection;
      sendJson(response, 200, { connection: saved, status });
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, await statusOf(connection));
      return true;
    }
    if (method === "PATCH") {
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      if (Object.keys(body).some((key) => !PATCH_FIELDS.has(key))) {
        throw new HttpError(400, "connection_field_unknown");
      }
      const identity = parseCommitIdentity(body, true);
      await requireValid(auth);
      sendJson(response, 200, {
        connection: await connections.update(id, identity, now()),
      });
      return true;
    }
    if (method === "DELETE") {
      request.resume();
      await requireValid(auth);
      // Revoke first: no task may publish with a connection being removed.
      await options.repositories.revokeConnection(id, now());
      if (options.publisher) {
        await options.publisher.remove(id).catch((error: unknown) => {
          // The token stays in the publisher until it is reachable again;
          // without the connection here, nothing can ask it to be used.
          if (!(error instanceof PublisherRequestError)) throw error;
        });
      }
      await connections.delete(id);
      sendJson(response, 200, { ok: true });
      return true;
    }
    throw new HttpError(405, "method_not_allowed");
  };

  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== "/api/github" &&
        !url.pathname.startsWith("/api/github/")
      ) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "github_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      try {
        return await route(request, response, auth, url.pathname, method);
      } catch (error) {
        if (error instanceof PublisherRequestError) {
          // The publisher's reason, so the owner can act on it.
          sendJson(response, error.status >= 500 ? 502 : error.status, {
            error: error.code,
            ...(error.detail ? { detail: error.detail } : {}),
          });
          return true;
        }
        throw error;
      }
    },
  };
}
