import type * as vscode from "vscode";

interface BrowserGatewayHelperLeaseClientOptions {
  helperUrl: string;
  clientId: string;
  clientSharedSecret: string;
  log: (message: string) => void;
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
      }
    } catch (error) {
      this.options.log(
        `[browser-gateway-helper] lease refresh error: ${String(error)}`,
      );
    }
  }
}
