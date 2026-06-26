import type {
  BrowserGatewayModelAuthLeaseRequest,
  BrowserGatewayModelAuthLeaseResponse,
  BrowserGatewayModelAuthLeaseRevokeResponse,
  BrowserGatewayModelCatalogPublishRequest,
  BrowserGatewayModelCatalogPublishResponse,
  BrowserGatewayModelCredentialClearResponse,
  BrowserGatewayModelCredentialGrantRequest,
  BrowserGatewayModelCredentialGrantResponse,
} from "../protocol.js";
import type {
  CoreModelAuthLease,
  CoreModelAuthProvider,
} from "../../core/modelAuth.js";

import type { CoreModelCatalogEntry } from "../../core/modelCatalog.js";

export interface BrowserGatewayResolvedModelAuthMetadata {
  method: BrowserGatewayModelAuthLeaseRequest["method"];
  providerId: string;
  bearerToken?: string;
  accountId?: string;
  accountLabel?: string;
  canRefresh?: boolean;
}

export interface BrowserGatewayHelperModelAuthLeaseClientOptions {
  helperUrl: string;
  clientSharedSecret: string;
  grantedByOwnerId: string;
  resolveModelAuth: (request?: {
    providerId?: string;
  }) => Promise<BrowserGatewayResolvedModelAuthMetadata | null>;
  log?: (message: string) => void;
  defaultTtlMs?: number;
}

/**
 * Extension-side model-auth lease provider.
 *
 * This verifies that VS Code can currently resolve model auth, then asks the
 * helper to mint an owner-bound lease record. It intentionally does not send
 * bearer tokens or API keys to the helper; a later broker slice can exchange a
 * valid lease for a model-call capability without exposing credentials to the
 * browser surface.
 */
export class BrowserGatewayHelperModelAuthLeaseClient implements CoreModelAuthProvider {
  constructor(
    private readonly options: BrowserGatewayHelperModelAuthLeaseClientOptions,
  ) {}

  setHelperUrl(url: string): void {
    this.options.helperUrl = url;
  }

  setSharedSecret(secret: string): void {
    this.options.clientSharedSecret = secret;
  }

  async requestLease(request: {
    ownerId: string;
    ownerGenerationId: string;
    modelScopes: string[];
    helperGenerationId: string;
    now: number;
  }): Promise<CoreModelAuthLease | null> {
    const auth = await this.options.resolveModelAuth();
    if (!auth) return null;
    const body: BrowserGatewayModelAuthLeaseRequest = {
      providerId: auth.providerId,
      method: auth.method,
      grantedByOwnerId: this.options.grantedByOwnerId,
      grantedToOwnerId: request.ownerId,
      grantedToOwnerGenerationId: request.ownerGenerationId,
      modelScopes: request.modelScopes,
      helperGenerationId: request.helperGenerationId,
      ttlMs: this.options.defaultTtlMs ?? 60_000,
    };
    const response = await this.postJson<BrowserGatewayModelAuthLeaseResponse>(
      "/internal/model-auth/leases",
      body,
    );
    return response.lease;
  }

  async grantCredential(request: {
    helperGenerationId: string;
    modelScopes: string[];
    now: number;
    providerId?: string;
  }): Promise<BrowserGatewayModelCredentialGrantResponse["credential"] | null> {
    const auth = await this.options.resolveModelAuth({
      providerId: request.providerId,
    });
    if (!auth?.bearerToken) return null;
    const body: BrowserGatewayModelCredentialGrantRequest = {
      providerId: auth.providerId,
      method: auth.method,
      bearerToken: auth.bearerToken,
      grantedByOwnerId: this.options.grantedByOwnerId,
      modelScopes: request.modelScopes,
      helperGenerationId: request.helperGenerationId,
      ttlMs: this.options.defaultTtlMs ?? 55 * 60_000,
      accountId: auth.accountId,
      accountLabel: auth.accountLabel,
      canRefresh: auth.canRefresh === true,
    };
    const response =
      await this.postJson<BrowserGatewayModelCredentialGrantResponse>(
        "/internal/model-auth/credentials",
        body,
      );
    return response.credential;
  }

  async publishModelCatalog(request: {
    helperGenerationId: string;
    models: CoreModelCatalogEntry[];
  }): Promise<BrowserGatewayModelCatalogPublishResponse> {
    const body: BrowserGatewayModelCatalogPublishRequest = {
      publishedByOwnerId: this.options.grantedByOwnerId,
      helperGenerationId: request.helperGenerationId,
      models: request.models,
    };
    return await this.postJson<BrowserGatewayModelCatalogPublishResponse>(
      "/internal/model-catalog",
      body,
    );
  }

  async clearCredential(providerId?: string): Promise<boolean> {
    const response =
      await this.postJson<BrowserGatewayModelCredentialClearResponse>(
        "/internal/model-auth/credentials/clear",
        providerId ? { providerId } : {},
      );
    return response.removed;
  }

  async revokeLease(leaseId: string, reason: string): Promise<void> {
    await this.postJson<BrowserGatewayModelAuthLeaseRevokeResponse>(
      "/internal/model-auth/leases/revoke",
      { leaseId, reason },
    );
  }

  private async postJson<T>(pathname: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.options.helperUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.clientSharedSecret}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      this.options.log?.(
        `[browser-gateway-helper-model-auth] ${pathname} failed: ${response.status} ${detail}`,
      );
      throw new Error(`helper_model_auth_request_failed:${response.status}`);
    }
    return (await response.json()) as T;
  }
}
