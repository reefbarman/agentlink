import type { CoreModelAuthLease } from "../../core/modelAuth.js";
import type { CoreSessionScopeDto } from "../../core/sessionProtocol.js";
import {
  BrowserGatewayCoreOwnerRegistry,
  type BrowserGatewayCoreOwnerRegistration,
} from "../coreOwnerRegistry.js";
import { BrowserGatewayModelAuthLeaseStore } from "../browserGatewayModelAuthLeaseStore.js";

export interface GatewayGenerationFaultHarnessOptions {
  helperGenerationId?: string;
  ownerGenerationId?: string;
  ownerId?: string;
  now?: number;
}

export class GatewayGenerationFaultHarness {
  readonly ownerId: string;
  private helperGenerationId: string;
  private ownerGenerationId: string;
  private now: number;
  private ownerRegistry!: BrowserGatewayCoreOwnerRegistry;
  private leaseStore!: BrowserGatewayModelAuthLeaseStore;

  constructor(options: GatewayGenerationFaultHarnessOptions = {}) {
    this.ownerId = options.ownerId ?? "gateway-owner";
    this.helperGenerationId =
      options.helperGenerationId ?? "helper-generation-1";
    this.ownerGenerationId = options.ownerGenerationId ?? "owner-generation-1";
    this.now = options.now ?? 1_000;
    this.resetHelperState();
    this.registerCurrentOwner();
  }

  get currentHelperGenerationId(): string {
    return this.helperGenerationId;
  }

  get currentOwnerGenerationId(): string {
    return this.ownerGenerationId;
  }

  issueLease(ttlMs = 60_000): CoreModelAuthLease {
    return this.leaseStore.requestLease({
      providerId: "openai-codex",
      method: "oauth",
      grantedByOwnerId: "vscode-owner",
      grantedToOwnerId: this.ownerId,
      grantedToOwnerGenerationId: this.ownerGenerationId,
      modelScopes: ["chat"],
      ttlMs,
      now: this.now,
    });
  }

  validateLease(leaseId: string, ownerGenerationId = this.ownerGenerationId) {
    return this.leaseStore.validateLease({
      leaseId,
      ownerId: this.ownerId,
      ownerGenerationId,
      modelScope: "chat",
      now: this.now,
    });
  }

  heartbeat(ownerGenerationId = this.ownerGenerationId) {
    return this.ownerRegistry.heartbeat({
      ownerId: this.ownerId,
      ownerGenerationId,
      now: this.now,
    });
  }

  restartOwner(ownerGenerationId: string): void {
    this.ownerGenerationId = ownerGenerationId;
    this.advance(1);
    this.registerCurrentOwner();
  }

  restartHelper(helperGenerationId: string): void {
    this.helperGenerationId = helperGenerationId;
    this.advance(1);
    this.resetHelperState();
  }

  registerCurrentOwner(): void {
    this.ownerRegistry.register(this.ownerRegistration());
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }

  private resetHelperState(): void {
    this.ownerRegistry = new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 30_000,
    });
    this.leaseStore = new BrowserGatewayModelAuthLeaseStore({
      helperGenerationId: this.helperGenerationId,
      ownerRegistry: this.ownerRegistry,
    });
  }

  private ownerRegistration(): BrowserGatewayCoreOwnerRegistration {
    const scope: CoreSessionScopeDto = {
      kind: "projectless",
      scopeId: "ask-agent",
      displayName: "Ask Agent",
    };
    return {
      ownerId: this.ownerId,
      ownerKind: "browser-gateway",
      displayName: "Ask Agent",
      scope,
      ownerGenerationId: this.ownerGenerationId,
      now: this.now,
    };
  }
}
