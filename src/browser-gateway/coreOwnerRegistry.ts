import type {
  CoreCapabilityStatusDto,
  CoreHostKind,
  CoreOwnerRegistrationDto,
  CoreSessionOwnerDto,
  CoreSessionScopeDto,
} from "../core/sessionProtocol.js";

export type BrowserGatewayCoreOwnerStatus = CoreOwnerRegistrationDto["status"];

export interface BrowserGatewayCoreOwnerRegistration<
  TCapabilityId extends string = string,
> {
  ownerId: string;
  ownerKind: CoreHostKind;
  displayName: string;
  scope: CoreSessionScopeDto;
  ownerGenerationId: string;
  capabilities?: CoreCapabilityStatusDto<TCapabilityId>[];
  instanceId?: string;
  processId?: number;
  now: number;
}

export interface BrowserGatewayCoreOwnerHeartbeat<
  TCapabilityId extends string = string,
> {
  ownerId: string;
  ownerGenerationId: string;
  capabilities?: CoreCapabilityStatusDto<TCapabilityId>[];
  now: number;
}

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

  requireConnectedOwner(
    ownerId: string,
  ): CoreOwnerRegistrationDto<TCapabilityId> {
    const owner = this.owners.get(ownerId);
    if (!owner || owner.status !== "connected") {
      throw new Error("browser_gateway_core_owner_unavailable");
    }
    return owner;
  }
}
