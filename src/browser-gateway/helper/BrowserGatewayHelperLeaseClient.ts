import type * as vscode from "vscode";

import type {
  BrowserGatewayCoreOwnerLeaseRegistration,
  BrowserGatewayCoreOwnerRegistrationResponse,
} from "../protocol.js";

interface BrowserGatewayHelperLeaseClientOptions {
  helperUrl: string;
  clientId: string;
  clientSharedSecret: string;
  log: (message: string) => void;
  coreOwner?: BrowserGatewayCoreOwnerLeaseRegistration;
  renewIntervalMs?: number;
  renewJitterRatio?: number;
  requestTimeoutMs?: number;
  leaseTtlMs?: number;
  random?: () => number;
}

export class BrowserGatewayHelperLeaseClient implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lifecycleGeneration = 0;
  private readonly renewalControllers = new Set<AbortController>();
  private renewal:
    | { lifecycleGeneration: number; promise: Promise<void> }
    | undefined;
  private effectiveOwnerId: string | undefined;

  constructor(
    private readonly options: BrowserGatewayHelperLeaseClientOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const lifecycleGeneration = ++this.lifecycleGeneration;
    await this.renewLease(lifecycleGeneration);
    this.scheduleRenewal(lifecycleGeneration);
  }

  async refresh(): Promise<void> {
    await this.renewLease();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.lifecycleGeneration += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const controller of this.renewalControllers) {
      controller.abort();
    }
    this.renewalControllers.clear();

    const requestTimeoutMs = this.options.requestTimeoutMs ?? 5_000;
    const controller = new AbortController();
    const timeoutError = new Error("browser_gateway_helper_release_timeout");
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, requestTimeoutMs);
    });
    try {
      await Promise.race([
        fetch(`${this.options.helperUrl}/internal/client/release`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.clientSharedSecret}`,
          },
          body: JSON.stringify({
            clientId: this.options.clientId,
            ownerId: this.effectiveOwnerId ?? this.options.coreOwner?.ownerId,
            ownerGenerationId: this.options.coreOwner?.ownerGenerationId,
          }),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      this.options.log(
        error === timeoutError
          ? `[browser-gateway-helper] release timed out after ${requestTimeoutMs}ms`
          : `[browser-gateway-helper] release failed: ${String(error)}`,
      );
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  dispose(): void {
    // VS Code's Disposable contract is synchronous; stop() bounds the detached
    // release request with requestTimeoutMs and suppresses its failures.
    void this.stop();
  }

  private renewLease(
    lifecycleGeneration = this.lifecycleGeneration,
  ): Promise<void> {
    if (!this.isActiveGeneration(lifecycleGeneration)) {
      return Promise.resolve();
    }
    if (this.renewal?.lifecycleGeneration === lifecycleGeneration) {
      return this.renewal.promise;
    }

    const promise = this.performRenewal(lifecycleGeneration).finally(() => {
      if (this.renewal?.promise === promise) this.renewal = undefined;
    });
    this.renewal = { lifecycleGeneration, promise };
    return promise;
  }

  private async performRenewal(lifecycleGeneration: number): Promise<void> {
    const leaseTtlMs = this.options.leaseTtlMs ?? 30_000;
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 5_000;
    const controller = new AbortController();
    const timeoutError = new Error("browser_gateway_helper_renewal_timeout");
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, requestTimeoutMs);
    });
    this.renewalControllers.add(controller);
    try {
      const response = await Promise.race([
        fetch(`${this.options.helperUrl}/internal/client/lease`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.clientSharedSecret}`,
          },
          body: JSON.stringify({
            clientId: this.options.clientId,
            ttlMs: leaseTtlMs,
          }),
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) {
        this.options.log(
          `[browser-gateway-helper] lease refresh failed: ${response.status}`,
        );
        return;
      }
      if (!this.isActiveGeneration(lifecycleGeneration)) return;
      await this.renewCoreOwnerRegistration(
        lifecycleGeneration,
        controller.signal,
        deadline,
      );
    } catch (error) {
      if (this.isActiveGeneration(lifecycleGeneration)) {
        this.options.log(
          error === timeoutError
            ? `[browser-gateway-helper] lease refresh timed out after ${requestTimeoutMs}ms`
            : `[browser-gateway-helper] lease refresh error: ${String(error)}`,
        );
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.renewalControllers.delete(controller);
    }
  }

  private scheduleRenewal(lifecycleGeneration: number): void {
    if (!this.isActiveGeneration(lifecycleGeneration) || this.timer) return;
    const renewIntervalMs = this.options.renewIntervalMs ?? 10_000;
    const jitterRatio = Math.max(
      0,
      Math.min(this.options.renewJitterRatio ?? 0.1, 1),
    );
    const random = this.options.random ?? Math.random;
    const jitterMultiplier = 1 + (random() * 2 - 1) * jitterRatio;
    const delayMs = Math.max(0, Math.round(renewIntervalMs * jitterMultiplier));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.renewLease(lifecycleGeneration).finally(() => {
        this.scheduleRenewal(lifecycleGeneration);
      });
    }, delayMs);
  }

  private async renewCoreOwnerRegistration(
    lifecycleGeneration: number,
    signal: AbortSignal,
    deadline: Promise<never>,
  ): Promise<void> {
    const owner = this.options.coreOwner;
    if (!owner || !this.isActiveGeneration(lifecycleGeneration)) return;
    const currentOwner = await this.postCoreOwnerHeartbeat(
      owner,
      signal,
      deadline,
    );
    if (currentOwner || !this.isActiveGeneration(lifecycleGeneration)) return;
    await this.postCoreOwnerRegistration(owner, signal, deadline);
  }

  private isActiveGeneration(lifecycleGeneration: number): boolean {
    return this.running && lifecycleGeneration === this.lifecycleGeneration;
  }

  private async postCoreOwnerHeartbeat(
    owner: BrowserGatewayCoreOwnerLeaseRegistration,
    signal: AbortSignal,
    deadline: Promise<never>,
  ): Promise<boolean> {
    const response = await Promise.race([
      fetch(`${this.options.helperUrl}/internal/core-owners/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.clientSharedSecret}`,
        },
        body: JSON.stringify({
          ownerId: this.effectiveOwnerId ?? owner.ownerId,
          ownerGenerationId: owner.ownerGenerationId,
          capabilities: owner.capabilities,
          memoryRuntime: owner.memoryRuntime,
        }),
        signal,
      }),
      deadline,
    ]);
    if (response.status === 404) return false;
    if (!response.ok) {
      this.options.log(
        `[browser-gateway-helper] core owner heartbeat failed: ${response.status}`,
      );
    }
    return response.ok;
  }

  private async postCoreOwnerRegistration(
    owner: BrowserGatewayCoreOwnerLeaseRegistration,
    signal: AbortSignal,
    deadline: Promise<never>,
  ): Promise<void> {
    const response = await Promise.race([
      fetch(`${this.options.helperUrl}/internal/core-owners/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.clientSharedSecret}`,
        },
        body: JSON.stringify(owner),
        signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      this.options.log(
        `[browser-gateway-helper] core owner registration failed: ${response.status}`,
      );
      return;
    }
    try {
      const body =
        (await response.json()) as BrowserGatewayCoreOwnerRegistrationResponse;
      if (
        body.ok === true &&
        typeof body.effectiveOwnerId === "string" &&
        body.effectiveOwnerId.trim()
      ) {
        this.effectiveOwnerId = body.effectiveOwnerId.trim();
      }
    } catch {
      // Older helpers omit collision metadata; continue with the requested ID.
    }
  }
}
