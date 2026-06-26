/**
 * CodexProvider — implements ModelProvider for the OpenAI/Codex Responses API.
 *
 * Supports two auth paths behind one provider surface:
 * - OAuth (ChatGPT/Codex subscription) via `chatgpt.com/backend-api/codex/responses`
 * - OpenAI API key via `api.openai.com/v1/responses`
 *
 * Uses the OpenAI SDK Responses API with endpoint-specific configuration for
 * OAuth-backed Codex and API-key-backed OpenAI requests.
 */

import * as crypto from "crypto";
import { randomUUID } from "crypto";

import OpenAI from "openai";
import type {
  ModelProvider,
  StreamRequest,
  CompleteRequest,
  CompleteResult,
  ProviderStreamEvent,
  ModelCapabilities,
  ModelInfo,
} from "../types.js";
import { collectCoreModelCompleteResult } from "../../../core/modelRuntime.js";
import {
  openAiCodexAuthManager,
  type OpenAiCodexAuthManager,
  type OpenAiCodexAuthMethod,
  type OpenAiCodexResolvedAuth,
} from "./OpenAiCodexAuthManager.js";
import {
  CODEX_CONDENSE_MODEL,
  getCodexModelCapabilities,
  getEndpointCaps,
  isCodexModelServedOnChatgptBackend,
  listCodexModels,
  resolveCodexEffectiveModel,
  resolveCodexReasoningEffort,
} from "../../../core/model/providers/codex/models.js";
import {
  buildCodexClientCacheKey,
  createOpenAiResponsesClient,
  getCodexEndpointConfig,
} from "../../../core/model/providers/codex/openaiClient.js";
import {
  buildCodexEndpointRequestBody,
  summarizeCodexInput,
  summarizeCodexRequestInput,
  translateCodexMessages,
  translateCodexTools,
  type CodexRequestBody,
} from "../../../core/model/providers/codex/translation.js";
import {
  CodexStreamError,
  parseCodexResponseStreamEvents,
} from "../../../core/model/providers/codex/streamParser.js";
import {
  buildCodexAuthRequiredError,
  buildCodexContextWindowExceededError,
  buildCodexUsageLimitExhaustedError,
  CodexRequestError,
  createCodexRequestError,
  getCodexErrorHandlingAction,
  toCodexRequestError,
  type CodexErrorShape,
} from "../../../core/model/providers/codex/errors.js";

// ── Provider ──

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";
  readonly condenseModel = CODEX_CONDENSE_MODEL;

  private authManager: OpenAiCodexAuthManager;
  private sessionId: string;
  private log: (msg: string) => void;
  private clients = new Map<string, OpenAI>();
  /**
   * Auth method of the most recent resolution, cached so the (synchronous)
   * listModels() can hide models the active backend doesn't serve. Undefined
   * until the first auth resolution; treated as OAuth-like (the common case)
   * for filtering.
   */
  private lastResolvedAuthMethod: OpenAiCodexAuthMethod | undefined;

  constructor(
    authManager?: OpenAiCodexAuthManager,
    log?: (msg: string) => void,
  ) {
    this.authManager = authManager ?? openAiCodexAuthManager;
    this.sessionId = randomUUID();
    this.log = log ?? (() => {});
    // Warm the auth-method cache so listModels() filters correctly before the
    // first request (API-key users keep the full model list; OAuth users get
    // only the ChatGPT-backend-served subset).
    void this.authManager
      .getPreferredAuthMethod()
      .then((method) => {
        if (method) this.lastResolvedAuthMethod = method;
      })
      .catch(() => {});
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated();
  }

  getCapabilities(model: string): ModelCapabilities {
    return getCodexModelCapabilities(
      model,
      this.lastResolvedAuthMethod ?? "oauth",
    );
  }

  listModels(): ModelInfo[] {
    const authMethod = this.lastResolvedAuthMethod ?? "oauth";
    const all = listCodexModels(this.id, authMethod);
    // The ChatGPT/Codex OAuth backend serves only a small current set; hide the
    // API-key-only models so users can't pick one that 400s. Default to the
    // OAuth-served subset until we've confirmed an API-key resolution (OAuth is
    // the common case). The runtime remap still protects anything that slips by.
    if (this.lastResolvedAuthMethod === "apiKey") return all;
    return all.filter((m) => isCodexModelServedOnChatgptBackend(m.id));
  }

  /**
   * When authed against the ChatGPT/Codex OAuth backend, transparently remap a
   * requested model the backend doesn't serve to one it does (gpt-5.5, or the
   * cheap model for mini/nano tiers). Without this, an unsupported model id
   * comes back as a bare `400 status code (no body)` and fails the run. The
   * API-key endpoint serves the full set, so it is never remapped.
   */
  private resolveEffectiveModel(
    model: string,
    auth: OpenAiCodexResolvedAuth,
    context: string,
  ): string {
    const resolution = resolveCodexEffectiveModel(model, auth.method);
    if (resolution.remapped) {
      this.log(
        `[codex] ${context}: model "${model}" is not served on the ChatGPT/Codex OAuth backend; using "${resolution.model}" instead`,
      );
    }
    return resolution.model;
  }

  private async getModelAuthOrThrow(): Promise<OpenAiCodexResolvedAuth> {
    const auth = await this.authManager.resolveModelAuth();
    if (!auth) {
      throw createCodexRequestError(buildCodexAuthRequiredError());
    }
    this.lastResolvedAuthMethod = auth.method;
    return auth;
  }

  private getClient(auth: OpenAiCodexResolvedAuth): OpenAI {
    const endpoint = getCodexEndpointConfig(auth, this.sessionId);
    const key = buildCodexClientCacheKey(
      {
        method: auth.method,
        accountId: auth.accountId,
        baseURL: endpoint.baseURL,
        bearerToken: auth.bearerToken,
      },
      (bearerToken) =>
        crypto
          .createHash("sha256")
          .update(bearerToken)
          .digest("hex")
          .slice(0, 12),
    );

    const existing = this.clients.get(key);
    if (existing) return existing;

    const client = createOpenAiResponsesClient(auth, endpoint);
    this.clients.set(key, client);
    return client;
  }

  private async rotateOAuthAuth(
    attemptedOAuthAccountIds: Set<string>,
    currentAuth: OpenAiCodexResolvedAuth,
  ): Promise<OpenAiCodexResolvedAuth | null> {
    if (currentAuth.method !== "oauth") return null;
    const currentAccountId = currentAuth.oauthAccountPoolId;
    if (!currentAccountId) return null;

    const ordered =
      await this.authManager.getOAuthRoundRobinAccountIds(currentAccountId);
    for (const accountId of ordered) {
      if (attemptedOAuthAccountIds.has(accountId)) continue;
      const auth =
        await this.authManager.resolveModelAuthForOAuthAccount(accountId);
      if (!auth || auth.method !== "oauth") continue;
      attemptedOAuthAccountIds.add(accountId);
      await this.authManager.setActiveOAuthAccount(accountId);
      this.log(
        `[codex] Rotated OAuth account: ${currentAuth.oauthAccountLabel ?? currentAccountId} -> ${auth.oauthAccountLabel ?? accountId}`,
      );
      return auth;
    }

    return null;
  }

  private buildUsageLimitExhaustedError(
    attemptedOAuthAccountIds: Set<string>,
    sourceError: Error & CodexErrorShape,
  ): CodexRequestError {
    return createCodexRequestError(
      buildCodexUsageLimitExhaustedError({
        attemptedOAuthAccountIds,
        sourceError,
      }),
    );
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const {
      model,
      systemPrompt,
      messages,
      tools,
      maxTokens,
      reasoningEffort: requestedEffort,
      cache,
      state,
      signal,
    } = request;

    const codexInput = translateCodexMessages(messages);
    const codexTools = tools ? translateCodexTools(tools) : undefined;

    // Log image presence in the translated input
    {
      const inputSummary = summarizeCodexInput(codexInput);
      for (const urlPreview of inputSummary.imageUrlPreviews) {
        this.log(`[codex:image] input_image found: url=${urlPreview}`);
      }
      this.log(
        `[codex] stream() translated ${messages.length} messages → ${codexInput.length} input items (${inputSummary.contentPartCount} content parts, ${inputSummary.imageCount} images)`,
      );
    }

    let auth = await this.getModelAuthOrThrow();
    const effectiveModel = this.resolveEffectiveModel(model, auth, "stream()");
    const reasoningEffort = resolveCodexReasoningEffort({
      modelId: effectiveModel,
      requestedEffort,
    });

    const attemptedOAuthAccountIds = new Set<string>();
    const refreshedOAuthAccountIds = new Set<string>();
    if (auth.method === "oauth" && auth.oauthAccountPoolId) {
      attemptedOAuthAccountIds.add(auth.oauthAccountPoolId);
    }

    while (true) {
      const requestBody = buildCodexEndpointRequestBody({
        model: effectiveModel,
        input: codexInput,
        instructions: systemPrompt,
        maxTokens,
        state,
        cache,
        reasoningEffort,
        tools: codexTools,
        caps: getEndpointCaps(auth),
      });

      // Log the request shape (not the full body — base64 data can be huge)
      {
        const inputSummary = summarizeCodexRequestInput(requestBody.input);
        const body = requestBody as unknown as Record<string, unknown>;
        this.log(
          `[codex] request: model=${requestBody.model} auth=${auth.method} input=${inputSummary} tools=${requestBody.tools?.length ?? 0} store=${requestBody.store} previousResponseId=${body.previous_response_id ?? "none"} cacheKey=${body.prompt_cache_key ?? "none"}`,
        );
      }

      const streamState = { outputStarted: false };
      try {
        const result = await this.executeStream(
          requestBody,
          auth,
          effectiveModel,
          signal,
          streamState,
        );
        yield* result;
        return;
      } catch (err) {
        const sdkErr = toCodexRequestError(err);

        const action = getCodexErrorHandlingAction({ auth, error: sdkErr });

        if (action === "refresh_oauth_auth") {
          const refreshAccountId = auth.oauthAccountPoolId;
          if (
            refreshAccountId &&
            refreshedOAuthAccountIds.has(refreshAccountId)
          ) {
            this.log(
              `[codex] OAuth auth failure persists after refresh for account ${auth.oauthAccountLabel ?? refreshAccountId}`,
            );
          } else {
            const refreshed = await this.authManager.forceRefreshModelAuth(
              "oauth",
              {
                oauthAccountPoolId: refreshAccountId,
              },
            );
            if (refreshAccountId) {
              refreshedOAuthAccountIds.add(refreshAccountId);
            }
            if (refreshed) {
              this.log("[codex] Auth failure, refreshed active OAuth account");
              auth = refreshed;
              continue;
            }
          }
        }

        if (action === "handle_oauth_usage_limit" && auth.oauthAccountPoolId) {
          await this.authManager.markOAuthUsageLimit(auth.oauthAccountPoolId);
          if (!streamState.outputStarted) {
            const nextAuth = await this.rotateOAuthAuth(
              attemptedOAuthAccountIds,
              auth,
            );
            if (nextAuth) {
              auth = nextAuth;
              continue;
            }
          }

          throw this.buildUsageLimitExhaustedError(
            attemptedOAuthAccountIds,
            sdkErr,
          );
        }

        if (action === "throw_context_window_exceeded") {
          throw createCodexRequestError(
            buildCodexContextWindowExceededError(sdkErr),
          );
        }

        throw sdkErr;
      }
    }
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const {
      model,
      systemPrompt,
      messages,
      maxTokens,
      temperature: _temperature,
      reasoningEffort: requestedEffort,
      cache,
      state,
    } = request;

    const codexInput = translateCodexMessages(messages);

    let auth = await this.getModelAuthOrThrow();
    const effectiveModel = this.resolveEffectiveModel(
      model,
      auth,
      "complete()",
    );
    const reasoningEffort = resolveCodexReasoningEffort({
      modelId: effectiveModel,
      requestedEffort,
    });

    const attemptedOAuthAccountIds = new Set<string>();
    const refreshedOAuthAccountIds = new Set<string>();
    if (auth.method === "oauth" && auth.oauthAccountPoolId) {
      attemptedOAuthAccountIds.add(auth.oauthAccountPoolId);
    }

    while (true) {
      const requestBody = buildCodexEndpointRequestBody({
        model: effectiveModel,
        input: codexInput,
        instructions: systemPrompt,
        maxTokens,
        state,
        cache,
        reasoningEffort,
        caps: getEndpointCaps(auth),
      });

      // Log request shape (mirrors stream() logging)
      {
        const inputSummary = summarizeCodexRequestInput(requestBody.input);
        const body = requestBody as unknown as Record<string, unknown>;
        this.log(
          `[codex] complete(): model=${requestBody.model} auth=${auth.method} input=${inputSummary} tools=${requestBody.tools?.length ?? 0} store=${requestBody.store} reasoning=${JSON.stringify(body.reasoning ?? null)}`,
        );
      }

      let text = "";

      try {
        const result = await collectCoreModelCompleteResult(
          await this.executeStream(requestBody, auth, effectiveModel),
        );
        text = result.text;
        return result;
      } catch (err) {
        const sdkErr = toCodexRequestError(err);

        this.log(
          `[codex] complete() error: status=${sdkErr.status ?? "none"} message=${sdkErr.message} rawCode=${sdkErr.rawCode ?? "none"} body=${JSON.stringify(sdkErr.body ?? null)}`,
        );

        const action = getCodexErrorHandlingAction({ auth, error: sdkErr });

        if (action === "refresh_oauth_auth") {
          const refreshAccountId = auth.oauthAccountPoolId;
          if (
            refreshAccountId &&
            refreshedOAuthAccountIds.has(refreshAccountId)
          ) {
            this.log(
              `[codex] complete() OAuth auth failure persists after refresh for account ${auth.oauthAccountLabel ?? refreshAccountId}`,
            );
          } else {
            const refreshed = await this.authManager.forceRefreshModelAuth(
              "oauth",
              {
                oauthAccountPoolId: refreshAccountId,
              },
            );
            if (refreshAccountId) {
              refreshedOAuthAccountIds.add(refreshAccountId);
            }
            if (refreshed) {
              this.log(
                "[codex] complete() auth failure, refreshed OAuth token",
              );
              auth = refreshed;
              continue;
            }
          }
        }

        if (action === "handle_oauth_usage_limit" && auth.oauthAccountPoolId) {
          await this.authManager.markOAuthUsageLimit(auth.oauthAccountPoolId);
          const nextAuth = await this.rotateOAuthAuth(
            attemptedOAuthAccountIds,
            auth,
          );
          if (nextAuth) {
            if (text.length > 0) {
              this.log(
                "[codex] complete() encountered usage-limit 429 after partial output; retrying with next OAuth account and discarding partial text",
              );
            }
            auth = nextAuth;
            continue;
          }
          throw this.buildUsageLimitExhaustedError(
            attemptedOAuthAccountIds,
            sdkErr,
          );
        }

        if (action === "throw_context_window_exceeded") {
          throw createCodexRequestError(
            buildCodexContextWindowExceededError(sdkErr),
          );
        }

        throw sdkErr;
      }
    }
  }

  // ── Internal streaming parser ──

  private async *processResponseStreamEvents(
    events: AsyncIterable<Record<string, unknown>>,
    state?: { outputStarted: boolean },
  ): AsyncGenerator<ProviderStreamEvent> {
    try {
      yield* parseCodexResponseStreamEvents(events, state, {
        createThinkingId: randomUUID,
      });
    } catch (error) {
      if (error instanceof CodexStreamError) {
        throw createCodexRequestError({
          message: error.message,
          rawMessage: error.rawMessage,
          body: error.body,
        });
      }
      throw error;
    }
  }

  private async executeStream(
    requestBody: CodexRequestBody,
    auth: OpenAiCodexResolvedAuth,
    _model: string,
    signal?: AbortSignal,
    streamState?: { outputStarted: boolean },
  ): Promise<AsyncGenerator<ProviderStreamEvent>> {
    try {
      const client = this.getClient(auth);
      const stream = await client.responses.create(requestBody, {
        signal,
        maxRetries: 0,
      });

      return this.processResponseStreamEvents(
        stream as AsyncIterable<Record<string, unknown>>,
        streamState,
      );
    } catch (error) {
      throw toCodexRequestError(error);
    }
  }
}
