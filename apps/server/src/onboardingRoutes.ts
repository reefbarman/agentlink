import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  OnboardingInputError,
  onboardingStatus,
  parseOnboardingPatch,
  shouldOpenSetup,
  type OnboardingFacts,
  type OnboardingStore,
} from "./onboarding.js";

/**
 * Owner-only first-run setup:
 *
 * - `GET /api/onboarding`: `{ record, facts, status, openSetup }`
 * - `PATCH /api/onboarding`: `{ expectedRevision, step?, backupPasswordSaved?,
 *   complete?, dismiss? }`; a stale revision gets `409 onboarding_changed`
 *
 * It records progress only; signing in, preferences and connections use
 * their own routes. Unsafe methods have already passed the server's Host,
 * Origin and fetch-site checks.
 */

const PATH = "/api/onboarding";
const MAX_BODY_BYTES = 4 * 1024;

export function createOnboardingRoutes(options: {
  readonly store: OnboardingStore;
  readonly facts: () => Promise<OnboardingFacts>;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly now?: () => number;
}): {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
} {
  const now = options.now ?? Date.now;
  const describe = async () => {
    const record = options.store.get();
    const facts = await options.facts();
    return {
      record: record ?? null,
      facts,
      status: onboardingStatus(record, facts),
      openSetup: shouldOpenSetup(record),
    };
  };
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (url.pathname !== PATH) return false;
      if (!options.isOwner(auth))
        throw new HttpError(403, "onboarding_forbidden");
      if (url.search) throw new HttpError(400, "onboarding_request_invalid");
      const method = (request.method ?? "GET").toUpperCase();
      if (method === "GET") {
        sendJson(response, 200, await describe());
        return true;
      }
      if (method !== "PATCH") throw new HttpError(405, "method_not_allowed");
      const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
      let parsed;
      try {
        parsed = parseOnboardingPatch(body);
      } catch (error) {
        if (error instanceof OnboardingInputError) {
          throw new HttpError(400, error.code);
        }
        throw error;
      }
      if ((await auth.revalidate()).valid !== true) {
        throw new HttpError(401, "authentication_required");
      }
      try {
        await options.store.update(
          parsed.patch,
          parsed.expectedRevision,
          now(),
        );
      } catch (error) {
        if (error instanceof OnboardingInputError) {
          throw new HttpError(409, error.code);
        }
        throw error;
      }
      sendJson(response, 200, await describe());
      return true;
    },
  };
}
