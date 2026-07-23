import type { CoreModelAuthMethod } from "../core/modelAuth.js";
import { normalizeBrowserGatewayModelCredentialProviderId } from "./browserGatewayModelProviderIds.js";

export type BrowserGatewayModelCredentialStatus =
  | {
      state: "not_required";
      providerId: string;
    }
  | {
      state: "missing";
      providerId?: string;
      reason: string;
    }
  | {
      state: "ready";
      providerId: string;
      method: CoreModelAuthMethod;
      modelScopes: string[];
      grantedByOwnerId: string;
      grantedAt: number;
      expiresAt?: number;
      accountLabel?: string;
    }
  | {
      state: "refresh_required";
      providerId: string;
      method: CoreModelAuthMethod;
      grantedByOwnerId: string;
      grantedAt: number;
      expiredAt: number;
      accountLabel?: string;
      reason: string;
    };

export interface BrowserGatewayModelCredentialGrantRequest {
  providerId: string;
  method: CoreModelAuthMethod;
  bearerToken: string;
  grantedByOwnerId: string;
  grantedByOwnerGenerationId: string;
  modelScopes: string[];
  helperGenerationId: string;
  ttlMs?: number;
  accountId?: string;
  accountLabel?: string;
  canRefresh?: boolean;
  now: number;
}

export interface BrowserGatewayModelCredentialRecord {
  providerId: string;
  method: CoreModelAuthMethod;
  bearerToken: string;
  grantedByOwnerId: string;
  grantedByOwnerGenerationId: string;
  modelScopes: string[];
  grantedAt: number;
  expiresAt?: number;
  accountId?: string;
  accountLabel?: string;
  canRefresh: boolean;
}

export class BrowserGatewayModelCredentialCache {
  private readonly credentialsByOwnerAndProvider = new Map<
    string,
    BrowserGatewayModelCredentialRecord
  >();

  grant(
    request: BrowserGatewayModelCredentialGrantRequest,
  ): BrowserGatewayModelCredentialRecord {
    if (!request.modelScopes.length) {
      throw new Error("browser_gateway_model_credential_missing_scope");
    }
    const providerId = normalizeBrowserGatewayModelCredentialProviderId(
      request.providerId,
    );
    const bearerToken = request.bearerToken.trim();
    const grantedByOwnerId = request.grantedByOwnerId.trim();
    const grantedByOwnerGenerationId =
      request.grantedByOwnerGenerationId.trim();
    const modelScopes = request.modelScopes
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (
      !providerId ||
      !bearerToken ||
      !grantedByOwnerId ||
      !grantedByOwnerGenerationId ||
      !modelScopes.length
    ) {
      throw new Error("browser_gateway_model_credential_invalid_grant");
    }

    const ttlMs =
      typeof request.ttlMs === "number" && Number.isFinite(request.ttlMs)
        ? Math.max(5_000, request.ttlMs)
        : undefined;
    const credential: BrowserGatewayModelCredentialRecord = {
      providerId,
      method: request.method,
      bearerToken,
      grantedByOwnerId,
      grantedByOwnerGenerationId,
      modelScopes,
      grantedAt: request.now,
      expiresAt: ttlMs === undefined ? undefined : request.now + ttlMs,
      accountId: request.accountId?.trim() || undefined,
      accountLabel: request.accountLabel?.trim() || undefined,
      canRefresh: request.canRefresh === true,
    };
    this.credentialsByOwnerAndProvider.set(
      this.getCacheKey(grantedByOwnerId, providerId),
      credential,
    );
    return credential;
  }

  clear(params: {
    grantedByOwnerId: string;
    grantedByOwnerGenerationId: string;
    providerId?: string;
  }): BrowserGatewayModelCredentialRecord | null {
    const grantedByOwnerId = params.grantedByOwnerId.trim();
    const grantedByOwnerGenerationId = params.grantedByOwnerGenerationId.trim();
    if (!grantedByOwnerId || !grantedByOwnerGenerationId) return null;

    if (params.providerId) {
      const providerId = normalizeBrowserGatewayModelCredentialProviderId(
        params.providerId,
      );
      if (!providerId) return null;
      const cacheKey = this.getCacheKey(grantedByOwnerId, providerId);
      const previous = this.credentialsByOwnerAndProvider.get(cacheKey) ?? null;
      if (previous?.grantedByOwnerGenerationId !== grantedByOwnerGenerationId) {
        return null;
      }
      this.credentialsByOwnerAndProvider.delete(cacheKey);
      return previous;
    }

    let firstRemoved: BrowserGatewayModelCredentialRecord | null = null;
    for (const [cacheKey, credential] of this.credentialsByOwnerAndProvider) {
      if (
        credential.grantedByOwnerId !== grantedByOwnerId ||
        credential.grantedByOwnerGenerationId !== grantedByOwnerGenerationId
      ) {
        continue;
      }
      firstRemoved ??= credential;
      this.credentialsByOwnerAndProvider.delete(cacheKey);
    }
    return firstRemoved;
  }

  getCredential(params: {
    grantedByOwnerId: string;
    grantedByOwnerGenerationId: string;
    providerId: string;
    modelScope: string;
    now: number;
  }): BrowserGatewayModelCredentialRecord | null {
    const providerId = normalizeBrowserGatewayModelCredentialProviderId(
      params.providerId,
    );
    const grantedByOwnerId = params.grantedByOwnerId.trim();
    const grantedByOwnerGenerationId = params.grantedByOwnerGenerationId.trim();
    if (!providerId || !grantedByOwnerId || !grantedByOwnerGenerationId) {
      return null;
    }
    const credential = this.credentialsByOwnerAndProvider.get(
      this.getCacheKey(grantedByOwnerId, providerId),
    );
    if (
      !credential ||
      credential.grantedByOwnerGenerationId !== grantedByOwnerGenerationId
    ) {
      return null;
    }
    if (
      credential.expiresAt !== undefined &&
      params.now >= credential.expiresAt
    ) {
      return null;
    }
    if (!credential.modelScopes.includes(params.modelScope)) return null;
    return credential;
  }

  getStatus(params: {
    grantedByOwnerId: string;
    grantedByOwnerGenerationId: string;
    providerId: string;
    modelScope: string;
    now: number;
  }): BrowserGatewayModelCredentialStatus {
    const providerId = normalizeBrowserGatewayModelCredentialProviderId(
      params.providerId,
    );
    const grantedByOwnerId = params.grantedByOwnerId.trim();
    const grantedByOwnerGenerationId = params.grantedByOwnerGenerationId.trim();
    const credential =
      providerId && grantedByOwnerId && grantedByOwnerGenerationId
        ? this.credentialsByOwnerAndProvider.get(
            this.getCacheKey(grantedByOwnerId, providerId),
          )
        : undefined;
    if (
      !credential ||
      credential.grantedByOwnerGenerationId !== grantedByOwnerGenerationId
    ) {
      return {
        state: "missing",
        providerId: providerId || undefined,
        reason: providerId
          ? `Open a VS Code AgentLink window to grant ${providerId} model credentials to the browser gateway.`
          : "Open a VS Code AgentLink window to grant model credentials to the browser gateway.",
      };
    }
    if (
      credential.expiresAt !== undefined &&
      params.now >= credential.expiresAt
    ) {
      return {
        state: "refresh_required",
        providerId: credential.providerId,
        method: credential.method,
        grantedByOwnerId: credential.grantedByOwnerId,
        grantedAt: credential.grantedAt,
        expiredAt: credential.expiresAt,
        accountLabel: credential.accountLabel,
        reason: `Cached browser-gateway ${credential.providerId} model credentials need refresh. Open a VS Code AgentLink window to refresh them.`,
      };
    }
    if (!credential.modelScopes.includes(params.modelScope)) {
      return {
        state: "missing",
        providerId: credential.providerId,
        reason: `Cached browser-gateway ${credential.providerId} model credentials do not grant the ${params.modelScope} scope.`,
      };
    }
    return {
      state: "ready",
      providerId: credential.providerId,
      method: credential.method,
      modelScopes: [...credential.modelScopes],
      grantedByOwnerId: credential.grantedByOwnerId,
      grantedAt: credential.grantedAt,
      expiresAt: credential.expiresAt,
      accountLabel: credential.accountLabel,
    };
  }

  private getCacheKey(grantedByOwnerId: string, providerId: string): string {
    return `${grantedByOwnerId.length}:${grantedByOwnerId}${providerId}`;
  }
}
