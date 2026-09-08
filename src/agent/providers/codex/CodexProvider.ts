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
import type { AgentPrincipal } from "@agentlink/core/turn-contracts";
import {
  agentLinkFetch,
  withAgentLinkHttpActivity,
} from "../../../util/httpDispatcher.js";
import { saveOutputTempFile } from "../../../util/outputFilter.js";

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
import { collectCoreModelCompleteResult } from "@agentlink/core/model-runtime";
import {
  openAiCodexAuthManager,
  type OpenAiCodexAuthManager,
  type OpenAiCodexAuthMethod,
  type OpenAiCodexResolvedAuth,
} from "./OpenAiCodexAuthManager.js";
import {
  CODEX_CONDENSE_MODEL,
  CodexCredentialSession,
  CodexResponsesAuthError,
  CodexResponsesStreamAbortedError,
  buildCodexClientCacheKey,
  buildCodexAstraOAuthBodylessError,
  buildCodexAuthRequiredError,
  buildCodexContextWindowExceededError,
  buildCodexEndpointRequestBody,
  createCodexRequestError,
  createOpenAiResponsesClient,
  executeCodexResponsesStream,
  getCodexErrorHandlingAction,
  getCodexUnavailableModelFallback,
  getCodexModelCapabilities,
  getCodexModelMigration,
  getCodexEndpointConfig,
  getEndpointCaps,
  usesCodexResponsesLite,
  isCodexBodylessBadRequest,
  isCodexModelNotFoundError,
  isCodexModelServedOnChatgptBackend,
  isCodexTextVerbosityRejectionError,
  listCodexModels,
  resolveCodexEffectiveModel,
  resolveCodexReasoningEffort,
  resolveCodexTextVerbosity,
  summarizeCodexInput,
  summarizeCodexRequestInput,
  toCodexRequestError,
  translateCodexMessages,
  translateCodexTools,
  type CodexCredentialProvider,
  type CodexErrorShape,
  type CodexRequestBody,
} from "@agentlink/core/codex";

import {
  canUseCodexStandaloneWeb,
  executeCodexStandaloneWeb,
} from "../../../core/model/providers/codex/standaloneWeb.js";
import type { CoreWebAccessSettings } from "@agentlink/protocol/web-access-policy";
import type { CoreWebToolKind } from "@agentlink/protocol/web-activity";

interface CodexProviderCredentialContext {
  principal: AgentPrincipal;
  authContext: unknown;
}

const EXTENSION_CODEX_PRINCIPAL: AgentPrincipal = {
  tenantId: "agentlink-vscode",
  subjectId: "local-user",
};

// ── Provider ──

export class CodexProvider implements ModelProvider {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";
  readonly condenseModel = CODEX_CONDENSE_MODEL;

  private authManager: OpenAiCodexAuthManager;
  private credentialProvider: CodexCredentialProvider<CodexProviderCredentialContext>;
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
  private getTextVerbositySetting: () => string | undefined;

  constructor(
    authManager?: OpenAiCodexAuthManager,
    log?: (msg: string) => void,
    options?: {
      /**
       * Live reader for the `agentlink.codex.textVerbosity` setting; called
       * per stream so configuration changes apply without a reload.
       */
      getTextVerbositySetting?: () => string | undefined;
    },
  ) {
    this.authManager = authManager ?? openAiCodexAuthManager;
    this.credentialProvider =
      typeof this.authManager.createCredentialProvider === "function"
        ? this.authManager.createCredentialProvider()
        : {
            resolveAuth: async () => await this.authManager.resolveModelAuth(),
            refreshAuth: async ({ previousAuth }) =>
              await this.authManager.forceRefreshModelAuth(
                previousAuth.method,
                {
                  oauthAccountPoolId: previousAuth.oauthAccountPoolId,
                },
              ),
            oauthAccounts: {
              markUsageLimit: async ({ accountId }) =>
                await this.authManager.markOAuthUsageLimit(accountId),
              listFallbackAccountIds: async ({ accountId }) =>
                await this.authManager.getOAuthRoundRobinAccountIds(accountId),
              resolveAccount: async ({ accountId }) =>
                await this.authManager.resolveModelAuthForOAuthAccount(
                  accountId,
                ),
              activateAccount: async ({ accountId }) => {
                await this.authManager.setActiveOAuthAccount(accountId);
              },
            },
          };
    this.sessionId = randomUUID();
    this.log = log ?? (() => {});
    this.getTextVerbositySetting =
      options?.getTextVerbositySetting ?? (() => undefined);
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
    const authMethod = await this.authManager.getPreferredAuthMethod();
    if (authMethod) this.lastResolvedAuthMethod = authMethod;
    return authMethod !== null;
  }

  getCatalogAuthAction() {
    return { kind: "oauth" as const, providerId: this.id };
  }

  getCapabilities(model: string): ModelCapabilities {
    return getCodexModelCapabilities(
      model,
      this.lastResolvedAuthMethod ?? "oauth",
    );
  }

  supportsHostedTools(model: string): boolean {
    return !(
      this.lastResolvedAuthMethod !== undefined &&
      usesCodexResponsesLite(model, this.lastResolvedAuthMethod)
    );
  }

  async getRequestCapabilities(model: string): Promise<ModelCapabilities> {
    const authMethod = await this.authManager.getPreferredAuthMethod();
    if (authMethod) this.lastResolvedAuthMethod = authMethod;
    return getCodexModelCapabilities(model, authMethod ?? "oauth");
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

  getModelMigration(model: string): string | undefined {
    return getCodexModelMigration(model);
  }

  /**
   * When authed against the ChatGPT/Codex OAuth backend, transparently remap a
   * requested model the backend doesn't serve to one it does (the default, or
   * the cheap model for mini/nano tiers). Without this, an unsupported model id
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

  async executeNativeWebTool(request: {
    model: string;
    kind: CoreWebToolKind;
    input: Record<string, unknown>;
    settings: CoreWebAccessSettings;
    signal?: AbortSignal;
  }): Promise<unknown | null> {
    const auth = await this.getModelAuthOrThrow();
    if (!canUseCodexStandaloneWeb(auth)) return null;
    const model = this.resolveEffectiveModel(
      request.model,
      auth,
      `standalone web ${request.kind}`,
    );
    return await executeCodexStandaloneWeb({
      auth,
      sessionId: this.sessionId,
      model,
      operation: request.kind,
      input: request.input,
      settings: request.settings,
      signal: request.signal,
      retainOutput: saveOutputTempFile,
    });
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

    const client = createOpenAiResponsesClient(auth, endpoint, {
      fetch: agentLinkFetch,
    });
    this.clients.set(key, client);
    return client;
  }

  private createCredentialSession(
    modelId: string,
    purpose: "stream" | "complete",
  ): Promise<CodexCredentialSession<CodexProviderCredentialContext>> {
    return CodexCredentialSession.create({
      provider: this.credentialProvider,
      request: {
        context: {
          principal: EXTENSION_CODEX_PRINCIPAL,
          authContext: undefined,
        },
        modelId,
        purpose,
      },
    });
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const {
      model,
      systemPrompt,
      messages,
      tools,
      hostedTools,
      maxTokens,
      reasoningEffort: requestedEffort,
      reasoningMode,
      cache,
      state,
      signal,
      onProviderRequestAttempt,
      onTransportActivity,
    } = request;

    const routingHint = request.providerHints?.codex;
    const codexInput = translateCodexMessages(messages, {
      useProviderReplay: !state?.previousResponseId,
    });
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

    const credentialSession = await this.createCredentialSession(
      model,
      "stream",
    );
    let auth = credentialSession.auth;
    this.lastResolvedAuthMethod = auth.method;
    let effectiveModel = this.resolveEffectiveModel(model, auth, "stream()");
    let reasoningEffort = resolveCodexReasoningEffort({
      modelId: effectiveModel,
      authMethod: auth.method,
      requestedEffort,
    });

    let textVerbosityRejected = false;
    const textVerbositySetting = this.getTextVerbositySetting();
    let textVerbosity = resolveCodexTextVerbosity(
      effectiveModel,
      textVerbositySetting,
    );

    let unavailableModelFallbackAttempted = false;

    while (true) {
      const streamState = { outputStarted: false };
      try {
        const requestBody = buildCodexEndpointRequestBody({
          model: effectiveModel,
          input: codexInput,
          instructions: systemPrompt,
          maxTokens,
          state,
          cache,
          reasoningEffort,
          reasoningMode,
          textVerbosity,
          tools: codexTools,
          hostedTools,
          caps: getEndpointCaps(auth),
          useResponsesLite: usesCodexResponsesLite(effectiveModel, auth.method),
        });

        // Log the request shape (not the full body — base64 data can be huge)
        {
          const inputSummary = summarizeCodexRequestInput(requestBody.input);
          const body = requestBody as unknown as Record<string, unknown>;
          this.log(
            `[codex] request: model=${requestBody.model} auth=${auth.method} input=${inputSummary} tools=${requestBody.tools?.length ?? 0} store=${requestBody.store} previousResponseId=${body.previous_response_id ?? "none"} cacheKey=${body.prompt_cache_key ?? "none"} textVerbosity=${(body.text as { verbosity?: string } | undefined)?.verbosity ?? "none"}`,
          );
        }

        const result = await this.executeStream(
          requestBody,
          auth,
          effectiveModel,
          signal,
          streamState,
          onTransportActivity,
          routingHint,
          onProviderRequestAttempt,
        );
        yield* result;
        return;
      } catch (err) {
        if (
          err instanceof CodexResponsesStreamAbortedError ||
          signal?.aborted
        ) {
          const aborted = new Error("Codex Responses stream aborted");
          aborted.name = "AbortError";
          throw aborted;
        }
        const sdkErr = toCodexRequestError(err);
        this.logCodexRequestError("stream()", sdkErr);

        const unavailableModelFallback =
          getCodexUnavailableModelFallback(effectiveModel);
        if (
          !unavailableModelFallbackAttempted &&
          !streamState.outputStarted &&
          unavailableModelFallback &&
          isCodexModelNotFoundError(sdkErr)
        ) {
          unavailableModelFallbackAttempted = true;
          this.log(
            `[codex] stream(): model "${effectiveModel}" is unavailable; retrying with "${unavailableModelFallback}"`,
          );
          yield {
            type: "model_fallback",
            requestedModel: effectiveModel,
            effectiveModel: unavailableModelFallback,
          };
          effectiveModel = unavailableModelFallback;
          reasoningEffort = resolveCodexReasoningEffort({
            modelId: effectiveModel,
            authMethod: auth.method,
            requestedEffort,
          });
          textVerbosity = textVerbosityRejected
            ? undefined
            : resolveCodexTextVerbosity(effectiveModel, textVerbositySetting);
          continue;
        }

        if (
          textVerbosity &&
          !streamState.outputStarted &&
          isCodexTextVerbosityRejectionError(sdkErr)
        ) {
          textVerbosityRejected = true;
          textVerbosity = undefined;
          this.log(
            `[codex] stream(): endpoint rejected text.verbosity for "${effectiveModel}"; retrying without it`,
          );
          continue;
        }

        const action = getCodexErrorHandlingAction({ auth, error: sdkErr });

        if (action === "refresh_oauth_auth") {
          if (await credentialSession.refreshOAuth()) {
            this.log("[codex] Auth failure, refreshed active OAuth account");
            auth = credentialSession.auth;
            continue;
          }
          this.log(
            `[codex] OAuth auth failure persists after refresh for account ${auth.oauthAccountLabel ?? auth.oauthAccountPoolId ?? "unknown"}`,
          );
        }

        if (action === "handle_oauth_usage_limit" && auth.oauthAccountPoolId) {
          const rotation = await credentialSession.handleOAuthUsageLimit({
            allowRotation: !streamState.outputStarted,
          });
          if (rotation.rotated) {
            auth = credentialSession.auth;
            this.log(
              `[codex] Rotated OAuth account: ${rotation.previousAuth?.oauthAccountLabel ?? rotation.previousAuth?.oauthAccountPoolId ?? "unknown"} -> ${auth.oauthAccountLabel ?? auth.oauthAccountPoolId ?? "unknown"}`,
            );
            continue;
          }

          throw credentialSession.buildUsageLimitExhaustedError(sdkErr);
        }

        if (action === "throw_context_window_exceeded") {
          throw createCodexRequestError(
            buildCodexContextWindowExceededError(sdkErr),
          );
        }

        throw this.decorateAstraOAuthBodylessError(
          sdkErr,
          effectiveModel,
          auth.method,
        );
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
      reasoningMode,
      cache,
      state,
      signal,
      onProviderRequestAttempt,
    } = request;

    const codexInput = translateCodexMessages(messages, {
      useProviderReplay: !state?.previousResponseId,
    });

    const credentialSession = await this.createCredentialSession(
      model,
      "complete",
    );
    let auth = credentialSession.auth;
    this.lastResolvedAuthMethod = auth.method;
    let effectiveModel = this.resolveEffectiveModel(model, auth, "complete()");
    let reasoningEffort = resolveCodexReasoningEffort({
      modelId: effectiveModel,
      authMethod: auth.method,
      requestedEffort,
    });

    let unavailableModelFallbackAttempted = false;

    while (true) {
      const requestBody = buildCodexEndpointRequestBody({
        model: effectiveModel,
        input: codexInput,
        instructions: systemPrompt,
        maxTokens,
        state,
        cache,
        reasoningEffort,
        reasoningMode,
        caps: getEndpointCaps(auth),
        useResponsesLite: usesCodexResponsesLite(effectiveModel, auth.method),
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
          await this.executeStream(
            requestBody,
            auth,
            effectiveModel,
            signal,
            undefined,
            request.onTransportActivity,
            request.providerHints?.codex,
            onProviderRequestAttempt,
          ),
        );
        text = result.text;
        return result;
      } catch (err) {
        const sdkErr = toCodexRequestError(err);

        this.logCodexRequestError("complete()", sdkErr);

        const unavailableModelFallback =
          getCodexUnavailableModelFallback(effectiveModel);
        if (
          !unavailableModelFallbackAttempted &&
          unavailableModelFallback &&
          isCodexModelNotFoundError(sdkErr)
        ) {
          unavailableModelFallbackAttempted = true;
          this.log(
            `[codex] complete(): model "${effectiveModel}" is unavailable; retrying with "${unavailableModelFallback}"`,
          );
          effectiveModel = unavailableModelFallback;
          reasoningEffort = resolveCodexReasoningEffort({
            modelId: effectiveModel,
            authMethod: auth.method,
            requestedEffort,
          });
          continue;
        }

        const action = getCodexErrorHandlingAction({ auth, error: sdkErr });

        if (action === "refresh_oauth_auth") {
          if (await credentialSession.refreshOAuth()) {
            this.log("[codex] complete() auth failure, refreshed OAuth token");
            auth = credentialSession.auth;
            continue;
          }
          this.log(
            `[codex] complete() OAuth auth failure persists after refresh for account ${auth.oauthAccountLabel ?? auth.oauthAccountPoolId ?? "unknown"}`,
          );
        }

        if (action === "handle_oauth_usage_limit" && auth.oauthAccountPoolId) {
          const rotation = await credentialSession.handleOAuthUsageLimit({
            allowRotation: true,
          });
          if (rotation.rotated) {
            if (text.length > 0) {
              this.log(
                "[codex] complete() encountered usage-limit 429 after partial output; retrying with next OAuth account and discarding partial text",
              );
            }
            auth = credentialSession.auth;
            this.log(
              `[codex] Rotated OAuth account: ${rotation.previousAuth?.oauthAccountLabel ?? rotation.previousAuth?.oauthAccountPoolId ?? "unknown"} -> ${auth.oauthAccountLabel ?? auth.oauthAccountPoolId ?? "unknown"}`,
            );
            continue;
          }
          throw credentialSession.buildUsageLimitExhaustedError(sdkErr);
        }

        if (action === "throw_context_window_exceeded") {
          throw createCodexRequestError(
            buildCodexContextWindowExceededError(sdkErr),
          );
        }

        throw this.decorateAstraOAuthBodylessError(
          sdkErr,
          effectiveModel,
          auth.method,
        );
      }
    }
  }

  private decorateAstraOAuthBodylessError(
    error: Error & CodexErrorShape,
    model: string,
    authMethod: OpenAiCodexAuthMethod,
  ): Error & CodexErrorShape {
    if (
      model !== "gpt-6-astra" ||
      authMethod !== "oauth" ||
      !isCodexBodylessBadRequest(error)
    ) {
      return error;
    }
    return createCodexRequestError(buildCodexAstraOAuthBodylessError(error));
  }

  private logCodexRequestError(
    context: string,
    error: Error & CodexErrorShape,
  ): void {
    const metadata = error.metadata;
    this.log(
      `[codex] ${context} error: status=${error.status ?? "none"} message=${error.message} rawCode=${error.rawCode ?? "none"} requestId=${metadata?.requestId ?? "none"} cfRay=${metadata?.cfRay ?? "none"} body=${JSON.stringify(error.body ?? null)}`,
    );
  }

  private async executeStream(
    requestBody: CodexRequestBody,
    auth: OpenAiCodexResolvedAuth,
    _model: string,
    signal?: AbortSignal,
    streamState?: { outputStarted: boolean },
    onTransportActivity?: StreamRequest["onTransportActivity"],
    routingHint?: NonNullable<StreamRequest["providerHints"]>["codex"],
    onProviderRequestAttempt?: StreamRequest["onProviderRequestAttempt"],
  ): Promise<AsyncGenerator<ProviderStreamEvent>> {
    try {
      const stream = executeCodexResponsesStream({
        client: this.getClient(auth),
        body: requestBody,
        authMethod: auth.method,
        routing:
          routingHint?.sessionId && routingHint.turnState
            ? {
                sessionId: routingHint.sessionId,
                authIdentity: JSON.stringify([
                  auth.method,
                  auth.accountId,
                  auth.oauthAccountPoolId,
                  auth.bearerToken,
                ]),
                turnState: routingHint.turnState,
              }
            : undefined,
        signal,
        onProviderRequestAttempt,
        parserState: streamState,
        parserOptions: { createThinkingId: randomUUID },
        onTransportActivity,
        runRequest: (operation) =>
          withAgentLinkHttpActivity(onTransportActivity, operation),
      });
      return (async function* () {
        try {
          yield* stream;
        } catch (error) {
          if (error instanceof CodexResponsesStreamAbortedError) throw error;
          throw toCodexRequestError(
            error instanceof CodexResponsesAuthError ? error.cause : error,
          );
        }
      })();
    } catch (error) {
      throw toCodexRequestError(
        error instanceof CodexResponsesAuthError ? error.cause : error,
      );
    }
  }
}
