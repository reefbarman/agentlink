import type {
  ManageMemoryToolRequest,
  MemoryActivityRequest,
  MemoryInspectionProvider,
  MemoryToolProvider,
  RecallMemoryToolRequest,
} from "../../core/capabilities/memory.js";

import { AutonomousMemoryToolProvider } from "../../storage/retrieval/AutonomousMemoryToolProvider.js";
import type { BrowserGatewayMemoryRuntimeDescriptor } from "../protocol.js";
import type { MemoryHealthSnapshot } from "../../core/memory/contracts.js";

export interface BrowserGatewayMemoryRuntimeOwner {
  ownerId: string;
  mode?: BrowserGatewayMemoryRuntimeDescriptor["mode"];
  retrievalStoreRoot?: string;
}

export interface BrowserGatewayMemoryRuntimeResolution {
  mode: BrowserGatewayMemoryRuntimeDescriptor["mode"];
  retrievalStoreRoot?: string;
  reason?:
    | "no-connected-owner"
    | "missing-owner-descriptor"
    | "disabled-by-owner"
    | "conflicting-store-roots";
}

interface DisposableMemoryToolProvider
  extends MemoryToolProvider, MemoryInspectionProvider {
  dispose(): Promise<void>;
}

export interface BrowserGatewayAutonomousMemoryRuntimeOptions {
  createProvider?: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => DisposableMemoryToolProvider;
}

export class BrowserGatewayAutonomousMemoryRuntime implements DisposableMemoryToolProvider {
  private owners: readonly BrowserGatewayMemoryRuntimeOwner[] = [];
  private resolution: BrowserGatewayMemoryRuntimeResolution = {
    mode: "off",
    reason: "no-connected-owner",
  };
  private provider: DisposableMemoryToolProvider | undefined;
  private providerRoot: string | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly createProvider: (
    descriptor: BrowserGatewayMemoryRuntimeDescriptor,
  ) => DisposableMemoryToolProvider;

  constructor(options: BrowserGatewayAutonomousMemoryRuntimeOptions = {}) {
    this.createProvider =
      options.createProvider ??
      ((descriptor) =>
        new AutonomousMemoryToolProvider({
          root: descriptor.retrievalStoreRoot,
          getMode: () => this.resolution.mode,
        }));
  }

  async setOwners(
    owners: readonly BrowserGatewayMemoryRuntimeOwner[],
  ): Promise<BrowserGatewayMemoryRuntimeResolution> {
    const copiedOwners = owners.map((owner) => ({ ...owner }));
    return await this.runExclusive(async () => {
      this.owners = copiedOwners;
      const next = resolveBrowserGatewayMemoryRuntime(this.owners);
      if (
        this.provider &&
        (next.mode !== "autonomous" ||
          next.retrievalStoreRoot !== this.providerRoot)
      ) {
        await this.provider.dispose();
        this.provider = undefined;
        this.providerRoot = undefined;
      }
      this.resolution = next;
      return this.getResolution();
    });
  }

  getResolution(): BrowserGatewayMemoryRuntimeResolution {
    return { ...this.resolution };
  }

  async manage(request: ManageMemoryToolRequest) {
    return await this.runExclusive(() =>
      this.requireProvider().manage(request),
    );
  }

  async recall(request: RecallMemoryToolRequest) {
    return await this.runExclusive(() =>
      this.requireProvider().recall(request),
    );
  }

  async health(): Promise<MemoryHealthSnapshot> {
    return await this.runExclusive(async () => {
      if (this.resolution.mode !== "autonomous") {
        return unavailableHealth(this.resolution.reason);
      }
      return await this.requireProvider().health();
    });
  }

  async activity(request: MemoryActivityRequest) {
    return await this.runExclusive(() =>
      this.requireProvider().activity(request),
    );
  }

  async query(...args: Parameters<MemoryInspectionProvider["query"]>) {
    return await this.runExclusive(() => this.requireProvider().query(...args));
  }

  async detail(...args: Parameters<MemoryInspectionProvider["detail"]>) {
    return await this.runExclusive(() =>
      this.requireProvider().detail(...args),
    );
  }

  async manageAsUser(
    ...args: Parameters<MemoryInspectionProvider["manageAsUser"]>
  ) {
    return await this.runExclusive(() =>
      this.requireProvider().manageAsUser(...args),
    );
  }

  async clearScope(
    ...args: Parameters<MemoryInspectionProvider["clearScope"]>
  ) {
    return await this.runExclusive(() =>
      this.requireProvider().clearScope(...args),
    );
  }

  async exportArchive(
    ...args: Parameters<MemoryInspectionProvider["exportArchive"]>
  ) {
    return await this.runExclusive(() =>
      this.requireProvider().exportArchive(...args),
    );
  }

  async importArchive(
    ...args: Parameters<MemoryInspectionProvider["importArchive"]>
  ) {
    return await this.runExclusive(() =>
      this.requireProvider().importArchive(...args),
    );
  }

  async dispose(): Promise<void> {
    await this.runExclusive(async () => {
      const provider = this.provider;
      this.provider = undefined;
      this.providerRoot = undefined;
      if (provider) await provider.dispose();
    });
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireProvider(): DisposableMemoryToolProvider {
    if (
      this.resolution.mode !== "autonomous" ||
      !this.resolution.retrievalStoreRoot
    ) {
      throw new Error(
        `Autonomous memory is unavailable in Browser Ask Agent: ${this.resolution.reason ?? "disabled"}.`,
      );
    }
    if (!this.provider) {
      this.provider = this.createProvider({
        mode: "autonomous",
        retrievalStoreRoot: this.resolution.retrievalStoreRoot,
      });
      this.providerRoot = this.resolution.retrievalStoreRoot;
    }
    return this.provider;
  }
}

export function resolveBrowserGatewayMemoryRuntime(
  owners: readonly BrowserGatewayMemoryRuntimeOwner[],
): BrowserGatewayMemoryRuntimeResolution {
  if (owners.length === 0) {
    return { mode: "off", reason: "no-connected-owner" };
  }

  if (
    owners.some(
      (owner) => owner.mode === undefined || !owner.retrievalStoreRoot,
    )
  ) {
    return { mode: "off", reason: "missing-owner-descriptor" };
  }

  const roots = new Set(owners.map((owner) => owner.retrievalStoreRoot));
  if (roots.size !== 1) {
    return { mode: "off", reason: "conflicting-store-roots" };
  }

  const retrievalStoreRoot = owners[0]!.retrievalStoreRoot!;
  if (owners.some((owner) => owner.mode !== "autonomous")) {
    return {
      mode: "off",
      retrievalStoreRoot,
      reason: "disabled-by-owner",
    };
  }

  return { mode: "autonomous", retrievalStoreRoot };
}

function unavailableHealth(
  reason: BrowserGatewayMemoryRuntimeResolution["reason"],
): MemoryHealthSnapshot {
  return {
    status: "unavailable",
    retrieval: "unavailable",
    crud: false,
    dedupe: false,
    conflict: false,
    auditUndo: false,
    recordCount: 0,
    activeRecordCount: 0,
    auditEventCount: 0,
    reason: reason ?? "disabled",
  };
}
