import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CodexOAuthFlowError,
  type CodexCredentials,
  type CodexOAuthAccountInfo,
} from "@agentlink/node-host";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";

/**
 * Owner-only ChatGPT (Codex) sign-in from the browser:
 *
 * - `GET /api/providers/codex`: whether this server has a ChatGPT provider,
 *   who is signed in, and whether a sign-in is waiting (and whose)
 * - `POST /api/providers/codex/sign-in`: start one; returns the official
 *   authorisation URL to open
 * - `POST /api/providers/codex/sign-in/complete`: `{ redirectUrl }`, the
 *   full `http://localhost:1455/auth/callback?...` address the browser ended
 *   on after signing in (it fails to load; that is expected)
 * - `DELETE /api/providers/codex/sign-in`: cancel this device's sign-in
 *
 * The server never fetches the pasted address: it is checked against the
 * waiting sign-in's state and only its code is exchanged, at the fixed
 * OpenAI endpoint. One sign-in waits at a time, bound to the session that
 * started it, for ten minutes. Another device gets a conflict rather than
 * silently cancelling it. Credentials are written to the same private store
 * the running service and `agentlink-server codex-login` use, only after the
 * session is checked again. Without a ChatGPT provider in `server.json`
 * every change is refused: this never adds a provider.
 *
 * Codes, verifiers, tokens and the pasted address never appear in
 * responses, logs or errors. Unsafe methods have already passed the
 * server's Host, Origin and fetch-site checks.
 */

const BASE = "/api/providers/codex";
const SIGN_IN = `${BASE}/sign-in`;
const COMPLETE = `${SIGN_IN}/complete`;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_REDIRECT_LENGTH = 4_096;
export const CODEX_SIGN_IN_TTL_MS = 10 * 60 * 1000;

/** The parts of the server's Codex sign-in runtime these routes use. */
export interface CodexSignInRuntime {
  ready(): Promise<void>;
  readonly manager: {
    startAuthorizationFlow(): string;
    cancelAuthorizationFlow(): void;
    completeAuthorizationFromRedirect(
      redirectUrl: string,
    ): Promise<CodexCredentials>;
    saveOAuthAccount(
      credentials: CodexCredentials,
      options?: {
        makeActive?: boolean;
        beforeCommit?: () => Promise<void>;
      },
    ): Promise<unknown>;
    listAccounts(): Promise<CodexOAuthAccountInfo[]>;
  };
}

interface Pending {
  readonly sessionId: string;
  readonly deviceLabel: string;
  readonly expiresAt: number;
}

function flowErrorCode(error: unknown): { status: number; code: string } {
  if (error instanceof CodexOAuthFlowError) {
    if (error.code === "missing_code") {
      return { status: 400, code: "codex_sign_in_address_invalid" };
    }
    if (error.code === "state_mismatch") {
      return { status: 400, code: "codex_sign_in_state_mismatch" };
    }
    return { status: 400, code: "codex_sign_in_failed" };
  }
  return { status: 502, code: "codex_sign_in_failed" };
}

export function createProviderRoutes(options: {
  /** Undefined when `server.json` has no `codex` provider. */
  readonly codex: CodexSignInRuntime | undefined;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly now?: () => number;
  /** Told after a successful sign-in, so open apps refresh. */
  readonly onSignedIn?: () => void;
  readonly log?: (line: string) => void;
}): {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
} {
  const now = options.now ?? Date.now;
  let pending: Pending | undefined;
  const live = () => {
    if (pending && pending.expiresAt <= now()) {
      pending = undefined;
      options.codex?.manager.cancelAuthorizationFlow();
    }
    return pending;
  };
  const status = async (auth: AssistantServerAuth) => {
    const codex = options.codex;
    if (!codex) return { available: false, accounts: [], pending: null };
    await codex.ready();
    const accounts = await codex.manager.listAccounts();
    const current = live();
    return {
      available: true,
      accounts: accounts.map((account) => ({
        label: account.label,
        active: account.isActive,
      })),
      pending: current
        ? {
            mine: current.sessionId === auth.session.sessionId,
            deviceLabel: current.deviceLabel,
            expiresAt: current.expiresAt,
          }
        : null,
    };
  };
  const requireCurrent = async (auth: AssistantServerAuth) => {
    if ((await auth.revalidate()).valid !== true) {
      throw new HttpError(401, "authentication_required");
    }
  };
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== BASE &&
        url.pathname !== SIGN_IN &&
        url.pathname !== COMPLETE
      ) {
        return false;
      }
      if (!options.isOwner(auth))
        throw new HttpError(403, "providers_forbidden");
      if (url.search) throw new HttpError(400, "provider_request_invalid");
      const method = (request.method ?? "GET").toUpperCase();
      if (url.pathname === BASE) {
        if (method !== "GET") throw new HttpError(405, "method_not_allowed");
        sendJson(response, 200, await status(auth));
        return true;
      }
      const codex = options.codex;
      if (!codex) throw new HttpError(409, "codex_unavailable");
      if (url.pathname === SIGN_IN && method === "POST") {
        await requireCurrent(auth);
        await codex.ready();
        const current = live();
        if (current && current.sessionId !== auth.session.sessionId) {
          throw new HttpError(409, "codex_sign_in_pending_elsewhere");
        }
        const authorizeUrl = codex.manager.startAuthorizationFlow();
        pending = {
          sessionId: auth.session.sessionId,
          deviceLabel: auth.session.deviceLabel,
          expiresAt: now() + CODEX_SIGN_IN_TTL_MS,
        };
        sendJson(response, 200, {
          authorizeUrl,
          expiresAt: pending.expiresAt,
        });
        return true;
      }
      if (url.pathname === SIGN_IN && method === "DELETE") {
        await requireCurrent(auth);
        const current = live();
        if (current && current.sessionId !== auth.session.sessionId) {
          throw new HttpError(409, "codex_sign_in_pending_elsewhere");
        }
        if (current) {
          pending = undefined;
          codex.manager.cancelAuthorizationFlow();
        }
        sendJson(response, 200, await status(auth));
        return true;
      }
      if (url.pathname === COMPLETE && method === "POST") {
        const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
        const redirectUrl = body.redirectUrl;
        if (
          Object.keys(body).some((key) => key !== "redirectUrl") ||
          typeof redirectUrl !== "string" ||
          !redirectUrl.trim() ||
          redirectUrl.length > MAX_REDIRECT_LENGTH
        ) {
          throw new HttpError(400, "codex_sign_in_address_invalid");
        }
        await requireCurrent(auth);
        const current = live();
        if (!current) throw new HttpError(409, "codex_sign_in_not_pending");
        if (current.sessionId !== auth.session.sessionId) {
          throw new HttpError(409, "codex_sign_in_pending_elsewhere");
        }
        // One attempt per sign-in: a replay or a second tab finds nothing.
        pending = undefined;
        let credentials: CodexCredentials;
        try {
          credentials =
            await codex.manager.completeAuthorizationFromRedirect(redirectUrl);
        } catch (error) {
          const mapped = flowErrorCode(error);
          options.log?.(
            `ChatGPT sign-in from the browser failed (${mapped.code})`,
          );
          throw new HttpError(mapped.status, mapped.code);
        }
        // The device may have been revoked during the exchange or while the
        // save waited for the credential lock (a token refresh can hold it):
        // check inside the lock, right before anything is written.
        await codex.manager.saveOAuthAccount(credentials, {
          makeActive: true,
          beforeCommit: () => requireCurrent(auth),
        });
        options.onSignedIn?.();
        sendJson(response, 200, await status(auth));
        return true;
      }
      throw new HttpError(405, "method_not_allowed");
    },
  };
}
