import type {
  CoreCapabilityStatusDto,
  CoreHostKind,
  CoreOwnerRegistrationDto,
  CoreSessionScopeDto,
} from "./session.js";

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

export type BrowserGatewayCoreOwnerRegistrationResolution =
  | "registered"
  | "renewed"
  | "superseded"
  | "taken_over"
  | "collision_assigned";

export interface BrowserGatewayCoreOwnerRegistrationResult<
  TCapabilityId extends string = string,
> {
  readonly requestedOwnerId: string;
  readonly effectiveOwnerId: string;
  readonly resolution: BrowserGatewayCoreOwnerRegistrationResolution;
  readonly registration: CoreOwnerRegistrationDto<TCapabilityId>;
}
