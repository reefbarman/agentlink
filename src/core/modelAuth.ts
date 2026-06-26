export type CoreModelAuthMethod = "oauth" | "apiKey";

export interface CoreModelAuthLease {
  leaseId: string;
  providerId: string;
  method: CoreModelAuthMethod;
  grantedByOwnerId: string;
  grantedToOwnerId: string;
  modelScopes: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
  helperGenerationId: string;
  auditId: string;
}

export type CoreModelAuthLeaseInvalidReason =
  | "not_found"
  | "expired"
  | "revoked"
  | "wrong_owner"
  | "wrong_helper_generation"
  | "scope_not_granted";

export type CoreModelAuthLeaseValidationResult =
  | { ok: true }
  | { ok: false; reason: CoreModelAuthLeaseInvalidReason };

export interface CoreModelAuthLeaseValidationRequest {
  lease: CoreModelAuthLease;
  now: number;
  ownerId: string;
  helperGenerationId: string;
  modelScope: string;
}

export interface CoreModelAuthProvider {
  requestLease(request: {
    ownerId: string;
    ownerGenerationId: string;
    modelScopes: string[];
    helperGenerationId: string;
    now: number;
  }): Promise<CoreModelAuthLease | null>;
  revokeLease(leaseId: string, reason: string): Promise<void>;
}

export function validateCoreModelAuthLease(
  request: CoreModelAuthLeaseValidationRequest,
): CoreModelAuthLeaseValidationResult {
  const { lease } = request;
  if (lease.revokedAt !== undefined) {
    return { ok: false, reason: "revoked" };
  }
  if (request.now >= lease.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (request.ownerId !== lease.grantedToOwnerId) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (request.helperGenerationId !== lease.helperGenerationId) {
    return { ok: false, reason: "wrong_helper_generation" };
  }
  if (!lease.modelScopes.includes(request.modelScope)) {
    return { ok: false, reason: "scope_not_granted" };
  }
  return { ok: true };
}
