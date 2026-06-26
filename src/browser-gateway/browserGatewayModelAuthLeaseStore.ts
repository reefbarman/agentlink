import type {
  CoreModelAuthLease,
  CoreModelAuthLeaseValidationResult,
  CoreModelAuthMethod,
} from "../core/modelAuth.js";

import type { BrowserGatewayCoreOwnerRegistry } from "./coreOwnerRegistry.js";
import { randomUUID } from "crypto";
import { validateCoreModelAuthLease } from "../core/modelAuth.js";
import { normalizeBrowserGatewayModelCredentialProviderId } from "./browserGatewayModelProviderIds.js";

export interface BrowserGatewayModelAuthLeaseRequest {
  providerId: string;
  method: CoreModelAuthMethod;
  grantedByOwnerId: string;
  grantedToOwnerId: string;
  grantedToOwnerGenerationId: string;
  modelScopes: string[];
  ttlMs: number;
  auditId?: string;
  now: number;
}

export interface BrowserGatewayModelAuthLeaseValidationRequest {
  leaseId: string;
  ownerId: string;
  ownerGenerationId: string;
  modelScope: string;
  now: number;
}

export interface BrowserGatewayModelAuthLeaseStoreOptions {
  helperGenerationId: string;
  ownerRegistry: BrowserGatewayCoreOwnerRegistry;
}

interface BrowserGatewayModelAuthLeaseRecord {
  lease: CoreModelAuthLease;
  grantedToOwnerGenerationId: string;
}

export class BrowserGatewayModelAuthLeaseStore {
  private readonly leases = new Map<
    string,
    BrowserGatewayModelAuthLeaseRecord
  >();

  constructor(
    private readonly options: BrowserGatewayModelAuthLeaseStoreOptions,
  ) {}

  requestLease(
    request: BrowserGatewayModelAuthLeaseRequest,
  ): CoreModelAuthLease {
    if (!request.modelScopes.length) {
      throw new Error("browser_gateway_model_auth_lease_missing_scope");
    }
    const grantedToOwner = this.options.ownerRegistry.requireConnectedOwner(
      request.grantedToOwnerId,
    );
    if (
      grantedToOwner.ownerGenerationId !== request.grantedToOwnerGenerationId
    ) {
      throw new Error(
        "browser_gateway_model_auth_lease_owner_generation_mismatch",
      );
    }
    const issuedAt = request.now;
    const expiresAt = issuedAt + request.ttlMs;
    const lease: CoreModelAuthLease = {
      leaseId: randomUUID(),
      providerId: normalizeBrowserGatewayModelCredentialProviderId(
        request.providerId,
      ),
      method: request.method,
      grantedByOwnerId: request.grantedByOwnerId,
      grantedToOwnerId: request.grantedToOwnerId,
      modelScopes: [...request.modelScopes],
      issuedAt,
      expiresAt,
      helperGenerationId: this.options.helperGenerationId,
      auditId: request.auditId ?? randomUUID(),
    };
    this.leases.set(lease.leaseId, {
      lease,
      grantedToOwnerGenerationId: request.grantedToOwnerGenerationId,
    });
    return lease;
  }

  validateLease(
    request: BrowserGatewayModelAuthLeaseValidationRequest,
  ): CoreModelAuthLeaseValidationResult {
    const record = this.leases.get(request.leaseId);
    if (!record) {
      return { ok: false, reason: "not_found" };
    }
    if (record.grantedToOwnerGenerationId !== request.ownerGenerationId) {
      return { ok: false, reason: "wrong_owner" };
    }
    return validateCoreModelAuthLease({
      lease: record.lease,
      now: request.now,
      ownerId: request.ownerId,
      helperGenerationId: this.options.helperGenerationId,
      modelScope: request.modelScope,
    });
  }

  revokeLease(leaseId: string, now: number): CoreModelAuthLease | undefined {
    const record = this.leases.get(leaseId);
    if (!record) return undefined;
    const revoked: CoreModelAuthLease = {
      ...record.lease,
      revokedAt: now,
    };
    this.leases.set(leaseId, {
      ...record,
      lease: revoked,
    });
    return revoked;
  }

  getLease(leaseId: string): CoreModelAuthLease | undefined {
    return this.leases.get(leaseId)?.lease;
  }

  listLeases(now?: number): CoreModelAuthLease[] {
    const leases = [...this.leases.values()].map((record) => record.lease);
    if (now === undefined) return leases;
    return leases.filter(
      (lease) => lease.revokedAt === undefined && now < lease.expiresAt,
    );
  }
}
