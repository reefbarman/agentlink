import type {
  DerivedSessionInspection,
  DerivedSessionRecallRequest,
  DerivedSessionRecallResult,
  DerivedSessionScope,
  PublishDerivedSessionRequest,
} from "../../core/session/DerivedSessionRetrievalService.js";
import { DerivedSessionRetrievalService } from "../../core/session/DerivedSessionRetrievalService.js";
import { LanceDbRetrievalRepository } from "../../storage/retrieval/LanceDbRetrievalRepository.js";
import type { BrowserGatewayMemoryRuntimeDescriptor } from "../protocol.js";
import {
  migrateBrowserGatewayAskAgentMemory,
  type BrowserGatewayAskAgentMemoryMigrationResult,
} from "./browserGatewayAskAgentMemoryMigration.js";

export interface BrowserGatewayDerivedSessionOwner {
  ownerId: string;
  retrievalStoreRoot?: string;
}

export interface BrowserGatewayDerivedSessionRuntimeResolution {
  status: "ready" | "unavailable";
  retrievalStoreRoot?: string;
  reason?:
    | "no-connected-owner"
    | "missing-owner-descriptor"
    | "conflicting-store-roots"
    | "migration-failed";
  detail?: string;
  migration?: BrowserGatewayAskAgentMemoryMigrationResult;
}

export interface BrowserGatewayDerivedSessionProvider {
  initialize(): Promise<BrowserGatewayAskAgentMemoryMigrationResult>;
  publish(request: PublishDerivedSessionRequest): Promise<void>;
  recall(
    request: DerivedSessionRecallRequest,
  ): Promise<DerivedSessionRecallResult[]>;
  deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }): Promise<"deleted" | "stale_source" | "not_found">;
  clearScope(request: {
    scope: DerivedSessionScope;
    surface?: string;
  }): Promise<{ sourcesDeleted: number; recordsRemoved: number }>;
  inspect(request?: {
    scopes?: DerivedSessionScope[];
    surfaces?: string[];
  }): Promise<DerivedSessionInspection>;
  dispose(): Promise<void>;
}

export interface BrowserGatewayDerivedSessionRuntimeOptions {
  createProvider?: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => BrowserGatewayDerivedSessionProvider;
}

export class BrowserGatewayDerivedSessionRuntime implements BrowserGatewayDerivedSessionProvider {
  private resolution: BrowserGatewayDerivedSessionRuntimeResolution = {
    status: "unavailable",
    reason: "no-connected-owner",
  };
  private provider: BrowserGatewayDerivedSessionProvider | undefined;
  private providerRoot: string | undefined;
  private initialization: Promise<void> | undefined;
  private readonly createProvider: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => BrowserGatewayDerivedSessionProvider;

  constructor(options: BrowserGatewayDerivedSessionRuntimeOptions = {}) {
    this.createProvider =
      options.createProvider ??
      ((descriptor) => new LanceDbDerivedSessionProvider(descriptor));
  }

  async setOwners(
    owners: readonly BrowserGatewayDerivedSessionOwner[],
  ): Promise<BrowserGatewayDerivedSessionRuntimeResolution> {
    const next = resolveBrowserGatewayDerivedSessionRuntime(owners);
    if (
      this.provider &&
      (next.status !== "ready" ||
        next.retrievalStoreRoot !== this.providerRoot ||
        this.resolution.reason === "migration-failed")
    ) {
      await this.provider.dispose();
      this.provider = undefined;
      this.providerRoot = undefined;
      this.initialization = undefined;
    }
    this.resolution = next;
    if (next.status === "ready" && next.retrievalStoreRoot) {
      await this.ensureInitialized(next.retrievalStoreRoot);
    }
    return this.getResolution();
  }

  getResolution(): BrowserGatewayDerivedSessionRuntimeResolution {
    return structuredClone(this.resolution);
  }

  async initialize(): Promise<BrowserGatewayAskAgentMemoryMigrationResult> {
    const provider = await this.requireProvider();
    return await provider.initialize();
  }

  async publish(request: PublishDerivedSessionRequest): Promise<void> {
    await (await this.requireProvider()).publish(request);
  }

  async recall(
    request: DerivedSessionRecallRequest,
  ): Promise<DerivedSessionRecallResult[]> {
    return await (await this.requireProvider()).recall(request);
  }

  async deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }): Promise<"deleted" | "stale_source" | "not_found"> {
    return await (await this.requireProvider()).deleteSession(request);
  }

  async clearScope(request: {
    scope: DerivedSessionScope;
    surface?: string;
  }): Promise<{ sourcesDeleted: number; recordsRemoved: number }> {
    return await (await this.requireProvider()).clearScope(request);
  }

  async inspect(request?: {
    scopes?: DerivedSessionScope[];
    surfaces?: string[];
  }): Promise<DerivedSessionInspection> {
    return await (await this.requireProvider()).inspect(request);
  }

  async dispose(): Promise<void> {
    const provider = this.provider;
    this.provider = undefined;
    this.providerRoot = undefined;
    this.initialization = undefined;
    if (provider) await provider.dispose();
  }

  private async ensureInitialized(root: string): Promise<void> {
    if (!this.provider) {
      this.provider = this.createProvider({
        mode: "off",
        retrievalStoreRoot: root,
      });
      this.providerRoot = root;
    }
    if (!this.initialization) {
      this.initialization = this.provider
        .initialize()
        .then((migration) => {
          this.resolution = {
            status: "ready",
            retrievalStoreRoot: root,
            migration,
          };
          if (migration.status === "missing") {
            this.initialization = undefined;
          }
        })
        .catch((error) => {
          this.resolution = {
            status: "unavailable",
            retrievalStoreRoot: root,
            reason: "migration-failed",
            detail: error instanceof Error ? error.message : String(error),
          };
          throw error;
        });
    }
    await this.initialization;
  }

  private async requireProvider(): Promise<BrowserGatewayDerivedSessionProvider> {
    if (
      this.resolution.status !== "ready" ||
      !this.resolution.retrievalStoreRoot
    ) {
      throw new Error(
        `Derived session retrieval is unavailable in Browser Ask Agent: ${this.resolution.reason ?? "unavailable"}${this.resolution.detail ? ` (${this.resolution.detail})` : ""}.`,
      );
    }
    await this.ensureInitialized(this.resolution.retrievalStoreRoot);
    return this.provider!;
  }
}

export function resolveBrowserGatewayDerivedSessionRuntime(
  owners: readonly BrowserGatewayDerivedSessionOwner[],
): BrowserGatewayDerivedSessionRuntimeResolution {
  if (owners.length === 0) {
    return { status: "unavailable", reason: "no-connected-owner" };
  }
  if (owners.some((owner) => !owner.retrievalStoreRoot?.trim())) {
    return { status: "unavailable", reason: "missing-owner-descriptor" };
  }
  const roots = new Set(owners.map((owner) => owner.retrievalStoreRoot));
  if (roots.size !== 1) {
    return { status: "unavailable", reason: "conflicting-store-roots" };
  }
  return {
    status: "ready",
    retrievalStoreRoot: owners[0]!.retrievalStoreRoot!,
  };
}

class LanceDbDerivedSessionProvider implements BrowserGatewayDerivedSessionProvider {
  private readonly repository: LanceDbRetrievalRepository;
  private readonly service: DerivedSessionRetrievalService;
  private migration:
    | Promise<BrowserGatewayAskAgentMemoryMigrationResult>
    | undefined;

  constructor(descriptor: BrowserGatewayMemoryRuntimeDescriptor) {
    this.repository = new LanceDbRetrievalRepository({
      root: descriptor.retrievalStoreRoot,
    });
    this.service = new DerivedSessionRetrievalService(this.repository);
  }

  initialize(): Promise<BrowserGatewayAskAgentMemoryMigrationResult> {
    this.migration ??= migrateBrowserGatewayAskAgentMemory({
      service: this.service,
    }).then((result) => {
      if (result.status === "missing") this.migration = undefined;
      return result;
    });
    return this.migration;
  }

  async publish(request: PublishDerivedSessionRequest): Promise<void> {
    const outcome = await this.service.upsert(request);
    if (outcome.status !== "published") {
      throw new Error(
        `Derived session publication was not committed: ${outcome.status}`,
      );
    }
  }

  async recall(request: DerivedSessionRecallRequest) {
    return await this.service.recall(request);
  }

  async deleteSession(request: {
    sessionId: string;
    surface: string;
    scope: DerivedSessionScope;
    expectedRevision?: string;
  }) {
    return await this.service.deleteSession(request);
  }

  async clearScope(request: { scope: DerivedSessionScope; surface?: string }) {
    return await this.service.clearScope(request);
  }

  async inspect(request?: {
    scopes?: DerivedSessionScope[];
    surfaces?: string[];
  }) {
    return await this.service.inspect(request);
  }

  async dispose(): Promise<void> {
    await this.repository.close();
  }
}
