import {
  buildCodexAuthRequiredError,
  buildCodexUsageLimitExhaustedError,
  createCodexRequestError,
  type CodexErrorShape,
  type CodexRequestError,
} from "./errors.js";
import type { CodexResolvedAuthForClient } from "./openaiClient.js";

export type CodexCredentialPurpose =
  | "stream"
  | "complete"
  | "catalog"
  | "authStatus"
  | "nativeWeb";

export interface CodexResolvedAuth extends CodexResolvedAuthForClient {
  /** Host-owned identity for one account in an OAuth fallback pool. */
  oauthAccountPoolId?: string;
  /** Safe host-owned account label used only for diagnostics. */
  oauthAccountLabel?: string;
  /** Safe host-owned account email used only for diagnostics. */
  oauthAccountEmail?: string;
}

export interface CodexCredentialRequest<TContext> {
  context: TContext;
  modelId: string;
  purpose: CodexCredentialPurpose;
}

export interface CodexRefreshCredentialRequest<
  TContext,
> extends CodexCredentialRequest<TContext> {
  previousAuth: CodexResolvedAuth;
}

export interface CodexOAuthAccountRequest<
  TContext,
> extends CodexCredentialRequest<TContext> {
  accountId: string;
}

export interface CodexOAuthAccountPool<TContext> {
  markUsageLimit(request: CodexOAuthAccountRequest<TContext>): Promise<void>;
  listFallbackAccountIds(
    request: CodexOAuthAccountRequest<TContext>,
  ): Promise<readonly string[]>;
  resolveAccount(
    request: CodexOAuthAccountRequest<TContext>,
  ): Promise<CodexResolvedAuth | null>;
  activateAccount(request: CodexOAuthAccountRequest<TContext>): Promise<void>;
}

/**
 * Host-owned Codex credential boundary. The context key is required so an
 * embedding host can bind every resolution, refresh, and account-pool action
 * to its authenticated principal/request without ambient user state.
 */
export interface CodexCredentialProvider<TContext> {
  resolveAuth(
    request: CodexCredentialRequest<TContext>,
  ): Promise<CodexResolvedAuth | null>;
  refreshAuth?(
    request: CodexRefreshCredentialRequest<TContext>,
  ): Promise<CodexResolvedAuth | null>;
  oauthAccounts?: CodexOAuthAccountPool<TContext>;
}

export interface CreateCodexCredentialSessionOptions<TContext> {
  provider: CodexCredentialProvider<TContext>;
  request: CodexCredentialRequest<TContext>;
  /** Absolute bound for refreshes when the host cannot supply a pool ID. */
  maxOAuthRefreshAttempts?: number;
}

export interface CodexOAuthRotationResult {
  rotated: boolean;
  previousAuth?: CodexResolvedAuth;
}

const DEFAULT_MAX_OAUTH_REFRESH_ATTEMPTS = 3;

/**
 * Per-request credential state for Codex execution. It owns bounded refresh
 * and account fallback bookkeeping while the host retains credentials,
 * principal policy, usage-limit persistence, and active-account selection.
 */
export class CodexCredentialSession<TContext> {
  private currentAuth: CodexResolvedAuth;
  private readonly attemptedOAuthAccountIds = new Set<string>();
  private readonly refreshedOAuthAccountIds = new Set<string>();
  private oauthRefreshAttempts = 0;

  private constructor(
    private readonly provider: CodexCredentialProvider<TContext>,
    private readonly request: CodexCredentialRequest<TContext>,
    private readonly maxOAuthRefreshAttempts: number,
    auth: CodexResolvedAuth,
  ) {
    this.currentAuth = auth;
    if (auth.method === "oauth" && auth.oauthAccountPoolId) {
      this.attemptedOAuthAccountIds.add(auth.oauthAccountPoolId);
    }
  }

  static async create<TContext>(
    options: CreateCodexCredentialSessionOptions<TContext>,
  ): Promise<CodexCredentialSession<TContext>> {
    const maxOAuthRefreshAttempts =
      options.maxOAuthRefreshAttempts ?? DEFAULT_MAX_OAUTH_REFRESH_ATTEMPTS;
    if (
      !Number.isSafeInteger(maxOAuthRefreshAttempts) ||
      maxOAuthRefreshAttempts < 0
    ) {
      throw new Error("maxOAuthRefreshAttempts must be a non-negative integer");
    }

    const auth = await options.provider.resolveAuth(options.request);
    if (!auth) {
      throw createCodexRequestError(buildCodexAuthRequiredError());
    }
    return new CodexCredentialSession(
      options.provider,
      options.request,
      maxOAuthRefreshAttempts,
      auth,
    );
  }

  get auth(): CodexResolvedAuth {
    return this.currentAuth;
  }

  get attemptedAccountIds(): readonly string[] {
    return [...this.attemptedOAuthAccountIds];
  }

  /** Refreshes each identified OAuth account at most once per request. */
  async refreshOAuth(): Promise<boolean> {
    const auth = this.currentAuth;
    if (
      auth.method !== "oauth" ||
      !auth.canRefresh ||
      !this.provider.refreshAuth ||
      this.oauthRefreshAttempts >= this.maxOAuthRefreshAttempts
    ) {
      return false;
    }

    const accountId = auth.oauthAccountPoolId;
    if (accountId && this.refreshedOAuthAccountIds.has(accountId)) {
      return false;
    }

    this.oauthRefreshAttempts += 1;
    if (accountId) {
      this.refreshedOAuthAccountIds.add(accountId);
    }
    const refreshed = await this.provider.refreshAuth({
      ...this.request,
      previousAuth: auth,
    });
    if (
      !refreshed ||
      refreshed.method !== "oauth" ||
      (accountId && refreshed.oauthAccountPoolId !== accountId)
    ) {
      return false;
    }
    this.currentAuth = refreshed;
    return true;
  }

  /**
   * Records the current account's usage limit and optionally rotates to the
   * first resolvable, not-yet-attempted OAuth account selected by the host.
   */
  async handleOAuthUsageLimit(options: {
    allowRotation: boolean;
  }): Promise<CodexOAuthRotationResult> {
    const auth = this.currentAuth;
    const accountId = auth.oauthAccountPoolId;
    const accounts = this.provider.oauthAccounts;
    if (auth.method !== "oauth" || !accountId || !accounts) {
      return { rotated: false };
    }

    const accountRequest = { ...this.request, accountId };
    await accounts.markUsageLimit(accountRequest);
    if (!options.allowRotation) {
      return { rotated: false };
    }

    const candidates = await accounts.listFallbackAccountIds(accountRequest);
    for (const candidateId of candidates) {
      if (this.attemptedOAuthAccountIds.has(candidateId)) continue;
      const candidateRequest = {
        ...this.request,
        accountId: candidateId,
      };
      const nextAuth = await accounts.resolveAccount(candidateRequest);
      if (
        !nextAuth ||
        nextAuth.method !== "oauth" ||
        nextAuth.oauthAccountPoolId !== candidateId
      ) {
        continue;
      }
      this.attemptedOAuthAccountIds.add(candidateId);
      await accounts.activateAccount(candidateRequest);
      const previousAuth = this.currentAuth;
      this.currentAuth = nextAuth;
      return { rotated: true, previousAuth };
    }

    return { rotated: false };
  }

  buildUsageLimitExhaustedError(
    sourceError: CodexErrorShape,
  ): CodexRequestError {
    return createCodexRequestError(
      buildCodexUsageLimitExhaustedError({
        attemptedOAuthAccountIds: this.attemptedAccountIds,
        sourceError,
      }),
    );
  }
}
