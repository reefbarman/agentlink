import {
  createSharedOpenAiCompatibleCredentialStore,
  SharedOpenAiCompatibleConfigStore,
  type SharedOpenAiCompatibleCredentialStore,
} from "@agentlink/node-host";
import type { BrowserGatewayResolvedModelAuthMetadata } from "../../../src/browser-gateway/helper/BrowserGatewayHelperModelAuthLeaseClient.js";
import type { BrowserGatewayOpenAiCompatibleRuntimeProfiles } from "../../../src/browser-gateway/protocol.js";

import { buildDesktopOpenAiCompatibleCatalog } from "./desktopModelCatalog.js";

export interface DesktopOpenAiCompatibleControllerOptions {
  configStore?: SharedOpenAiCompatibleConfigStore;
  credentialStore?: SharedOpenAiCompatibleCredentialStore;
}

export class DesktopOpenAiCompatibleController {
  private readonly configStore: SharedOpenAiCompatibleConfigStore;
  private readonly credentialStore: SharedOpenAiCompatibleCredentialStore;
  private catalog = buildDesktopOpenAiCompatibleCatalog([]);
  private readonly resolvedAuthByProviderId = new Map<
    string,
    BrowserGatewayResolvedModelAuthMetadata
  >();

  constructor(options: DesktopOpenAiCompatibleControllerOptions = {}) {
    this.configStore =
      options.configStore ?? new SharedOpenAiCompatibleConfigStore();
    this.credentialStore =
      options.credentialStore ?? createSharedOpenAiCompatibleCredentialStore();
  }

  async initialize(): Promise<void> {
    const document = await this.configStore.read();
    const rawConnections = document?.connections ?? [];
    const normalized = buildDesktopOpenAiCompatibleCatalog(rawConnections);
    const availableAuthKeys = new Set<string>();
    const resolvedAuthByProviderId = new Map<
      string,
      BrowserGatewayResolvedModelAuthMetadata
    >();
    for (const connection of normalized.connections) {
      if (!connection.authKey) continue;
      const bearerToken = await this.credentialStore.get(connection.authKey);
      if (!bearerToken) continue;
      availableAuthKeys.add(connection.authKey);
      resolvedAuthByProviderId.set(connection.providerId, {
        providerId: connection.providerId,
        method: "apiKey",
        bearerToken,
        accountId: connection.authKey,
        accountLabel: connection.displayName,
        canRefresh: false,
      });
    }
    this.catalog = buildDesktopOpenAiCompatibleCatalog(
      rawConnections,
      availableAuthKeys,
    );
    this.resolvedAuthByProviderId.clear();
    for (const [providerId, auth] of resolvedAuthByProviderId) {
      this.resolvedAuthByProviderId.set(providerId, auth);
    }
  }

  getModels() {
    return this.catalog.models;
  }

  getRuntimeProfiles(): BrowserGatewayOpenAiCompatibleRuntimeProfiles {
    return Object.fromEntries(
      this.catalog.connections.map((connection) => [
        connection.providerId,
        connection.runtimeProfile,
      ]),
    );
  }

  hasUsableModel(): boolean {
    return this.catalog.models.some((model) => model.authenticated);
  }

  getCredentialCount(): number {
    return new Set(
      this.catalog.connections.flatMap((connection) =>
        connection.authKey &&
        this.catalog.models.some(
          (model) =>
            model.providerId === connection.providerId && model.authenticated,
        )
          ? [connection.authKey]
          : [],
      ),
    ).size;
  }

  listCredentialProviderIds(): string[] {
    return this.catalog.connections
      .filter((connection) => connection.authKey !== undefined)
      .map((connection) => connection.providerId);
  }

  async resolveModelAuth(
    providerId: string,
  ): Promise<BrowserGatewayResolvedModelAuthMetadata | null> {
    return this.resolvedAuthByProviderId.get(providerId) ?? null;
  }
}
