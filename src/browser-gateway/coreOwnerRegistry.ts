import type {
  BrowserGatewayCoreOwnerHeartbeat,
  BrowserGatewayCoreOwnerRegistration,
  BrowserGatewayCoreOwnerRegistrationResult,
  BrowserGatewayCoreOwnerStatus,
} from "@agentlink/protocol/browser-gateway-core-owner-registration";
import type {
  CoreOwnerRegistrationDto,
  CoreSessionOwnerDto,
} from "@agentlink/protocol/session";

export type {
  BrowserGatewayCoreOwnerHeartbeat,
  BrowserGatewayCoreOwnerRegistration,
  BrowserGatewayCoreOwnerRegistrationResolution,
  BrowserGatewayCoreOwnerRegistrationResult,
  BrowserGatewayCoreOwnerStatus,
} from "@agentlink/protocol/browser-gateway-core-owner-registration";

export interface BrowserGatewayCoreOwnerRegistryOptions {
  heartbeatTtlMs: number;
}

export class BrowserGatewayCoreOwnerRegistry<
  TCapabilityId extends string = string,
> {
  private readonly owners = new Map<
    string,
    CoreOwnerRegistrationDto<TCapabilityId>
  >();
  private readonly collisionOwnerIds = new Map<string, string>();

  constructor(
    private readonly options: BrowserGatewayCoreOwnerRegistryOptions,
  ) {}

  register(
    registration: BrowserGatewayCoreOwnerRegistration<TCapabilityId>,
  ): CoreOwnerRegistrationDto<TCapabilityId> {
    const owner: CoreSessionOwnerDto = {
      ownerId: registration.ownerId,
      ownerKind: registration.ownerKind,
      displayName: registration.displayName,
      instanceId: registration.instanceId,
      processId: registration.processId,
      scope: registration.scope,
      acquiredAt: registration.now,
      lastHeartbeatAt: registration.now,
    };
    const record: CoreOwnerRegistrationDto<TCapabilityId> = {
      owner,
      status: "connected",
      capabilities: registration.capabilities ?? [],
      ownerGenerationId: registration.ownerGenerationId,
      lastHeartbeatAt: registration.now,
    };
    this.owners.set(registration.ownerId, record);
    return record;
  }

  registerWithCollisionPolicy(
    registration: BrowserGatewayCoreOwnerRegistration<TCapabilityId>,
  ): BrowserGatewayCoreOwnerRegistrationResult<TCapabilityId> {
    this.refreshStatuses(registration.now);
    const requestedOwnerId = registration.ownerId;
    const collisionKey = `${requestedOwnerId}\u0000${registration.ownerGenerationId}`;
    const assignedOwnerId = this.collisionOwnerIds.get(collisionKey);
    if (assignedOwnerId) {
      const record = this.register({
        ...registration,
        ownerId: assignedOwnerId,
      });
      return {
        requestedOwnerId,
        effectiveOwnerId: assignedOwnerId,
        resolution: "renewed",
        registration: record,
      };
    }
    const current = this.owners.get(requestedOwnerId);
    if (!current) {
      const record = this.register(registration);
      return {
        requestedOwnerId,
        effectiveOwnerId: requestedOwnerId,
        resolution: "registered",
        registration: record,
      };
    }
    if (current.ownerGenerationId === registration.ownerGenerationId) {
      const record = this.register(registration);
      return {
        requestedOwnerId,
        effectiveOwnerId: requestedOwnerId,
        resolution: "renewed",
        registration: record,
      };
    }
    if (current.status !== "connected") {
      const record = this.register(registration);
      return {
        requestedOwnerId,
        effectiveOwnerId: requestedOwnerId,
        resolution: "taken_over",
        registration: record,
      };
    }
    if (
      registration.instanceId &&
      current.owner.instanceId === registration.instanceId
    ) {
      const record = this.register(registration);
      return {
        requestedOwnerId,
        effectiveOwnerId: requestedOwnerId,
        resolution: "superseded",
        registration: record,
      };
    }

    const effectiveOwnerId = this.allocateCollisionOwnerId(
      requestedOwnerId,
      registration.ownerGenerationId,
    );
    const record = this.register({
      ...registration,
      ownerId: effectiveOwnerId,
    });
    this.collisionOwnerIds.set(collisionKey, effectiveOwnerId);
    return {
      requestedOwnerId,
      effectiveOwnerId,
      resolution: "collision_assigned",
      registration: record,
    };
  }

  heartbeat(
    heartbeat: BrowserGatewayCoreOwnerHeartbeat<TCapabilityId>,
  ): CoreOwnerRegistrationDto<TCapabilityId> | undefined {
    const current = this.owners.get(heartbeat.ownerId);
    if (!current) return undefined;
    if (current.ownerGenerationId !== heartbeat.ownerGenerationId) {
      return undefined;
    }
    const next: CoreOwnerRegistrationDto<TCapabilityId> = {
      ...current,
      status: "connected",
      capabilities: heartbeat.capabilities ?? current.capabilities,
      lastHeartbeatAt: heartbeat.now,
      owner: {
        ...current.owner,
        lastHeartbeatAt: heartbeat.now,
      },
    };
    this.owners.set(heartbeat.ownerId, next);
    return next;
  }

  markDisconnected(
    ownerId: string,
    status: Extract<
      BrowserGatewayCoreOwnerStatus,
      "disconnected" | "error"
    > = "disconnected",
  ): CoreOwnerRegistrationDto<TCapabilityId> | undefined {
    const current = this.owners.get(ownerId);
    if (!current) return undefined;
    const next: CoreOwnerRegistrationDto<TCapabilityId> = {
      ...current,
      status,
    };
    this.owners.set(ownerId, next);
    return next;
  }

  refreshStatuses(now: number): CoreOwnerRegistrationDto<TCapabilityId>[] {
    const nextRecords: CoreOwnerRegistrationDto<TCapabilityId>[] = [];
    for (const [ownerId, record] of this.owners) {
      const heartbeatAt =
        record.lastHeartbeatAt ?? record.owner.lastHeartbeatAt;
      if (
        record.status === "connected" &&
        heartbeatAt !== undefined &&
        now - heartbeatAt > this.options.heartbeatTtlMs
      ) {
        const disconnected: CoreOwnerRegistrationDto<TCapabilityId> = {
          ...record,
          status: "disconnected",
        };
        this.owners.set(ownerId, disconnected);
        nextRecords.push(disconnected);
      } else {
        nextRecords.push(record);
      }
    }
    return nextRecords;
  }

  get(ownerId: string): CoreOwnerRegistrationDto<TCapabilityId> | undefined {
    return this.owners.get(ownerId);
  }

  list(now?: number): CoreOwnerRegistrationDto<TCapabilityId>[] {
    if (now !== undefined) {
      return this.refreshStatuses(now);
    }
    return [...this.owners.values()];
  }

  listVisible(now?: number): CoreOwnerRegistrationDto<TCapabilityId>[] {
    return filterVisibleCoreOwners(this.list(now));
  }

  requireConnectedOwner(
    ownerId: string,
  ): CoreOwnerRegistrationDto<TCapabilityId> {
    const owner = this.owners.get(ownerId);
    if (!owner || owner.status !== "connected") {
      throw new Error("browser_gateway_core_owner_unavailable");
    }
    return owner;
  }

  private allocateCollisionOwnerId(
    requestedOwnerId: string,
    ownerGenerationId: string,
  ): string {
    const suffix =
      sanitizeOwnerIdSegment(ownerGenerationId).slice(0, 24) || "generation";
    const base = `${requestedOwnerId}~${suffix}`;
    let candidate = base;
    let attempt = 1;
    while (this.owners.has(candidate)) {
      attempt += 1;
      candidate = `${base}-${attempt}`;
    }
    return candidate;
  }
}

export function filterVisibleCoreOwners<TCapabilityId extends string = string>(
  registrations: readonly CoreOwnerRegistrationDto<TCapabilityId>[],
): CoreOwnerRegistrationDto<TCapabilityId>[] {
  const connectedWorkspaceIds = new Set(
    registrations.flatMap((registration) => {
      const scope = registration.owner.scope;
      return registration.status === "connected" &&
        scope.kind === "workspace" &&
        scope.workspaceId.trim()
        ? [scope.workspaceId.trim()]
        : [];
    }),
  );
  return registrations.filter((registration) => {
    const scope = registration.owner.scope;
    return (
      registration.status === "connected" ||
      scope.kind !== "workspace" ||
      !scope.workspaceId.trim() ||
      !connectedWorkspaceIds.has(scope.workspaceId.trim())
    );
  });
}

export function filterInstancesForVisibleCoreOwners<
  T extends { instanceId: string },
>(
  instances: readonly T[],
  registrations: readonly CoreOwnerRegistrationDto[],
): T[] {
  const representedInstanceIds = new Set(
    registrations.flatMap((registration) =>
      registration.owner.instanceId ? [registration.owner.instanceId] : [],
    ),
  );
  const visibleInstanceIds = new Set(
    filterVisibleCoreOwners(registrations).flatMap((registration) =>
      registration.owner.instanceId ? [registration.owner.instanceId] : [],
    ),
  );
  return instances.filter(
    (instance) =>
      !representedInstanceIds.has(instance.instanceId) ||
      visibleInstanceIds.has(instance.instanceId),
  );
}

function sanitizeOwnerIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}
