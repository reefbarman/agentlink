import { createHash, randomUUID } from "node:crypto";

import {
  serializeSandboxLaunchBinding,
  validateSandboxCapabilityGrant,
  type ApprovedSandboxCapabilityGrant,
  type SandboxCapabilityGrantInvalidReason,
  type SandboxLaunchBindingInput,
} from "../../core/sandboxPolicy.js";

const consumptionHandleBrand: unique symbol = Symbol(
  "SandboxCapabilityConsumptionHandle",
);

export interface SandboxCapabilityConsumptionHandle {
  readonly [consumptionHandleBrand]: true;
}

export type SandboxCapabilityAuditEvent =
  | {
      type: "issued" | "consumed" | "revoked";
      occurredAt: number;
      grantId: string;
      auditId: string;
      bindingDigest: string;
    }
  | {
      type: "rejected";
      occurredAt: number;
      grantId?: string;
      auditId?: string;
      bindingDigest: string;
      reason: SandboxCapabilityConsumeInvalidReason;
    };

export type SandboxCapabilityConsumeInvalidReason =
  | SandboxCapabilityGrantInvalidReason
  | "unknown_handle";

export type SandboxCapabilityConsumeResult =
  | { ok: true; grant: ApprovedSandboxCapabilityGrant }
  | { ok: false; reason: SandboxCapabilityConsumeInvalidReason };

export type SandboxCapabilityPreparedValidationResult =
  | { ok: true; grant: ApprovedSandboxCapabilityGrant }
  | {
      ok: false;
      reason:
        | "unknown_grant"
        | "not_consumed"
        | "expired"
        | "revoked"
        | "wrong_binding";
    };

export interface SandboxCapabilityAuthorityOptions {
  now?: () => number;
  createId?: () => string;
}

interface GrantEntry {
  grant: ApprovedSandboxCapabilityGrant;
}

export function createSandboxLaunchBindingDigest(
  binding: SandboxLaunchBindingInput,
): string {
  return createHash("sha256")
    .update(serializeSandboxLaunchBinding(binding), "utf8")
    .digest("hex");
}

export class SandboxCapabilityAuthority {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly grants = new Map<string, GrantEntry>();
  private readonly handles = new WeakMap<object, string>();
  private readonly auditEvents: SandboxCapabilityAuditEvent[] = [];

  constructor(options: SandboxCapabilityAuthorityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  issueCapabilityGrant(input: {
    binding: SandboxLaunchBindingInput;
    expiresAt: number;
    auditId?: string;
  }): {
    grant: ApprovedSandboxCapabilityGrant;
    handle: SandboxCapabilityConsumptionHandle;
  } {
    if (
      !input.binding.capability.publicNetwork &&
      !input.binding.capability.localBinding
    ) {
      throw new Error(
        "Sandbox capability grant requires an additional capability",
      );
    }

    const issuedAt = this.now();
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= issuedAt) {
      throw new Error("Sandbox capability grant expiry must be in the future");
    }

    const bindingDigest = createSandboxLaunchBindingDigest(input.binding);
    const grant: ApprovedSandboxCapabilityGrant = {
      grantId: this.createId(),
      bindingDigest,
      policyVersion: input.binding.policyVersion,
      sessionId: input.binding.sessionId,
      issuedAt,
      expiresAt: input.expiresAt,
      auditId: input.auditId ?? this.createId(),
    };
    const handle = Object.freeze(
      Object.create(null),
    ) as SandboxCapabilityConsumptionHandle;

    this.grants.set(grant.grantId, { grant });
    this.handles.set(handle, grant.grantId);
    this.auditEvents.push({
      type: "issued",
      occurredAt: issuedAt,
      grantId: grant.grantId,
      auditId: grant.auditId,
      bindingDigest,
    });

    return { grant: { ...grant }, handle };
  }

  /** Backward-compatible name for callers issuing the original public-network grant. */
  issuePublicNetworkGrant(input: {
    binding: SandboxLaunchBindingInput;
    expiresAt: number;
    auditId?: string;
  }): {
    grant: ApprovedSandboxCapabilityGrant;
    handle: SandboxCapabilityConsumptionHandle;
  } {
    if (!input.binding.capability.publicNetwork) {
      throw new Error("Public-network grant requires publicNetwork capability");
    }
    return this.issueCapabilityGrant(input);
  }

  consume(
    handle: SandboxCapabilityConsumptionHandle,
    binding: SandboxLaunchBindingInput,
  ): SandboxCapabilityConsumeResult {
    const occurredAt = this.now();
    const bindingDigest = createSandboxLaunchBindingDigest(binding);
    const grantId = this.handles.get(handle);
    const entry = grantId ? this.grants.get(grantId) : undefined;
    if (!entry) {
      this.auditEvents.push({
        type: "rejected",
        occurredAt,
        bindingDigest,
        reason: "unknown_handle",
      });
      return { ok: false, reason: "unknown_handle" };
    }

    const validation = validateSandboxCapabilityGrant({
      grant: entry.grant,
      now: occurredAt,
      sessionId: binding.sessionId,
      bindingDigest,
      policyVersion: binding.policyVersion,
    });
    if (!validation.ok) {
      this.auditEvents.push({
        type: "rejected",
        occurredAt,
        grantId: entry.grant.grantId,
        auditId: entry.grant.auditId,
        bindingDigest,
        reason: validation.reason,
      });
      return validation;
    }

    entry.grant = { ...entry.grant, consumedAt: occurredAt };
    this.auditEvents.push({
      type: "consumed",
      occurredAt,
      grantId: entry.grant.grantId,
      auditId: entry.grant.auditId,
      bindingDigest,
    });
    return { ok: true, grant: { ...entry.grant } };
  }

  validateConsumed(
    grantId: string,
    binding: SandboxLaunchBindingInput,
  ): SandboxCapabilityPreparedValidationResult {
    const entry = this.grants.get(grantId);
    if (!entry) return { ok: false, reason: "unknown_grant" };
    if (entry.grant.revokedAt !== undefined) {
      return { ok: false, reason: "revoked" };
    }
    if (entry.grant.consumedAt === undefined) {
      return { ok: false, reason: "not_consumed" };
    }
    if (this.now() >= entry.grant.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    if (
      entry.grant.bindingDigest !== createSandboxLaunchBindingDigest(binding) ||
      entry.grant.sessionId !== binding.sessionId ||
      entry.grant.policyVersion !== binding.policyVersion
    ) {
      return { ok: false, reason: "wrong_binding" };
    }
    return { ok: true, grant: { ...entry.grant } };
  }

  revoke(grantId: string): boolean {
    const entry = this.grants.get(grantId);
    if (!entry || entry.grant.revokedAt !== undefined) return false;

    const occurredAt = this.now();
    entry.grant = { ...entry.grant, revokedAt: occurredAt };
    this.auditEvents.push({
      type: "revoked",
      occurredAt,
      grantId: entry.grant.grantId,
      auditId: entry.grant.auditId,
      bindingDigest: entry.grant.bindingDigest,
    });
    return true;
  }

  getGrant(grantId: string): ApprovedSandboxCapabilityGrant | undefined {
    const grant = this.grants.get(grantId)?.grant;
    return grant ? { ...grant } : undefined;
  }

  getAuditEvents(): readonly SandboxCapabilityAuditEvent[] {
    return this.auditEvents.map((event) => ({ ...event }));
  }
}
