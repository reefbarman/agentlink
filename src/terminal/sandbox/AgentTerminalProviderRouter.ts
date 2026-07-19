import type {
  ClosedTerminalSnapshot,
  ConfinementPreparingTerminalProvider,
  PreparedTerminalExecution,
  TerminalCloseResult,
  TerminalExecuteOptions,
  TerminalExecutionAuditEvent,
  TerminalExecutionSecuritySummary,
  TerminalProvider,
  TerminalSandboxAttestationSummary,
} from "../../core/capabilities/terminal.js";

import { randomUUID } from "node:crypto";

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
  createNativeProvider(): TerminalProvider;
  createSandboxProvider(): ConfinementPreparingTerminalProvider;
  getSandboxAvailability():
    | PromiseLike<SandboxPreparationAvailability>
    | SandboxPreparationAvailability;
  now?: () => number;
  createAuditId?: () => string;
  recordExecutionAudit?: (event: TerminalExecutionAuditEvent) => void;
  log?: (message: string) => void;
}

type RouteDecision =
  | {
      route: "native";
      reason:
        | "feature-disabled"
        | "unsupported-host"
        | "remote-host"
        | "runtime-unavailable";
    }
  | { route: "sandbox"; attestation: TerminalSandboxAttestationSummary }
  | { route: "unavailable"; reason: "untrusted" | "attestation-failed" };

function closeResult(names?: string[]): TerminalCloseResult {
  return {
    closed: 0,
    ...(names && names.length > 0 ? { not_found: [...names] } : {}),
  };
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

interface TerminalChannelEventProvider {
  onChannelEvent(
    listener: (update: { snapshot: { status: string } }) => void,
  ): {
    dispose(): void;
  };
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
  private sandboxProvider: ConfinementPreparingTerminalProvider | undefined;
  private readonly retiredSandboxProviders =
    new Set<ConfinementPreparingTerminalProvider>();
  private readonly sandboxLifecycleSubscriptions = new Map<
    ConfinementPreparingTerminalProvider,
    { dispose(): void }
  >();
  private readonly retiredRecentlyClosed: ClosedTerminalSnapshot[] = [];
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
    if (this.sandboxProvider) this.sandboxProvider.log = value;
  }

  async prepareExecution(
    options: TerminalExecuteOptions,
  ): Promise<PreparedTerminalExecution> {
    this.assertActive();
    const descriptor = snapshotOptions(options);
    const generation = this.generation;
    const decision = await this.decideRoute();
    this.assertGeneration(generation);

    if (decision.route === "unavailable") {
      throw this.unavailableError(decision.reason);
    }

    const security: TerminalExecutionSecuritySummary =
      decision.route === "native"
        ? {
            auditId: this.createAuditId(),
            route: "native",
            confinement: "native-unsandboxed",
            routeReason: decision.reason,
            approvalPolicy: "native-legacy-v1",
            preparedAt: this.now(),
          }
        : {
            auditId: this.createAuditId(),
            route: "sandbox",
            confinement: "verified-baseline",
            routeReason: "verified-local-macos",
            approvalPolicy: "sandbox-baseline-v1",
            preparedAt: this.now(),
            sandbox: decision.attestation,
          };

    if (decision.route === "native") {
      const provider = this.resolveNativeProvider();
      const prepared = this.wrapPreparedExecution(
        generation,
        security,
        this.prepareNative(provider, descriptor, security),
        provider,
      );
      this.audit("execution_prepared", security);
      return prepared;
    }

    const provider = this.resolveSandboxProvider();
    const prepared = await provider.prepareConfinementExecution(
      descriptor,
      security,
    );
    this.assertGeneration(generation, prepared);
    if (this.currentAttestationId !== decision.attestation.attestationId) {
      prepared.dispose();
      throw new Error("Prepared sandbox attestation changed before approval");
    }
    const wrapped = this.wrapPreparedExecution(
      generation,
      security,
      prepared,
      provider,
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
    terminalId: string,
  ): ReturnType<TerminalProvider["getBackgroundState"]> {
    return this.ownerForTerminal(terminalId)?.getBackgroundState(terminalId);
  }

  interruptTerminal(terminalId: string): boolean {
    return (
      this.ownerForTerminal(terminalId)?.interruptTerminal(terminalId) ?? false
    );
  }

  getRecentlyClosedTerminals(
    limit = 5,
  ): ReturnType<TerminalProvider["getRecentlyClosedTerminals"]> {
    this.assertActive();
    const boundedLimit = Math.max(0, limit);
    const current =
      this.currentProvider()?.getRecentlyClosedTerminals(boundedLimit);
    return [...(current ?? []), ...this.retiredRecentlyClosed]
      .sort((left, right) => right.closedAt - left.closedAt)
      .filter(
        (terminal, index, terminals) =>
          terminals.findIndex((candidate) => candidate.id === terminal.id) ===
          index,
      )
      .slice(0, boundedLimit)
      .map((terminal) => ({ ...terminal }));
  }

  listTerminals(): ReturnType<TerminalProvider["listTerminals"]> {
    this.assertActive();
    const providers = this.allProviders();
    const seen = new Set<string>();
    return providers.flatMap((provider) =>
      provider.listTerminals().filter((terminal) => {
        if (seen.has(terminal.id)) return false;
        seen.add(terminal.id);
        return true;
      }),
    );
  }

  closeTerminals(names?: string[]): TerminalCloseResult {
    this.assertActive();
    const providers = this.allProviders();
    if (providers.length === 0) return closeResult(names);
    if (!names || names.length === 0) {
      const result = {
        closed: providers.reduce(
          (count, provider) => count + provider.closeTerminals().closed,
          0,
        ),
      };
      this.pruneRetiredSandboxes();
      return result;
    }
    let remaining = [...names];
    let closed = 0;
    for (const provider of providers) {
      const result = provider.closeTerminals(remaining);
      closed += result.closed;
      remaining = result.not_found ?? [];
      if (remaining.length === 0) break;
    }
    const result = {
      closed,
      ...(remaining.length > 0 ? { not_found: remaining } : {}),
    };
    this.pruneRetiredSandboxes();
    return result;
  }

  refresh(): void {
    this.assertActive();
    this.generation += 1;
    this.revokePendingExecutions();
    this.currentAttestationId = undefined;
    this.retireSandbox();
    this.sandboxFailure = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.revokePendingExecutions();
    this.currentAttestationId = undefined;
    this.disposeAllSandboxes();
  }

  private async decideRoute(): Promise<RouteDecision> {
    const host = this.options.getHost();
    if (!this.options.isEnabled()) {
      this.currentAttestationId = undefined;
      return { route: "native", reason: "feature-disabled" };
    }
    if (host.remoteName) {
      this.currentAttestationId = undefined;
      return { route: "native", reason: "remote-host" };
    }
    if (host.platform !== "darwin") {
      this.currentAttestationId = undefined;
      return { route: "native", reason: "unsupported-host" };
    }
    if (!host.workspaceTrusted) {
      this.currentAttestationId = undefined;
      return { route: "unavailable", reason: "untrusted" };
    }
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
      return { route: "native", reason: "runtime-unavailable" };
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

  private prepareNative(
    provider: TerminalProvider,
    descriptor: TerminalExecuteOptions,
    security: TerminalExecutionSecuritySummary,
  ): PreparedTerminalExecution {
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
          throw new Error("Prepared sandbox attestation changed");
        }
        state = "consumed";
        this.pendingExecutions.delete(revoke);
        this.audit("prepared_execution_consumed", security);
        this.audit("execution_started", security);
        try {
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

  private ownerForTerminal(terminalId: string): TerminalProvider | undefined {
    this.assertActive();
    for (const provider of [
      this.sandboxProvider,
      ...this.retiredSandboxProviders,
    ]) {
      if (
        provider?.listTerminals().some((terminal) => terminal.id === terminalId)
      ) {
        return provider;
      }
    }
    if (
      this.nativeProvider
        ?.listTerminals()
        .some((terminal) => terminal.id === terminalId)
    ) {
      return this.nativeProvider;
    }
    return this.activeProvider;
  }

  private currentProvider(): TerminalProvider | undefined {
    this.assertActive();
    return this.activeProvider;
  }

  private unavailableError(reason: "untrusted" | "attestation-failed"): Error {
    if (reason === "untrusted") {
      return new Error(
        "AgentLink sandbox command execution is unavailable until the workspace is trusted. Disable agentlink.terminal.enabled to use the native VS Code terminal provider.",
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
      this.nativeProvider,
    ].filter(
      (provider): provider is TerminalProvider => provider !== undefined,
    );
  }

  private retireSandbox(): void {
    const provider = this.sandboxProvider;
    this.sandboxProvider = undefined;
    if (!provider) return;
    this.retiredSandboxProviders.add(provider);
    this.pruneRetiredSandboxes();
  }

  private observeSandboxLifecycle(
    provider: ConfinementPreparingTerminalProvider,
  ): void {
    if (
      !isTerminalChannelEventProvider(provider) ||
      this.sandboxLifecycleSubscriptions.has(provider)
    ) {
      return;
    }
    const subscription = provider.onChannelEvent((update) => {
      if (update.snapshot.status !== "closed") return;
      queueMicrotask(() => {
        if (!this.disposed) this.pruneRetiredSandboxes();
      });
    });
    this.sandboxLifecycleSubscriptions.set(provider, subscription);
  }

  private pruneRetiredSandboxes(): void {
    for (const provider of this.retiredSandboxProviders) {
      if (provider.listTerminals().length > 0) continue;
      this.retiredSandboxProviders.delete(provider);
      this.rememberRecentlyClosed(provider.getRecentlyClosedTerminals(20));
      this.sandboxLifecycleSubscriptions.get(provider)?.dispose();
      this.sandboxLifecycleSubscriptions.delete(provider);
      if (this.activeProvider === provider) this.activeProvider = undefined;
      if ("dispose" in provider) {
        (
          provider as ConfinementPreparingTerminalProvider & { dispose(): void }
        ).dispose();
      }
    }
  }

  private rememberRecentlyClosed(terminals: ClosedTerminalSnapshot[]): void {
    for (const terminal of terminals) {
      const existing = this.retiredRecentlyClosed.findIndex(
        (candidate) => candidate.id === terminal.id,
      );
      if (existing >= 0) this.retiredRecentlyClosed.splice(existing, 1);
      this.retiredRecentlyClosed.push({ ...terminal });
    }
    this.retiredRecentlyClosed.sort(
      (left, right) => right.closedAt - left.closedAt,
    );
    this.retiredRecentlyClosed.splice(20);
  }

  private disposeAllSandboxes(): void {
    const providers = new Set([
      ...(this.sandboxProvider ? [this.sandboxProvider] : []),
      ...this.retiredSandboxProviders,
    ]);
    this.sandboxProvider = undefined;
    this.retiredSandboxProviders.clear();
    for (const subscription of this.sandboxLifecycleSubscriptions.values()) {
      subscription.dispose();
    }
    this.sandboxLifecycleSubscriptions.clear();
    this.retiredRecentlyClosed.length = 0;
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
