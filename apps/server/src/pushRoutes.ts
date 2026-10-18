import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  PushSubscriptionError,
  type PushMessage,
  type PushService,
} from "./pushService.js";

/**
 * Owner-only push notification API, for the signed-in device making the
 * request:
 *
 * - `GET /api/push`: the VAPID public key and whether this device is on
 * - `PUT /api/push/subscription`: the browser's `PushSubscription` JSON
 * - `DELETE /api/push/subscription`: turn this device off
 * - `POST /api/push/test`: send this device a test notification
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks.
 */

const MAX_SUBSCRIPTION_BODY_BYTES = 8 * 1024;

export const TEST_PUSH_MESSAGE: PushMessage = {
  title: "AgentLink Assistant",
  body: "Notifications are working on this device.",
  url: "/",
  tag: "test",
};

export interface PushRoutesOptions {
  readonly push: PushService;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  readonly now?: () => number;
}

export interface PushRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

export function createPushRoutes(options: PushRoutesOptions): PushRoutes {
  const { push } = options;
  const now = options.now ?? Date.now;
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      const route = url.pathname;
      if (
        route !== "/api/push" &&
        route !== "/api/push/subscription" &&
        route !== "/api/push/test"
      ) {
        return false;
      }
      if (!options.isOwner(auth)) throw new HttpError(403, "push_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      const deviceId = auth.session.deviceId;

      if (route === "/api/push") {
        if (method !== "GET") throw new HttpError(405, "method_not_allowed");
        sendJson(response, 200, {
          publicKey: push.publicKey,
          subscribed: push.isSubscribed(deviceId),
        });
        return true;
      }
      if (route === "/api/push/subscription") {
        if (method === "PUT") {
          const body = await readJsonBody(
            request,
            MAX_SUBSCRIPTION_BODY_BYTES,
            auth.signal,
          );
          // The device may have been revoked while the request was read.
          if (!(await auth.revalidate()).valid) {
            throw new HttpError(401, "authentication_required");
          }
          try {
            await push.subscribe(deviceId, body, now());
          } catch (error) {
            if (error instanceof PushSubscriptionError) {
              throw new HttpError(400, error.code);
            }
            throw error;
          }
          sendJson(response, 200, { subscribed: true });
          return true;
        }
        if (method === "DELETE") {
          request.resume();
          await push.unsubscribe(deviceId);
          sendJson(response, 200, { subscribed: false });
          return true;
        }
        throw new HttpError(405, "method_not_allowed");
      }
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      request.resume();
      if (!push.isSubscribed(deviceId)) {
        throw new HttpError(409, "push_not_subscribed");
      }
      const delivery = await push.notifyDevice(deviceId, TEST_PUSH_MESSAGE);
      sendJson(response, 200, {
        outcome: delivery?.outcome ?? "gone",
        ...(delivery?.status === undefined ? {} : { status: delivery.status }),
      });
      return true;
    },
  };
}
