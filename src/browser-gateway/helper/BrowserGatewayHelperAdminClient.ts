import type {
  BrowserGatewayDeviceRevokeResponse,
  BrowserGatewayDevicesListResponse,
  BrowserGatewayPairingCancelResponse,
  BrowserGatewayPairingCreateResponse,
  BrowserGatewayPairingStatusResponse,
} from "../protocol.js";

export interface BrowserGatewayHelperAdminClientOptions {
  helperUrl: string;
  clientSharedSecret: string;
  /** Called on transport / HTTP errors. */
  log?: (message: string) => void;
}

/**
 * Extension-side HTTP client for the helper's `/internal/*` endpoints that
 * deal with pairing codes and paired devices. All calls are authed with the
 * per-helper clientSharedSecret (captured from the discovery record).
 */
export class BrowserGatewayHelperAdminClient {
  constructor(private readonly options: BrowserGatewayHelperAdminClientOptions) {}

  setHelperUrl(url: string): void {
    this.options.helperUrl = url;
  }

  setSharedSecret(secret: string): void {
    this.options.clientSharedSecret = secret;
  }

  async createPairing(
    label?: string,
  ): Promise<BrowserGatewayPairingCreateResponse> {
    const body = JSON.stringify({ label });
    return await this.postJson<BrowserGatewayPairingCreateResponse>(
      "/internal/pairing/create",
      body,
    );
  }

  async cancelPairing(
    pairingId: string,
  ): Promise<BrowserGatewayPairingCancelResponse> {
    const body = JSON.stringify({ pairingId });
    return await this.postJson<BrowserGatewayPairingCancelResponse>(
      "/internal/pairing/cancel",
      body,
    );
  }

  async getPairingStatus(
    pairingId: string,
  ): Promise<BrowserGatewayPairingStatusResponse> {
    return await this.getJson<BrowserGatewayPairingStatusResponse>(
      `/internal/pairing/status?id=${encodeURIComponent(pairingId)}`,
    );
  }

  async listDevices(): Promise<BrowserGatewayDevicesListResponse> {
    return await this.getJson<BrowserGatewayDevicesListResponse>(
      "/internal/devices",
    );
  }

  async revokeDevice(
    deviceId: string,
  ): Promise<BrowserGatewayDeviceRevokeResponse> {
    const body = JSON.stringify({ deviceId });
    return await this.postJson<BrowserGatewayDeviceRevokeResponse>(
      "/internal/devices/revoke",
      body,
    );
  }

  private async postJson<T>(pathname: string, body: string): Promise<T> {
    const response = await fetch(`${this.options.helperUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.clientSharedSecret}`,
      },
      body,
    });
    return await this.parseResponse<T>(response, pathname);
  }

  private async getJson<T>(pathname: string): Promise<T> {
    const response = await fetch(`${this.options.helperUrl}${pathname}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.options.clientSharedSecret}`,
      },
    });
    return await this.parseResponse<T>(response, pathname);
  }

  private async parseResponse<T>(
    response: Response,
    pathname: string,
  ): Promise<T> {
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      this.options.log?.(
        `[browser-gateway-helper-admin] ${pathname} failed: ${response.status} ${detail}`,
      );
      throw new Error(`helper_admin_request_failed:${response.status}`);
    }
    return (await response.json()) as T;
  }
}
