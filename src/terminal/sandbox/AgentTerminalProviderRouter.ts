import type {
  ClosedTerminalSnapshot,
  ConfinementPreparingTerminalProvider,
  NativePreparingTerminalProvider,
  PreparedTerminalExecution,
  TerminalCloseRequest,
  TerminalCloseResult,
  TerminalExecuteOptions,
  TerminalExecutionAuditEvent,
  TerminalExecutionOwner,
  TerminalExecutionRouteContext,
  TerminalExecutionSecuritySummary,
  TerminalListRequest,
  TerminalOutputRequest,
  TerminalProvider,
  TerminalRecentlyClosedRequest,
  TerminalRetainedOutput,
  TerminalRetainedOutputLease,
  TerminalSandboxAttestationSummary,
  TerminalTargetRequest,
} from "../../core/capabilities/terminal.js";

import { randomUUID } from "node:crypto";
import {
  SandboxPreparationDriftError,
  TerminalTargetRecoveryError,
  type SandboxPreparationDriftField,
  type TerminalTargetAuthority,
  type TerminalTargetCandidate,
  type TerminalTargetFailure,
  type TerminalTargetKind,
} from "../../core/capabilities/terminalTargetError.js";
import { verifyTerminalInlineFiles } from "../inlineFileIntegrity.js";

export interface AgentTerminalProviderHost {
  platform: NodeJS.Platform;
  architecture?: string;
  remoteName?: string;
  workspaceTrusted: boolean;
}

export type SandboxPreparationAvailability =
  | {
      status: "verified";
      attestation: TerminalSandboxAttestationSummary;
    }
  | { status: "runtime-unavailable"; detail?: string }
  | { status: "failed"; detail?: string };

export interface AgentTerminalProviderRouterOptions {
  isEnabled(): boolean;
  getHost(): AgentTerminalProviderHost;
  /** Legacy VS Code compatibility provider for hosts without the custom terminal. */
  createNativeProvider(): TerminalProvider;
  /** Phase 3+ custom-terminal Native Agent provider. Omit until implemented. */
  createNativeAgentProvider?(): TerminalProvider;
  createSandboxProvider(): ConfinementPreparingTerminalProvider;
  getSandboxAvailability():
    | PromiseLike<SandboxPreparationAvailability>
    | SandboxPreparationAvailability;
  now?: () => number;
  createAuditId?: () => string;
  recordExecutionAudit?: (event: TerminalExecutionAuditEvent) => void;
  revealCustomTerminal?(terminalId: string): boolean;
  log?: (message: string) => void;
}

type RouteDecision =
  | {
      route: "native";
      reason:
        | "feature-disabled"
        | "unsupported-host"
        | "remote-host"
        | "runtime-unavailable"
        | "verified-local-macos";
      executionSurface: "agentlink-native" | "vscode-compatibility";
    }
  | { route: "sandbox"; attestation: TerminalSandboxAttestationSummary }
  | {
      route: "unavailable";
      reason:
        | "untrusted"
        | "attestation-failed"
        | "native-runtime-unavailable"
        | "required-sandbox-unavailable";
    };

function terminalIdentity(
  terminalId: string,
  owner: TerminalExecutionOwner | undefined,
): string {
  return owner
    ? `${owner.scopeId}\0${owner.generation}\0${terminalId}`
    : `ownerless\0${terminalId}`;
}

function closeResult(names?: string[]): TerminalCloseResult {
  return {
    closed: 0,
    ...(names && names.length > 0 ? { not_found: [...names] } : {}),
  };
}

function snapshotSandboxAttestation(
  attestation: TerminalSandboxAttestationSummary,
): TerminalSandboxAttestationSummary {
  const warnings = [...attestation.capabilities.warnings];
  Object.freeze(warnings);
  const capabilities = { ...attestation.capabilities, warnings };
  Object.freeze(capabilities);
  return Object.freeze({ ...attestation, capabilities });
}

function snapshotOptions(
  options: TerminalExecuteOptions,
): TerminalExecuteOptions {
  return Object.freeze({
    ...options,
    ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
    ...(options.sandboxInlineFiles
      ? {
          sandboxInlineFiles: Object.freeze(
            options.sandboxInlineFiles.map((file) =>
              Object.freeze({ ...file }),
            ),
          ),
        }
      : {}),
    ...(options.sandboxCapabilityRequest
      ? {
          sandboxCapabilityRequest: Object.freeze({
            ...options.sandboxCapabilityRequest,
          }),
        }
      : {}),
  });
}

function isConfinementPreparingProvider(
  provider: TerminalProvider,
): provider is ConfinementPreparingTerminalProvider {
  return (
    "prepareConfinementExecution" in provider &&
    typeof provider.prepareConfinementExecution === "function"
  );
}

function isNativePreparingProvider(
  provider: TerminalProvider,
): provider is NativePreparingTerminalProvider {
  return (
    "prepareNativeExecution" in provider &&
    typeof provider.prepareNativeExecution === "function"
  );
}

interface RetirableTerminalProvider {
  retire(): void;
}

interface TerminalChannelEventProvider {
  onChannelEvent(
    listener: (update: { snapshot: { status: string } }) => void,
  ): {
    dispose(): void;
  };
}

function isRetirableTerminalProvider(
  provider: TerminalProvider,
): provider is TerminalProvider & RetirableTerminalProvider {
  return "retire" in provider && typeof provider.retire === "function";
}

function isTerminalChannelEventProvider(
  provider: TerminalProvider,
): provider is TerminalProvider & TerminalChannelEventProvider {
  return (
    "onChannelEvent" in provider &&
    typeof provider.onChannelEvent === "function"
  );
}

export class AgentTerminalProviderRouter implements TerminalProvider {
  private nativeProvider: TerminalProvider | undefined;
  private nativeAgentProvider: TerminalProvider | undefined;
  private sandboxProvider: ConfinementPreparingTerminalProvider | undefined;
  private readonly retiredNativeAgentProviders = new Set<TerminalProvider>();
  private readonly retiredSandboxProviders =
    new Set<ConfinementPreparingTerminalProvider>();
  private readonly channelLifecycleSubscriptions = new Map<
    TerminalProvider,
    { dispose(): void }
  >();
  private readonly retiredRecentlyClosed: ClosedTerminalSnapshot[] = [];
  private readonly retiredRetainedOutput = new Map<
    string,
    TerminalRetainedOutputLease
  >();
  private activeProvider: TerminalProvider | undefined;
  private sandboxFailure: Error | undefined;
  private readonly pendingExecutions = new Set<() => void>();
  private generation = 0;
  private currentAttestationId: string | undefined;
  private disposed = false;
  private logSink: ((message: string) => void) | undefined;
  private readonly now: () => number;
  private readonly createAuditId: () => string;

  constructor(private readonly options: AgentTerminalProviderRouterOptions) {
    this.logSink = options.log;
    this.now = options.now ?? Date.now;
    this.createAuditId = options.createAuditId ?? randomUUID;
  }

  get log(): ((message: string) => void) | undefined {
    return this.logSink;
  }

  set log(value: ((message: string) => void) | undefined) {
    this.logSink = value;
    if (this.nativeProvider) this.nativeProvider.log = value;
    if (this.nativeAgentProvider) this.nativeAgentProvider.log = value;
    if (this.sandboxProvider) this.sandboxProvider.log = value;
    for (const provider of this.retiredNativeAgentProviders)
      provider.log = value;
    for (const provider of this.retiredSandboxProviders) provider.log = value;
  }

  async prepareExecution(
    options: TerminalExecuteOptions,
    routeContext?: TerminalExecutionRouteContext,
  ): Promise<PreparedTerminalExecution> {
    this.assertActive();
    const descriptor = snapshotOptions(options);
    if (
      descriptor.sandboxCapabilityRequest?.unrestrictedPublicNetwork &&
      !descriptor.onManagedNetworkRequest
    ) {
      throw new Error(
        "Managed public network requires an interactive destination authorization callback",
      );
    }
    const suppliedRouteContext = routeContext
      ? Object.freeze({
          approvalPolicySnapshot: routeContext.approvalPolicySnapshot,
          approvalReviewerSnapshot: routeContext.approvalReviewerSnapshot,
          executionPresetSnapshot: routeContext.executionPresetSnapshot,
          requiredAuthority: routeContext.requiredAuthority,
          permissionIntent: routeContext.permissionIntent,
          approvalRequirement: routeContext.approvalRequirement,
          authorityReason: routeContext.authorityReason,
          commandApprovalPolicySnapshot:
            routeContext.commandApprovalPolicySnapshot,
          ...(routeContext.commandExecutionPolicySnapshot
            ? {
                commandExecutionPolicySnapshot:
                  routeContext.commandExecutionPolicySnapshot,
              }
            : {}),
        })
      : undefined;
    const effectiveRouteContext =
      this.maybeDeEscalateForPinnedSandboxTarget(
        descriptor,
        suppliedRouteContext,
      ) ?? suppliedRouteContext;
    const generation = this.generation;
    const decision = await this.decideRoute(effectiveRouteContext);
    this.assertGeneration(generation);

    const frozenRouteContext: TerminalExecutionRouteContext =
      effectiveRouteContext ??
      Object.freeze({
        approvalPolicySnapshot: "on-request",
        approvalReviewerSnapshot:
          decision.route === "sandbox" ? "auto-review" : "user",
        executionPresetSnapshot:
          decision.route === "sandbox" ? "workspace-write" : "native-manual",
        requiredAuthority:
          decision.route === "sandbox" ? "sandbox" : "native-agent",
        permissionIntent: "default",
        approvalRequirement: "policy",
        authorityReason: "approval-policy",
        commandApprovalPolicySnapshot:
          decision.route === "sandbox" ? "approve-for-me" : "manual",
      });

    if (decision.route === "unavailable") {
      const failure =
        decision.reason === "untrusted"
          ? "untrusted_workspace"
          : decision.reason === "native-runtime-unavailable"
            ? "native_runtime_unavailable"
            : decision.reason === "required-sandbox-unavailable"
              ? "required_sandbox_unavailable"
              : "attestation_failed";
      this.options.recordExecutionAudit?.({
        type: "execution_failed",
        occurredAt: this.now(),
        auditId: this.createAuditId(),
        resultStatus: decision.reason,
        failure,
      });
      throw this.unavailableError(decision.reason);
    }

    const security: TerminalExecutionSecuritySummary = Object.freeze(
      decision.route === "native"
        ? {
            auditId: this.createAuditId(),
            route: "native",
            executionSurface: decision.executionSurface,
            confinement: "native-unsandboxed",
            routeReason: decision.reason,
            ...frozenRouteContext,
            executionPolicy: "native-legacy-v1",
            preparedAt: this.now(),
          }
        : {
            auditId: this.createAuditId(),
            route: "sandbox",
            executionSurface: "verified-sandbox",
            confinement: "verified-baseline",
            routeReason: "verified-local-macos",
            ...frozenRouteContext,
            executionPolicy: "sandbox-baseline-v2",
            preparedAt: this.now(),
            sandbox: snapshotSandboxAttestation(decision.attestation),
          },
    );

    if (decision.route === "native") {
      let provider: TerminalProvider;
      try {
        provider =
          decision.executionSurface === "agentlink-native"
            ? this.resolveNativeAgentProvider()
            : this.resolveNativeProvider();
      } catch (error) {
        this.audit("execution_failed", security, {
          failure: "native_runtime_unavailable",
        });
        throw error;
      }
      this.assertExecutionTarget(descriptor, provider);
      const inner = await this.prepareNative(
        provider,
        descriptor,
        frozenRouteContext,
        security,
      );
      this.assertGeneration(generation, inner);
      const prepared = this.wrapPreparedExecution(
        generation,
        security,
        inner,
        provider,
        descriptor,
      );
      this.audit("execution_prepared", security);
      return prepared;
    }

    const provider = this.resolveSandboxProvider();
    this.assertExecutionTarget(descriptor, provider);
    const prepared = await provider.prepareConfinementExecution(
      descriptor,
      security,
    );
    this.assertGeneration(generation, prepared);
    if (this.currentAttestationId !== decision.attestation.attestationId) {
      prepared.dispose();
      throw new SandboxPreparationDriftError(["attestationId"]);
    }
    const changedFields: SandboxPreparationDriftField[] = [];
    if (prepared.security.route !== "sandbox") changedFields.push("route");
    for (const field of [
      "auditId",
      "approvalPolicySnapshot",
      "approvalReviewerSnapshot",
      "executionPresetSnapshot",
      "requiredAuthority",
      "permissionIntent",
      "approvalRequirement",
      "authorityReason",
      "commandApprovalPolicySnapshot",
    ] as const) {
      if (prepared.security[field] !== security[field])
        changedFields.push(field);
    }
    if (changedFields.length > 0) {
      prepared.dispose();
      throw new SandboxPreparationDriftError([...new Set(changedFields)]);
    }
    const wrapped = this.wrapPreparedExecution(
      generation,
      prepared.security,
      prepared,
      provider,
      descriptor,
      decision.attestation.attestationId,
    );
    this.audit("execution_prepared", security);
    return wrapped;
  }

  async executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<Awaited<ReturnType<TerminalProvider["executeCommand"]>>> {
    const prepared = await this.prepareExecution(options);
    return prepared.execute();
  }

  recordExecutionAudit(event: TerminalExecutionAuditEvent): void {
    this.options.recordExecutionAudit?.(event);
  }

  getBackgroundState(
    request: TerminalTargetRequest,
  ): ReturnType<TerminalProvider["getBackgroundState"]> {
    return this.ownerForTerminal(
      request.terminalId,
      request.owner,
    )?.getBackgroundState(request);
  }

  getCurrentOutput(request: TerminalOutputRequest): string | undefined {
    return this.ownerForTerminal(
      request.terminalId,
      request.owner,
    )?.getCurrentOutput?.(request);
  }

  getRetainedOutput(
    request: TerminalTargetRequest,
  ): TerminalRetainedOutput | undefined {
    const owner = this.ownerForRetainedOutput(
      request.terminalId,
      request.owner,
    );
    if (owner) return owner.getRetainedOutput?.(request);
    const retiredMatches = this.retiredRecentlyClosed.filter(
      (terminal) =>
        terminal.id === request.terminalId &&
        (request.owner === undefined ||
          (terminal.owner?.scopeId === request.owner.scopeId &&
            terminal.owner.generation === request.owner.generation)),
    );
    if (retiredMatches.length !== 1) return undefined;
    const retired = retiredMatches[0];
    return this.retiredRetainedOutput
      .get(terminalIdentity(retired.id, retired.owner))
      ?.read();
  }

  interruptTerminal(request: TerminalTargetRequest): boolean {
    return (
      this.ownerForTerminal(
        request.terminalId,
        request.owner,
      )?.interruptTerminal(request) ?? false
    );
  }

  detachTerminal(request: TerminalTargetRequest): boolean {
    return (
      this.ownerForTerminal(
        request.terminalId,
        request.owner,
      )?.detachTerminal?.(request) ?? false
    );
  }

  revealTerminal(request: TerminalTargetRequest): boolean {
    const owner = this.ownerForTerminal(request.terminalId, request.owner);
    if (!owner) return false;
    return owner.revealTerminal
      ? owner.revealTerminal(request)
      : (this.options.revealCustomTerminal?.(request.terminalId) ?? false);
  }

  getRecentlyClosedTerminals(
    request: TerminalRecentlyClosedRequest,
  ): ReturnType<TerminalProvider["getRecentlyClosedTerminals"]> {
    this.assertActive();
    const boundedLimit = Math.max(0, request.limit ?? 5);
    const current = this.allProviders().flatMap((provider) =>
      provider.getRecentlyClosedTerminals(request),
    );
    const retired = this.retiredRecentlyClosed.filter(
      (terminal) =>
        request.owner === undefined ||
        (terminal.owner?.scopeId === request.owner.scopeId &&
          terminal.owner.generation === request.owner.generation),
    );
    return [...current, ...retired]
      .sort((left, right) => right.closedAt - left.closedAt)
      .filter(
        (terminal, index, terminals) =>
          terminals.findIndex(
            (candidate) =>
              terminalIdentity(candidate.id, candidate.owner) ===
              terminalIdentity(terminal.id, terminal.owner),
          ) === index,
      )
      .slice(0, boundedLimit)
      .map((terminal) => ({ ...terminal }));
  }

  listTerminals(
    request: TerminalListRequest,
  ): ReturnType<TerminalProvider["listTerminals"]> {
    this.assertActive();
    const providers = this.allProviders();
    const seen = new Set<string>();
    return providers.flatMap((provider) =>
      provider.listTerminals(request).filter((terminal) => {
        if (seen.has(terminal.id)) return false;
        seen.add(terminal.id);
        return true;
      }),
    );
  }

  closeTerminals(request: TerminalCloseRequest): TerminalCloseResult {
    this.assertActive();
    const providers = this.allProviders();
    const names = request.names;
    if (providers.length === 0) return closeResult(names);
    if (!names || names.length === 0) {
      const result = {
        closed: providers.reduce(
          (count, provider) => count + provider.closeTerminals(request).closed,
          0,
        ),
      };
      this.pruneRetiredChannelProviders();
      return result;
    }
    const notFound: string[] = [];
    let closed = 0;
    for (const target of names) {
      if (target.startsWith("host-terminal-")) {
        notFound.push(target);
        continue;
      }
      const owners = providers.filter((provider) =>
        provider
          .listTerminals({ owner: request.owner })
          .some(
            (terminal) => terminal.id === target || terminal.name === target,
          ),
      );
      if (owners.length !== 1) {
        notFound.push(target);
        continue;
      }
      const result = owners[0].closeTerminals({
        owner: request.owner,
        names: [target],
      });
      closed += result.closed;
      if (result.not_found?.includes(target) || result.closed === 0) {
        notFound.push(target);
      }
    }
    const result = {
      closed,
      ...(notFound.length > 0 ? { not_found: notFound } : {}),
    };
    this.pruneRetiredChannelProviders();
    return result;
  }

  refresh(): void {
    this.assertActive();
    this.generation += 1;
    this.revokePendingExecutions();
    this.currentAttestationId = undefined;
    this.retireSandbox();
    this.retireNativeAgent();
    this.sandboxFailure = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.revokePendingExecutions();
    this.currentAttestationId = undefined;
    this.disposeAllChannelProviders();
  }

  /**
   * A command pinned to an existing sandbox terminal may run under sandbox
   * authority even when policy would route it natively (e.g. an allowlisted
   * command whose rule grants native authority): the sandbox is strictly more
   * confined, and rejecting the pinned target with wrong_authority would force
   * the caller to abandon the terminal it deliberately targeted. Explicit user
   * escalation and non-default permission intents are never overridden, and
   * the reverse direction (escalating to a native target) is never taken.
   */
  private maybeDeEscalateForPinnedSandboxTarget(
    descriptor: TerminalExecuteOptions,
    routeContext?: TerminalExecutionRouteContext,
  ): TerminalExecutionRouteContext | undefined {
    if (routeContext?.requiredAuthority !== "native-agent") return undefined;
    if (routeContext.authorityReason === "explicit-escalation")
      return undefined;
    if (routeContext.permissionIntent !== "default") return undefined;
    const sandbox = this.sandboxProvider;
    if (!sandbox || this.isRetiredChannelProvider(sandbox)) return undefined;

    const idTargets = [descriptor.terminal_id, descriptor.split_from].filter(
      (target): target is string => Boolean(target),
    );
    const hasNamedTarget = Boolean(descriptor.terminal_name);
    if (idTargets.length === 0 && !hasNamedTarget) return undefined;

    for (const target of idTargets) {
      const matches = this.providersForTerminalId(target, descriptor.owner);
      if (matches.length !== 1 || matches[0] !== sandbox) return undefined;
    }
    if (hasNamedTarget) {
      const namedMatches = this.allProviders().filter((provider) =>
        provider
          .listTerminals({ owner: descriptor.owner })
          .some((terminal) => terminal.name === descriptor.terminal_name),
      );
      if (namedMatches.length !== 1 || namedMatches[0] !== sandbox) {
        return undefined;
      }
    }

    return Object.freeze({
      ...routeContext,
      requiredAuthority: "sandbox" as const,
    });
  }

  private async decideRoute(
    routeContext?: TerminalExecutionRouteContext,
  ): Promise<RouteDecision> {
    const host = this.options.getHost();
    if (routeContext?.requiredAuthority === "native-agent") {
      this.currentAttestationId = undefined;
      if (!host.workspaceTrusted) {
        return { route: "unavailable", reason: "untrusted" };
      }
      if (
        !this.options.isEnabled() ||
        host.remoteName ||
        host.platform !== "darwin" ||
        !this.options.createNativeAgentProvider
      ) {
        return { route: "unavailable", reason: "native-runtime-unavailable" };
      }
      return {
        route: "native",
        reason: "verified-local-macos",
        executionSurface: "agentlink-native",
      };
    }
    if (routeContext?.requiredAuthority === "sandbox") {
      if (!host.workspaceTrusted) {
        this.currentAttestationId = undefined;
        return { route: "unavailable", reason: "untrusted" };
      }
      if (
        !this.options.isEnabled() ||
        host.remoteName ||
        host.platform !== "darwin"
      ) {
        this.currentAttestationId = undefined;
        return {
          route: "unavailable",
          reason: "required-sandbox-unavailable",
        };
      }
      return this.decideSandboxRoute();
    }
    if (!this.options.isEnabled()) {
      this.currentAttestationId = undefined;
      return {
        route: "native",
        reason: "feature-disabled",
        executionSurface: "vscode-compatibility",
      };
    }
    if (host.remoteName) {
      this.currentAttestationId = undefined;
      return {
        route: "native",
        reason: "remote-host",
        executionSurface: "vscode-compatibility",
      };
    }
    if (host.platform !== "darwin") {
      this.currentAttestationId = undefined;
      return {
        route: "native",
        reason: "unsupported-host",
        executionSurface: "vscode-compatibility",
      };
    }
    if (!host.workspaceTrusted) {
      this.currentAttestationId = undefined;
      return { route: "unavailable", reason: "untrusted" };
    }
    return this.decideSandboxRoute(true);
  }

  private async decideSandboxRoute(
    allowNativeFallback = false,
  ): Promise<RouteDecision> {
    if (this.sandboxFailure) {
      this.currentAttestationId = undefined;
      return { route: "unavailable", reason: "attestation-failed" };
    }

    const availability = await this.getSandboxAvailability();
    if (availability.status === "runtime-unavailable") {
      this.currentAttestationId = undefined;
      if (this.sandboxProvider) {
        this.sandboxFailure = new Error(
          availability.detail ??
            "Sandbox runtime became unavailable after sandbox selection",
        );
        return { route: "unavailable", reason: "attestation-failed" };
      }
      return allowNativeFallback
        ? {
            route: "native",
            reason: "runtime-unavailable",
            executionSurface: "vscode-compatibility",
          }
        : { route: "unavailable", reason: "required-sandbox-unavailable" };
    }
    if (availability.status === "failed") {
      this.sandboxFailure = new Error(
        availability.detail ?? "Sandbox behavioral attestation failed",
      );
      this.currentAttestationId = undefined;
      return { route: "unavailable", reason: "attestation-failed" };
    }
    this.currentAttestationId = availability.attestation.attestationId;
    return { route: "sandbox", attestation: availability.attestation };
  }

  private async getSandboxAvailability(): Promise<SandboxPreparationAvailability> {
    return this.options.getSandboxAvailability();
  }

  private async prepareNative(
    provider: TerminalProvider,
    descriptor: TerminalExecuteOptions,
    routeContext: TerminalExecutionRouteContext,
    security: TerminalExecutionSecuritySummary,
  ): Promise<PreparedTerminalExecution> {
    if (isNativePreparingProvider(provider)) {
      return provider.prepareNativeExecution(descriptor, security);
    }
    if (provider.prepareExecution) {
      return provider.prepareExecution(descriptor, routeContext);
    }
    let state: "prepared" | "consumed" | "disposed" = "prepared";
    return {
      security,
      execute: async () => {
        if (state !== "prepared") {
          throw new Error("Prepared native execution is no longer available");
        }
        state = "consumed";
        const result = await provider.executeCommand(descriptor);
        this.activeProvider = provider;
        return { ...result, security };
      },
      dispose: () => {
        if (state === "prepared") state = "disposed";
      },
    };
  }

  private wrapPreparedExecution(
    generation: number,
    security: TerminalExecutionSecuritySummary,
    inner: PreparedTerminalExecution,
    ownerProvider: TerminalProvider,
    descriptor: TerminalExecuteOptions,
    attestationId?: string,
  ): PreparedTerminalExecution {
    let state: "prepared" | "consumed" | "disposed" = "prepared";
    const revoke = () => {
      if (state !== "prepared") return;
      state = "disposed";
      this.pendingExecutions.delete(revoke);
      inner.dispose();
      this.audit("preparation_revoked", security, {
        failure: "lease_revoked",
      });
    };
    this.pendingExecutions.add(revoke);
    return {
      security,
      execute: async () => {
        if (state !== "prepared") {
          throw new Error("Prepared terminal execution is no longer available");
        }
        if (this.disposed || generation !== this.generation) {
          state = "disposed";
          inner.dispose();
          this.audit("preparation_revoked", security, {
            failure: "stale_generation",
          });
          throw new Error("Prepared terminal execution is stale");
        }
        if (
          attestationId !== undefined &&
          this.currentAttestationId !== attestationId
        ) {
          state = "disposed";
          inner.dispose();
          this.audit("preparation_revoked", security, {
            failure: "attestation_changed",
          });
          throw new SandboxPreparationDriftError(
            ["attestationId"],
            "execution",
          );
        }
        state = "consumed";
        this.pendingExecutions.delete(revoke);
        this.audit("prepared_execution_consumed", security);
        if (security.route === "native") {
          try {
            await verifyTerminalInlineFiles(descriptor.sandboxInlineFiles, {
              requireCanonicalPaths: true,
            });
          } catch (error) {
            inner.dispose();
            this.audit("execution_failed", security, {
              failure: "launch_failed",
            });
            throw error;
          }
        }
        try {
          this.audit("execution_started", security);
          const result = await inner.execute();
          this.activeProvider = ownerProvider;
          this.audit("execution_completed", security, {
            resultStatus:
              result.exit_code === null
                ? "running"
                : `exit_${result.exit_code}`,
          });
          return { ...result, security };
        } catch (error) {
          this.audit("execution_failed", security, {
            failure: "launch_failed",
          });
          throw error;
        }
      },
      dispose: revoke,
    };
  }

  private resolveNativeProvider(): TerminalProvider {
    this.assertActive();
    this.nativeProvider ??= this.options.createNativeProvider();
    this.nativeProvider.log = this.logSink;
    return this.nativeProvider;
  }

  private resolveNativeAgentProvider(): TerminalProvider {
    this.assertActive();
    const createProvider = this.options.createNativeAgentProvider;
    if (!createProvider) {
      throw this.unavailableError("native-runtime-unavailable");
    }
    try {
      this.nativeAgentProvider ??= createProvider();
      this.nativeAgentProvider.log = this.logSink;
      return this.nativeAgentProvider;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logSink?.(
        `[native-agent-terminal] Initialization failed closed: ${failure.message}`,
      );
      throw new Error(
        `Required Native Agent execution is unavailable: ${failure.message}. No compatibility terminal fallback was attempted.`,
        { cause: failure },
      );
    }
  }

  private resolveSandboxProvider(): ConfinementPreparingTerminalProvider {
    this.assertActive();
    if (this.sandboxFailure) throw this.unavailableError("attestation-failed");
    try {
      if (!this.sandboxProvider) {
        this.sandboxProvider = this.options.createSandboxProvider();
        this.observeSandboxLifecycle(this.sandboxProvider);
      }
      if (!isConfinementPreparingProvider(this.sandboxProvider)) {
        throw new Error(
          "Sandbox provider does not support prepared confinement execution",
        );
      }
      this.sandboxProvider.log = this.logSink;
      return this.sandboxProvider;
    } catch (error) {
      this.sandboxFailure =
        error instanceof Error ? error : new Error(String(error));
      this.currentAttestationId = undefined;
      this.logSink?.(
        `[sandbox-terminal] Initialization failed closed: ${this.sandboxFailure.message}`,
      );
      throw this.unavailableError("attestation-failed");
    }
  }

  private assertExecutionTarget(
    descriptor: TerminalExecuteOptions,
    expectedProvider: TerminalProvider,
  ): void {
    for (const [kind, target] of [
      ["terminal_id", descriptor.terminal_id],
      ["split_from", descriptor.split_from],
    ] as const) {
      if (!target) continue;
      if (target.startsWith("host-terminal-")) {
        this.rejectExecutionTarget(
          "host_target",
          kind,
          target,
          descriptor,
          expectedProvider,
          [],
        );
      }
      const matches = this.providersForTerminalId(target, descriptor.owner);
      if (matches.length === 0)
        this.rejectExecutionTarget(
          "not_found",
          kind,
          target,
          descriptor,
          expectedProvider,
          [],
        );
      if (matches.length > 1)
        this.rejectExecutionTarget(
          "ambiguous_name",
          kind,
          target,
          descriptor,
          expectedProvider,
          matches,
        );
      const owner = matches[0];
      if (this.isRetiredChannelProvider(owner)) {
        this.rejectExecutionTarget(
          "provider_retired",
          kind,
          target,
          descriptor,
          expectedProvider,
          matches,
        );
      }
      if (owner !== expectedProvider) {
        this.rejectExecutionTarget(
          "wrong_authority",
          kind,
          target,
          descriptor,
          expectedProvider,
          matches,
        );
      }
    }

    if (!descriptor.terminal_name) return;
    const namedMatches = this.allProviders().filter((provider) =>
      provider
        .listTerminals({ owner: descriptor.owner })
        .some((terminal) => terminal.name === descriptor.terminal_name),
    );
    if (namedMatches.length === 0) return;
    if (namedMatches.length > 1) {
      this.rejectExecutionTarget(
        "ambiguous_name",
        "terminal_name",
        descriptor.terminal_name,
        descriptor,
        expectedProvider,
        namedMatches,
      );
    }
    const owner = namedMatches[0];
    if (this.isRetiredChannelProvider(owner)) {
      this.rejectExecutionTarget(
        "provider_retired",
        "terminal_name",
        descriptor.terminal_name,
        descriptor,
        expectedProvider,
        namedMatches,
      );
    }
    if (owner !== expectedProvider) {
      this.rejectExecutionTarget(
        "wrong_authority",
        "terminal_name",
        descriptor.terminal_name,
        descriptor,
        expectedProvider,
        namedMatches,
      );
    }
  }

  private rejectExecutionTarget(
    failure: TerminalTargetFailure,
    targetKind: TerminalTargetKind,
    targetValue: string,
    descriptor: TerminalExecuteOptions,
    expectedProvider: TerminalProvider,
    targetProviders: readonly TerminalProvider[],
  ): never {
    this.options.recordExecutionAudit?.({
      type: "execution_failed",
      occurredAt: this.now(),
      auditId: this.createAuditId(),
      resultStatus: `target_${failure}`,
      failure,
    });
    const requiredAuthority = this.authorityForProvider(expectedProvider);
    const compatibleTerminals = this.candidatesForProvider(
      expectedProvider,
      descriptor.owner,
    );
    const availableTerminals = this.activeProviders()
      .flatMap((provider) =>
        this.candidatesForProvider(provider, descriptor.owner),
      )
      .sort(
        (left, right) =>
          left.authority!.localeCompare(right.authority!) ||
          left.terminal_id.localeCompare(right.terminal_id),
      );
    const targetAuthorities = [
      ...new Set(
        targetProviders.map((provider) => this.authorityForProvider(provider)),
      ),
    ];
    const guidance: string[] = [];
    if (failure === "wrong_authority" && targetAuthorities.length === 1) {
      guidance.push(
        `To preserve this target's identity, retry with ${targetAuthorities[0]} authority and the same ${targetKind}="${targetValue}"; AgentLink will not change authority automatically.`,
      );
    }
    const compatible = compatibleTerminals[0];
    if (compatible) {
      guidance.push(
        targetKind === "split_from"
          ? `Retry with split_from="${compatible.terminal_id}" to split from a current ${requiredAuthority} terminal.`
          : `Under ${requiredAuthority} authority, retry with terminal_id="${compatible.terminal_id}" or terminal_name="${compatible.terminal_name}".`,
      );
    } else if (targetKind === "terminal_name") {
      guidance.push(
        `Under ${requiredAuthority} authority, retry with a new unique terminal_name instead of reusing "${targetValue}".`,
      );
    }
    if (targetKind === "split_from") {
      guidance.push(
        "If an independent ungrouped terminal is intended, retry without split_from.",
      );
    } else {
      guidance.push(
        `If an independent terminal is intended, omit ${targetKind} or choose a new unique terminal_name.`,
      );
    }
    throw new TerminalTargetRecoveryError({
      failure,
      target_kind: targetKind,
      target_value: targetValue,
      required_authority: requiredAuthority,
      ...(targetAuthorities.length > 0
        ? { target_authorities: targetAuthorities }
        : {}),
      compatible_terminals: compatibleTerminals,
      available_terminals: availableTerminals,
      retry_guidance: guidance,
    });
  }

  private authorityForProvider(
    provider: TerminalProvider,
  ): TerminalTargetAuthority {
    return provider === this.sandboxProvider ||
      this.retiredSandboxProviders.has(
        provider as ConfinementPreparingTerminalProvider,
      )
      ? "sandbox"
      : "native-agent";
  }

  private activeProviders(): TerminalProvider[] {
    return [
      this.sandboxProvider,
      this.nativeAgentProvider,
      this.nativeProvider,
    ].filter(
      (provider): provider is TerminalProvider => provider !== undefined,
    );
  }

  private candidatesForProvider(
    provider: TerminalProvider,
    owner: TerminalExecutionOwner | undefined,
  ): TerminalTargetCandidate[] {
    if (this.isRetiredChannelProvider(provider)) return [];
    const authority = this.authorityForProvider(provider);
    return provider
      .listTerminals({ owner })
      .filter((terminal) => !terminal.stale)
      .map((terminal) => ({
        terminal_id: terminal.id,
        terminal_name: terminal.name,
        authority,
      }))
      .sort((left, right) => left.terminal_id.localeCompare(right.terminal_id));
  }

  private providersForTerminalId(
    terminalId: string,
    owner: TerminalExecutionOwner | undefined,
  ): TerminalProvider[] {
    return this.allProviders().filter((provider) =>
      provider
        .listTerminals({ owner })
        .some((terminal) => terminal.id === terminalId),
    );
  }

  private isRetiredChannelProvider(provider: TerminalProvider): boolean {
    return (
      this.retiredNativeAgentProviders.has(provider) ||
      this.retiredSandboxProviders.has(
        provider as ConfinementPreparingTerminalProvider,
      )
    );
  }

  private ownerForTerminal(
    terminalId: string,
    owner: TerminalExecutionOwner | undefined,
  ): TerminalProvider | undefined {
    this.assertActive();
    if (terminalId.startsWith("host-terminal-")) return undefined;
    const matches = this.providersForTerminalId(terminalId, owner);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private ownerForRetainedOutput(
    terminalId: string,
    owner: TerminalExecutionOwner | undefined,
  ): TerminalProvider | undefined {
    const liveOwner = this.ownerForTerminal(terminalId, owner);
    if (liveOwner) return liveOwner;
    const matches = this.allProviders().filter((provider) =>
      provider
        .getRecentlyClosedTerminals({ owner, limit: 20 })
        .some((terminal) => terminal.id === terminalId),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private currentProvider(): TerminalProvider | undefined {
    this.assertActive();
    return this.activeProvider;
  }

  private unavailableError(
    reason:
      | "untrusted"
      | "attestation-failed"
      | "native-runtime-unavailable"
      | "required-sandbox-unavailable",
  ): Error {
    if (reason === "untrusted") {
      return new Error(
        "Agent command execution is unavailable until the workspace is trusted. No terminal fallback was attempted.",
      );
    }
    if (reason === "native-runtime-unavailable") {
      return new Error(
        "Required Native Agent execution is unavailable. No compatibility terminal fallback was attempted.",
      );
    }
    if (reason === "required-sandbox-unavailable") {
      return new Error(
        "Required Sandbox execution is unavailable. No native terminal fallback was attempted.",
      );
    }
    return new Error(
      `AgentLink sandbox command execution failed closed${this.sandboxFailure ? `: ${this.sandboxFailure.message}` : "."} Disable agentlink.terminal.enabled to use the native VS Code terminal provider.`,
      this.sandboxFailure ? { cause: this.sandboxFailure } : undefined,
    );
  }

  private assertGeneration(
    generation: number,
    prepared?: PreparedTerminalExecution,
  ): void {
    if (this.disposed || generation !== this.generation) {
      prepared?.dispose();
      throw new Error("Agent terminal route changed during preparation");
    }
  }

  private audit(
    type: TerminalExecutionAuditEvent["type"],
    security: TerminalExecutionSecuritySummary,
    detail: Pick<TerminalExecutionAuditEvent, "failure" | "resultStatus"> = {},
  ): void {
    this.options.recordExecutionAudit?.({
      type,
      occurredAt: this.now(),
      auditId: security.auditId,
      route: security.route,
      routeReason: security.routeReason,
      ...(security.sandbox
        ? {
            attestationId: security.sandbox.attestationId,
            policyVersion: security.sandbox.policyVersion,
            profileId: security.sandbox.profileId,
          }
        : {}),
      ...detail,
    });
  }

  private revokePendingExecutions(): void {
    for (const revoke of this.pendingExecutions) revoke();
    this.pendingExecutions.clear();
  }

  private allProviders(): TerminalProvider[] {
    return [
      this.sandboxProvider,
      ...this.retiredSandboxProviders,
      this.nativeAgentProvider,
      ...this.retiredNativeAgentProviders,
      this.nativeProvider,
    ].filter(
      (provider): provider is TerminalProvider => provider !== undefined,
    );
  }

  private retireSandbox(): void {
    const provider = this.sandboxProvider;
    this.sandboxProvider = undefined;
    if (!provider) return;
    if (isRetirableTerminalProvider(provider)) provider.retire();
    this.retiredSandboxProviders.add(provider);
    this.pruneRetiredChannelProviders();
  }

  private retireNativeAgent(): void {
    const provider = this.nativeAgentProvider;
    this.nativeAgentProvider = undefined;
    if (!provider) return;
    this.observeChannelLifecycle(provider);
    if (isRetirableTerminalProvider(provider)) provider.retire();
    this.retiredNativeAgentProviders.add(provider);
    this.pruneRetiredChannelProviders();
  }

  private observeSandboxLifecycle(
    provider: ConfinementPreparingTerminalProvider,
  ): void {
    this.observeChannelLifecycle(provider);
  }

  private observeChannelLifecycle(provider: TerminalProvider): void {
    if (
      !isTerminalChannelEventProvider(provider) ||
      this.channelLifecycleSubscriptions.has(provider)
    ) {
      return;
    }
    const subscription = provider.onChannelEvent((update) => {
      if (update.snapshot.status !== "closed") return;
      queueMicrotask(() => {
        if (!this.disposed) this.pruneRetiredChannelProviders();
      });
    });
    this.channelLifecycleSubscriptions.set(provider, subscription);
  }

  private pruneRetiredChannelProviders(): void {
    const retired = [
      ...this.retiredSandboxProviders,
      ...this.retiredNativeAgentProviders,
    ];
    for (const provider of retired) {
      if (provider.listTerminals({ owner: undefined }).length > 0) continue;
      this.retiredSandboxProviders.delete(
        provider as ConfinementPreparingTerminalProvider,
      );
      this.retiredNativeAgentProviders.delete(provider);
      const recentlyClosed = provider.getRecentlyClosedTerminals({
        owner: undefined,
        limit: 20,
      });
      this.rememberRecentlyClosed(recentlyClosed, provider);
      this.channelLifecycleSubscriptions.get(provider)?.dispose();
      this.channelLifecycleSubscriptions.delete(provider);
      if (this.activeProvider === provider) this.activeProvider = undefined;
      if ("dispose" in provider) {
        (provider as TerminalProvider & { dispose(): void }).dispose();
      }
    }
  }

  private rememberRecentlyClosed(
    terminals: ClosedTerminalSnapshot[],
    provider?: TerminalProvider,
  ): void {
    for (const terminal of terminals) {
      const identity = terminalIdentity(terminal.id, terminal.owner);
      const existing = this.retiredRecentlyClosed.findIndex(
        (candidate) =>
          terminalIdentity(candidate.id, candidate.owner) === identity,
      );
      if (existing >= 0) this.retiredRecentlyClosed.splice(existing, 1);
      const retained = provider?.detachRetainedOutput?.({
        owner: terminal.owner,
        terminalId: terminal.id,
      });
      if (retained) {
        this.retiredRetainedOutput.get(identity)?.dispose();
        this.retiredRetainedOutput.set(identity, retained);
      }
      this.retiredRecentlyClosed.push({ ...terminal });
    }
    this.retiredRecentlyClosed.sort(
      (left, right) => right.closedAt - left.closedAt,
    );
    const removed = this.retiredRecentlyClosed.splice(20);
    for (const terminal of removed) {
      const identity = terminalIdentity(terminal.id, terminal.owner);
      this.retiredRetainedOutput.get(identity)?.dispose();
      this.retiredRetainedOutput.delete(identity);
    }
  }

  private disposeAllChannelProviders(): void {
    const providers = new Set<TerminalProvider>([
      ...(this.sandboxProvider ? [this.sandboxProvider] : []),
      ...this.retiredSandboxProviders,
      ...(this.nativeAgentProvider ? [this.nativeAgentProvider] : []),
      ...this.retiredNativeAgentProviders,
    ]);
    this.sandboxProvider = undefined;
    this.nativeAgentProvider = undefined;
    this.retiredSandboxProviders.clear();
    this.retiredNativeAgentProviders.clear();
    for (const subscription of this.channelLifecycleSubscriptions.values()) {
      subscription.dispose();
    }
    this.channelLifecycleSubscriptions.clear();
    this.retiredRecentlyClosed.length = 0;
    for (const lease of this.retiredRetainedOutput.values()) lease.dispose();
    this.retiredRetainedOutput.clear();
    if (this.activeProvider && providers.has(this.activeProvider as never)) {
      this.activeProvider = undefined;
    }
    for (const provider of providers) {
      if ("dispose" in provider) {
        (
          provider as ConfinementPreparingTerminalProvider & { dispose(): void }
        ).dispose();
      }
    }
  }

  private assertActive(): void {
    if (this.disposed)
      throw new Error("Agent terminal provider router is disposed");
  }
}
