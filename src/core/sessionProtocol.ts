export const CURRENT_CORE_SESSION_PROTOCOL_VERSION =
  "2026-06.phase3.session.v1";

export type CoreHostKind =
  | "vscode"
  | "browser-gateway"
  | "cli"
  | "desktop"
  | "server"
  | "test";

export type CoreClientKind = "browser" | "vscode" | "cli" | "desktop" | "test";

export type CoreSessionScopeDto =
  | {
      kind: "workspace";
      workspaceId: string;
      displayName: string;
      rootPathLabel?: string;
    }
  | {
      kind: "projectless";
      scopeId: string;
      displayName: string;
    };

export interface CoreSessionOwnerDto {
  ownerId: string;
  ownerKind: CoreHostKind;
  displayName: string;
  instanceId?: string;
  processId?: number;
  scope: CoreSessionScopeDto;
  acquiredAt: number;
  lastHeartbeatAt?: number;
}

export interface CoreClientIdentityDto {
  clientId: string;
  kind: CoreClientKind;
  displayName: string;
  version: string;
  instanceId?: string;
}

export type CoreSessionLifecycle =
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_question"
  | "blocked"
  | "completed";

export type CoreCapabilityState =
  | "enabled"
  | "disabled"
  | "requires_approval"
  | "unavailable";

export interface CoreCapabilityStatusDto<
  TCapabilityId extends string = string,
> {
  capabilityId: TCapabilityId;
  state: CoreCapabilityState;
  reason?: string;
}

export interface CoreSessionSummaryDto<TCapabilityId extends string = string> {
  sessionId: string;
  title: string;
  mode: string;
  model: string;
  lifecycle: CoreSessionLifecycle;
  owner: CoreSessionOwnerDto;
  capabilities: CoreCapabilityStatusDto<TCapabilityId>[];
  persistenceRevision?: string;
  updatedAt: number;
  createdAt: number;
}

export type CoreSessionEventKind =
  | "session.list.changed"
  | "session.foreground.snapshot"
  | "session.state.updated"
  | "transcript.message.appended"
  | "transcript.message.updated"
  | "agent.progress.updated"
  | "approval.requested"
  | "approval.resolved"
  | "question.requested"
  | "question.resolved"
  | "mode.changed"
  | "model.changed"
  | "todo.updated"
  | "background.session.updated"
  | "capability.status.updated"
  | "policy.state.updated"
  | "persistence.conflict"
  | "audit.event.recorded";

export interface CoreSessionEventEnvelope<T = unknown> {
  protocolVersion: string;
  eventId: string;
  ownerId: string;
  sequence: number;
  kind: CoreSessionEventKind;
  sessionId?: string;
  emittedAt: number;
  payload: T;
}

export interface CoreForegroundSnapshotDto<TState = unknown> {
  protocolVersion: string;
  ownerId: string;
  latestSequence: number;
  state: TState;
}

export type CoreSessionReplayResult<TEvent = CoreSessionEventEnvelope> =
  | {
      ok: true;
      ownerId: string;
      fromSequence: number;
      events: TEvent[];
    }
  | {
      ok: false;
      ownerId: string;
      reason: "stale_sequence" | "owner_generation_changed";
      latestSequence: number;
    };

export interface CoreOwnerRegistrationDto<
  TCapabilityId extends string = string,
> {
  owner: CoreSessionOwnerDto;
  status: "connected" | "disconnected" | "starting" | "error";
  capabilities: CoreCapabilityStatusDto<TCapabilityId>[];
  ownerGenerationId: string;
  lastHeartbeatAt?: number;
}

export function createProjectlessSessionOwner(params: {
  ownerId: string;
  ownerKind: CoreHostKind;
  displayName: string;
  scopeId: string;
  scopeDisplayName: string;
  now: number;
  instanceId?: string;
  processId?: number;
}): CoreSessionOwnerDto {
  return {
    ownerId: params.ownerId,
    ownerKind: params.ownerKind,
    displayName: params.displayName,
    instanceId: params.instanceId,
    processId: params.processId,
    scope: {
      kind: "projectless",
      scopeId: params.scopeId,
      displayName: params.scopeDisplayName,
    },
    acquiredAt: params.now,
    lastHeartbeatAt: params.now,
  };
}

export function isProjectlessOwner(owner: CoreSessionOwnerDto): boolean {
  return owner.scope.kind === "projectless";
}

export function isCapabilityEnabled<TCapabilityId extends string>(
  capabilities: readonly CoreCapabilityStatusDto<TCapabilityId>[],
  capabilityId: TCapabilityId,
): boolean {
  return capabilities.some(
    (capability) =>
      capability.capabilityId === capabilityId &&
      capability.state === "enabled",
  );
}

export function assertReplayEventsBelongToOwner(
  ownerId: string,
  events: readonly CoreSessionEventEnvelope[],
): void {
  const foreignEvent = events.find((event) => event.ownerId !== ownerId);
  if (foreignEvent) {
    throw new Error("core_session_replay_owner_mismatch");
  }
}
