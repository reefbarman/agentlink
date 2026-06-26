import type * as vscode from "vscode";

import type { BrowserGatewayCoreOwnerLeaseRegistration } from "../protocol.js";

interface BrowserGatewayHelperLeaseClientOptions {
  helperUrl: string;
  clientId: string;
  clientSharedSecret: string;
  log: (message: string) => void;
  coreOwner?: BrowserGatewayCoreOwnerLeaseRegistration;
  renewIntervalMs?: number;
  leaseTtlMs?: number;
}

export class BrowserGatewayHelperLeaseClient implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly options: BrowserGatewayHelperLeaseClientOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.renewLease();
    const renewIntervalMs = this.options.renewIntervalMs ?? 10_000;
    this.timer = setInterval(() => {
      void this.renewLease();
    }, renewIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    try {
      await fetch(`${this.options.helperUrl}/internal/client/release`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.clientSharedSecret}`,
        },
        body: JSON.stringify({
          clientId: this.options.clientId,
          ownerId: this.options.coreOwner?.ownerId,
          ownerGenerationId: this.options.coreOwner?.ownerGenerationId,
        }),
      });
    } catch (error) {
      this.options.log(
        `[browser-gateway-helper] release failed: ${String(error)}`,
      );
    }
  }

  dispose(): void {
    void this.stop();
  }

  private async renewLease(): Promise<void> {
    if (!this.running) return;
    const leaseTtlMs = this.options.leaseTtlMs ?? 30_000;
    try {
      const response = await fetch(
        `${this.options.helperUrl}/internal/client/lease`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.options.clientSharedSecret}`,
          },
          body: JSON.stringify({
            clientId: this.options.clientId,
            ttlMs: leaseTtlMs,
          }),
        },
      );
      if (!response.ok) {
        this.options.log(
          `[browser-gateway-helper] lease refresh failed: ${response.status}`,
        );
        return;
      }
      await this.renewCoreOwnerRegistration();
    } catch (error) {
      this.options.log(
        `[browser-gateway-helper] lease refresh error: ${String(error)}`,
      );
    }
  }

  private async renewCoreOwnerRegistration(): Promise<void> {
    const owner = this.options.coreOwner;
    if (!owner) return;
    const currentOwner = await this.postCoreOwnerHeartbeat(owner);
    if (currentOwner) return;
    await this.postCoreOwnerRegistration(owner);
  }

  private async postCoreOwnerHeartbeat(
    owner: BrowserGatewayCoreOwnerLeaseRegistration,
  ): Promise<boolean> {
    const response = await fetch(
      `${this.options.helperUrl}/internal/core-owners/heartbeat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.clientSharedSecret}`,
        },
        body: JSON.stringify({
          ownerId: owner.ownerId,
          ownerGenerationId: owner.ownerGenerationId,
        }),
      },
    );
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
  ): Promise<void> {
    const response = await fetch(
      `${this.options.helperUrl}/internal/core-owners/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.clientSharedSecret}`,
        },
        body: JSON.stringify(owner),
      },
    );
    if (!response.ok) {
      this.options.log(
        `[browser-gateway-helper] core owner registration failed: ${response.status}`,
      );
    }
  }
}
