import type { AgentModelReference } from "@agentlink/core";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import { HttpError, readJsonBody, sendJson } from "./httpJson.js";
import {
  ManagedProviderInputError,
  type ManagedProviders,
} from "./managedProviders.js";
import type { AssistantServerModelChoice } from "./serverConfig.js";

/**
 * Owner-only OpenAI API key and default model setup:
 *
 * - `GET /api/providers/openai`: the key's state and a redacted label (never
 *   the key), OpenAI's models, the models new chats may use now, and the
 *   default for new chats
 * - `PUT /api/providers/openai/key`: `{ expectedRevision, apiKey }`
 * - `DELETE /api/providers/openai/key`: `{ expectedRevision }`
 * - `PUT /api/providers/default-model`: `{ expectedRevision, model }`, where
 *   `model` is `{ providerId, modelId }` of an available model, or `null`
 *   for `server.json`'s default
 *
 * The provider ID is fixed by the path: no endpoint, file name, path or
 * command is accepted. Saving a key only checks its shape and stores it;
 * nothing is sent to OpenAI until a chat (the first billable request).
 * A stale tab's change gets `409 providers_changed`. Unsafe methods have
 * already passed the server's Host, Origin and fetch-site checks.
 */

const BASE = "/api/providers/openai";
const KEY = `${BASE}/key`;
const DEFAULT_MODEL = "/api/providers/default-model";
const MAX_BODY_BYTES = 4 * 1024;

export function createManagedProviderRoutes(options: {
  readonly providers: ManagedProviders;
  /** OpenAI's models from the maintained catalogue. */
  readonly openAiModels: readonly AssistantServerModelChoice[];
  /** What new chats may use right now. */
  readonly availableModels: () => readonly AssistantServerModelChoice[];
  /** The default for new chats right now. */
  readonly defaultModel: () => AgentModelReference;
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
  const describe = () => {
    const status = options.providers.status();
    const choice = (model: AssistantServerModelChoice) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.providerDisplayName
        ? { providerDisplayName: model.providerDisplayName }
        : {}),
    });
    const current = options.defaultModel();
    return {
      revision: status.revision,
      openai: status.openai,
      openAiModels: options.openAiModels.map(choice),
      availableModels: options.availableModels().map(choice),
      defaultModel: {
        providerId: current.providerId,
        modelId: current.modelId,
      },
      defaultModelSource: status.defaultModel ? "setup" : "server",
      ...(status.ignoredDefaultModel
        ? { ignoredDefaultModel: status.ignoredDefaultModel }
        : {}),
    };
  };
  const revisionOf = (body: Record<string, unknown>) => {
    const revision = body.expectedRevision;
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      throw new HttpError(400, "providers_revision_required");
    }
    return revision;
  };
  const onlyKeys = (body: Record<string, unknown>, keys: readonly string[]) => {
    if (Object.keys(body).some((key) => !keys.includes(key))) {
      throw new HttpError(400, "provider_request_invalid");
    }
  };
  const requireCurrent = async (auth: AssistantServerAuth) => {
    if ((await auth.revalidate()).valid !== true) {
      throw new HttpError(401, "authentication_required");
    }
  };
  const mapped = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ManagedProviderInputError) {
        const status =
          error.code === "api_key_invalid" ||
          error.code === "model_not_available"
            ? 400
            : 409;
        throw new HttpError(status, error.code);
      }
      // Never echo a file system error: it could name the key's path.
      throw new HttpError(500, "provider_save_failed");
    }
  };
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (
        url.pathname !== BASE &&
        url.pathname !== KEY &&
        url.pathname !== DEFAULT_MODEL
      ) {
        return false;
      }
      if (!options.isOwner(auth)) {
        throw new HttpError(403, "providers_forbidden");
      }
      if (url.search) throw new HttpError(400, "provider_request_invalid");
      const method = (request.method ?? "GET").toUpperCase();
      if (url.pathname === BASE) {
        if (method !== "GET") throw new HttpError(405, "method_not_allowed");
        sendJson(response, 200, describe());
        return true;
      }
      if (url.pathname === KEY && (method === "PUT" || method === "DELETE")) {
        const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
        if (method === "PUT") {
          onlyKeys(body, ["expectedRevision", "apiKey"]);
          const revision = revisionOf(body);
          await requireCurrent(auth);
          await mapped(() =>
            options.providers.saveOpenAiKey(body.apiKey, revision, now()),
          );
        } else {
          onlyKeys(body, ["expectedRevision"]);
          const revision = revisionOf(body);
          await requireCurrent(auth);
          await mapped(() =>
            options.providers.removeOpenAiKey(revision, now()),
          );
        }
        sendJson(response, 200, describe());
        return true;
      }
      if (url.pathname === DEFAULT_MODEL && method === "PUT") {
        const body = await readJsonBody(request, MAX_BODY_BYTES, auth.signal);
        onlyKeys(body, ["expectedRevision", "model"]);
        const revision = revisionOf(body);
        let model: AgentModelReference | undefined;
        if (body.model !== null) {
          const value = body.model as Record<string, unknown> | undefined;
          if (
            !value ||
            typeof value !== "object" ||
            Object.keys(value).some(
              (key) => key !== "providerId" && key !== "modelId",
            ) ||
            typeof value.providerId !== "string" ||
            typeof value.modelId !== "string"
          ) {
            throw new HttpError(400, "model_invalid");
          }
          const providerId = value.providerId;
          const modelId = value.modelId;
          // Only a model new chats can use now: an OpenAI model needs a key.
          if (
            !options
              .availableModels()
              .some(
                (choice) =>
                  choice.providerId === providerId &&
                  choice.modelId === modelId,
              )
          ) {
            throw new HttpError(400, "model_not_available");
          }
          model = { providerId, modelId };
        }
        await requireCurrent(auth);
        await mapped(() => options.providers.setDefault(model, revision));
        sendJson(response, 200, describe());
        return true;
      }
      throw new HttpError(405, "method_not_allowed");
    },
  };
}
