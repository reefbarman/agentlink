import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type {
  AgentPrincipal,
  ConsumeMcpPendingAuthorizationResult,
  CreateMcpPendingAuthorizationResult,
  McpCredentialRecord,
  McpCredentialRepository,
  McpCredentialRevision,
  McpPendingAuthorization,
  McpPendingAuthorizationRepository,
  ReadMcpCredentialResult,
  ReadMcpPendingAuthorizationResult,
  SaveMcpCredentialResult,
} from "@agentlink/core";

import {
  createKeychainSecretStorage,
  type KeychainSecretStorage,
  type KeychainSecretStorageOptions,
} from "./keychainSecretStorage.js";

const DEFAULT_KEYCHAIN_ACCOUNT = "agentlink-mcp-oauth-v1";
export const SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT =
  "agentlink-standalone-mcp-oauth-v2";
export const CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT = "agentlink-cli-mcp-oauth-v1";
export const DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT =
  "agentlink-desktop-mcp-oauth-v1";
const MAX_LEGACY_STORED_ENTRIES = 200;
const MAX_STORED_ENTRIES = MAX_LEGACY_STORED_ENTRIES * 2;
const MAX_LEGACY_REPLICAS = 8;
const MIGRATION_LOCK_TIMEOUT_MS = 6 * 60_000;

interface StoredCredential<TPrincipal extends AgentPrincipal> {
  record: McpCredentialRecord<TPrincipal>;
  revision: number;
}

interface StoredAuthorization<TPrincipal extends AgentPrincipal> {
  authorization: McpPendingAuthorization<TPrincipal>;
  consumed: boolean;
}

interface LegacyReplicaSnapshot {
  revision: string | null;
  present: boolean;
  credentials: Record<string, string>;
  authorizations: Record<string, string>;
}

interface KeychainMcpCredentialState<TPrincipal extends AgentPrincipal> {
  schemaVersion: 1;
  credentials: Record<string, StoredCredential<TPrincipal>>;
  authorizations: Record<string, StoredAuthorization<TPrincipal>>;
  credentialGeneration?: number;
  legacyReplicas?: Record<string, LegacyReplicaSnapshot>;
}

export interface LegacyMcpCredentialReplica {
  /** Older surface-specific Keychain account to migrate and compatibility-mirror. */
  account: string;
  /** Only this tenant's records are imported from writes made by an older build. */
  tenantId: string;
}

export interface CreateKeychainMcpCredentialRepositoryOptions extends Omit<
  KeychainSecretStorageOptions,
  "account"
> {
  account?: string;
  legacyReplica?: LegacyMcpCredentialReplica;
}

export interface CreateStandaloneMcpCredentialRepositoryOptions extends Omit<
  CreateKeychainMcpCredentialRepositoryOptions,
  "account" | "legacyReplica"
> {
  surface: "cli" | "desktop";
}

/**
 * Native, same-machine MCP OAuth repository. The complete versioned document is
 * kept in one Keychain entry and every mutation is serialized by the shared
 * Keychain storage lock, preserving core compare-and-swap semantics across
 * local host processes.
 */
export class KeychainMcpCredentialRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>
  implements
    McpCredentialRepository<TPrincipal>,
    McpPendingAuthorizationRepository<TPrincipal>
{
  constructor(private readonly storage: KeychainSecretStorage) {}

  /** Explicit operator recovery for an unreadable or forward-version store. */
  async reset(): Promise<void> {
    await this.storage.withMutationLock(async () => {
      await this.storage.delete();
    });
  }

  async readCredential(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
  }): Promise<ReadMcpCredentialResult<TPrincipal>> {
    validateScope(request.principal, request.serverId);
    const state = await this.readState();
    const stored =
      state.credentials[credentialKey(request.principal, request.serverId)];
    return stored
      ? {
          ok: true,
          record: clone(stored.record),
          revision: String(stored.revision),
        }
      : { ok: false, reason: "not_found" };
  }

  async saveCredential(request: {
    readonly record: McpCredentialRecord<TPrincipal>;
    readonly expectedRevision: McpCredentialRevision | undefined;
  }): Promise<SaveMcpCredentialResult> {
    validateCredential(request.record);
    return await this.mutateState<SaveMcpCredentialResult>((state) => {
      const key = credentialKey(
        request.record.principal,
        request.record.serverId,
      );
      const current = state.credentials[key];
      if (!current) {
        if (request.expectedRevision !== undefined) {
          return { result: { ok: false, reason: "not_found" } };
        }
        assertCapacity(state.credentials, key);
        const revision = nextCredentialRevision(state);
        state.credentials[key] = { record: clone(request.record), revision };
        return {
          changed: true,
          result: { ok: true, revision: String(revision) },
        };
      }
      if (request.expectedRevision === undefined) {
        return { result: { ok: false, reason: "already_exists" } };
      }
      if (request.expectedRevision !== String(current.revision)) {
        return {
          result: {
            ok: false,
            reason: "revision_conflict",
            currentRevision: String(current.revision),
          },
        };
      }
      const revision = nextCredentialRevision(state);
      state.credentials[key] = { record: clone(request.record), revision };
      return {
        changed: true,
        result: { ok: true, revision: String(revision) },
      };
    });
  }

  async deleteCredential(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly expectedRevision: McpCredentialRevision;
  }): Promise<SaveMcpCredentialResult> {
    validateScope(request.principal, request.serverId);
    return await this.mutateState<SaveMcpCredentialResult>((state) => {
      const key = credentialKey(request.principal, request.serverId);
      const current = state.credentials[key];
      if (!current) return { result: { ok: false, reason: "not_found" } };
      if (request.expectedRevision !== String(current.revision)) {
        return {
          result: {
            ok: false,
            reason: "revision_conflict",
            currentRevision: String(current.revision),
          },
        };
      }
      delete state.credentials[key];
      return {
        changed: true,
        result: { ok: true, revision: String(current.revision) },
      };
    });
  }

  async createPendingAuthorization(request: {
    readonly authorization: McpPendingAuthorization<TPrincipal>;
  }): Promise<CreateMcpPendingAuthorizationResult> {
    validateAuthorization(request.authorization);
    return await this.mutateState<CreateMcpPendingAuthorizationResult>(
      (state) => {
        pruneAuthorizations(
          state.authorizations,
          request.authorization.createdAt,
        );
        const key = authorizationKey(
          request.authorization.principal,
          request.authorization.serverId,
          request.authorization.transactionId,
        );
        if (state.authorizations[key]) {
          return { result: { ok: false, reason: "already_exists" } };
        }
        assertCapacity(state.authorizations, key);
        state.authorizations[key] = {
          authorization: clone(request.authorization),
          consumed: false,
        };
        return { changed: true, result: { ok: true } };
      },
    );
  }

  async readPendingAuthorization(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly transactionId: string;
  }): Promise<ReadMcpPendingAuthorizationResult<TPrincipal>> {
    validateScope(request.principal, request.serverId);
    requiredText(request.transactionId, "transactionId");
    const state = await this.readState();
    const stored =
      state.authorizations[
        authorizationKey(
          request.principal,
          request.serverId,
          request.transactionId,
        )
      ];
    if (!stored) return { ok: false, reason: "not_found" };
    return stored.consumed
      ? { ok: false, reason: "consumed" }
      : { ok: true, authorization: clone(stored.authorization) };
  }

  async consumePendingAuthorization(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly transactionId: string;
    readonly state: string;
    readonly consumedAt: number;
  }): Promise<ConsumeMcpPendingAuthorizationResult<TPrincipal>> {
    validateScope(request.principal, request.serverId);
    requiredText(request.transactionId, "transactionId");
    requiredText(request.state, "state");
    nonNegativeInteger(request.consumedAt, "consumedAt");
    return await this.mutateState<
      ConsumeMcpPendingAuthorizationResult<TPrincipal>
    >((state) => {
      const key = authorizationKey(
        request.principal,
        request.serverId,
        request.transactionId,
      );
      const stored = state.authorizations[key];
      if (!stored || stored.authorization.state !== request.state) {
        return { result: { ok: false, reason: "not_found" } };
      }
      if (stored.consumed) {
        return { result: { ok: false, reason: "consumed" } };
      }
      if (request.consumedAt > stored.authorization.expiresAt) {
        return { result: { ok: false, reason: "expired" } };
      }
      stored.consumed = true;
      return {
        changed: true,
        result: {
          ok: true,
          authorization: clone(stored.authorization),
        },
      };
    });
  }

  private async readState(): Promise<KeychainMcpCredentialState<TPrincipal>> {
    return parseState<TPrincipal>(await this.storage.get());
  }

  private async mutateState<TResult>(
    operation: (state: KeychainMcpCredentialState<TPrincipal>) => {
      result: TResult;
      changed?: boolean;
    },
  ): Promise<TResult> {
    return await this.storage.withMutationLock(async () => {
      const state = await this.readState();
      const outcome = operation(state);
      if (outcome.changed) await this.storage.store(JSON.stringify(state));
      return outcome.result;
    });
  }
}

/** Shared standalone vault composition; VS Code keeps its mature Memento path. */
export async function createStandaloneMcpCredentialRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateStandaloneMcpCredentialRepositoryOptions,
): Promise<KeychainMcpCredentialRepository<TPrincipal>> {
  const { surface, ...keychain } = options;
  return await createKeychainMcpCredentialRepository<TPrincipal>({
    ...keychain,
    lockTimeoutMs: Math.max(
      keychain.lockTimeoutMs ?? 0,
      MIGRATION_LOCK_TIMEOUT_MS,
    ),
    account: SHARED_STANDALONE_MCP_OAUTH_KEYCHAIN_ACCOUNT,
    legacyReplica:
      surface === "cli"
        ? { account: CLI_MCP_OAUTH_KEYCHAIN_ACCOUNT, tenantId: "local" }
        : {
            account: DESKTOP_MCP_OAUTH_KEYCHAIN_ACCOUNT,
            tenantId: "agentlink-desktop",
          },
  });
}

export async function createKeychainMcpCredentialRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateKeychainMcpCredentialRepositoryOptions = {},
): Promise<KeychainMcpCredentialRepository<TPrincipal>> {
  const { account, legacyReplica, ...storageOptions } = options;
  const primary = await createKeychainSecretStorage({
    ...storageOptions,
    account: account?.trim() || DEFAULT_KEYCHAIN_ACCOUNT,
  });
  const storage = legacyReplica
    ? new LegacyCompatibleMcpStorage(
        primary,
        await createKeychainSecretStorage({
          ...storageOptions,
          account: legacyReplica.account,
        }),
        legacyReplica,
      )
    : primary;
  return new KeychainMcpCredentialRepository<TPrincipal>(storage);
}

/**
 * Keep one shared standalone vault while an older CLI or Desktop build may still
 * use its surface-specific item. The shared item records a non-secret snapshot
 * of the legacy replica, allowing deletions as well as additions to be merged
 * without letting a stale replica erase another surface's records.
 */
class LegacyCompatibleMcpStorage implements KeychainSecretStorage {
  private readonly lockContext = new AsyncLocalStorage<boolean>();
  private synchronizedValue: string | undefined;

  constructor(
    private readonly primary: KeychainSecretStorage,
    private readonly legacy: KeychainSecretStorage,
    private readonly replica: LegacyMcpCredentialReplica,
  ) {
    requiredText(replica.account, "legacyReplica.account");
    requiredText(replica.tenantId, "legacyReplica.tenantId");
  }

  async get(): Promise<string | undefined> {
    if (this.lockContext.getStore()) return await this.synchronizeLocked();
    const fastValue = await this.readFastPath();
    if (fastValue !== undefined) return fastValue;
    return await this.withLocks(async () => await this.synchronizeLocked());
  }

  async store(value: string): Promise<void> {
    await this.withLocks(async () => {
      const state = parseState(value);
      assertLegacyTenantCapacity(state, this.replica.tenantId);
      const snapshot = state.legacyReplicas?.[this.replica.account];
      if (snapshot?.present) {
        await this.writeLegacyThenPrimary(state);
      } else {
        await this.primary.store(JSON.stringify(state));
        this.synchronizedValue = JSON.stringify(state);
      }
    });
  }

  async delete(): Promise<void> {
    await this.withLocks(async () => {
      await this.legacy.delete();
      let state: KeychainMcpCredentialState<AgentPrincipal>;
      try {
        state = parseState(await this.primary.get());
      } catch (error) {
        if (!isInvalidStoredState(error)) throw error;
        await this.primary.delete();
        this.synchronizedValue = undefined;
        return;
      }
      removeTenant(state, this.replica.tenantId);
      setReplicaSnapshot(state, this.replica.account, {
        revision: await this.legacy.getRevision(),
        present: false,
        credentials: {},
        authorizations: {},
      });
      const value = JSON.stringify(state);
      await this.primary.store(value);
      this.synchronizedValue = value;
    });
  }

  async getRevision(): Promise<string | null> {
    return await this.primary.getRevision();
  }

  async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withLocks(operation);
  }

  private async withLocks<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) return await operation();
    return await this.primary.withMutationLock(
      async () =>
        await this.legacy.withMutationLock(
          async () =>
            await this.lockContext.run(true, async () => {
              this.synchronizedValue = undefined;
              try {
                return await operation();
              } finally {
                this.synchronizedValue = undefined;
              }
            }),
        ),
    );
  }

  private async readFastPath(): Promise<string | undefined> {
    const raw = await this.primary.get();
    const state = parseState(raw);
    const previous = state.legacyReplicas?.[this.replica.account];
    if (!previous) return undefined;
    if (previous.revision !== (await this.legacy.getRevision()))
      return undefined;
    return raw ?? JSON.stringify(state);
  }

  private async synchronizeLocked(): Promise<string | undefined> {
    if (this.synchronizedValue !== undefined) return this.synchronizedValue;
    const primary = parseState(await this.primary.get());
    const revision = await this.legacy.getRevision();
    const previous = primary.legacyReplicas?.[this.replica.account];
    if (previous && previous.revision === revision) {
      this.synchronizedValue = JSON.stringify(primary);
      return this.synchronizedValue;
    }

    const legacyRaw = await this.legacy.get();
    if (!legacyRaw) {
      if (previous?.present) {
        mergeLegacyTenant(
          primary,
          emptyState<AgentPrincipal>(),
          previous,
          this.replica.tenantId,
        );
      }
      setReplicaSnapshot(primary, this.replica.account, {
        revision,
        present: false,
        credentials: {},
        authorizations: {},
      });
      const value = JSON.stringify(primary);
      await this.primary.store(value);
      this.synchronizedValue = value;
      return value;
    }

    const legacy = parseState(legacyRaw);
    mergeLegacyTenant(primary, legacy, previous, this.replica.tenantId);
    assertLegacyTenantCapacity(primary, this.replica.tenantId);
    await this.writeLegacyThenPrimary(primary);
    return this.synchronizedValue;
  }

  private async writeLegacyThenPrimary(
    state: KeychainMcpCredentialState<AgentPrincipal>,
  ): Promise<void> {
    setReplicaSnapshot(
      state,
      this.replica.account,
      snapshotFor(state, this.replica.tenantId, null, true),
    );
    await this.legacy.store(
      JSON.stringify(replicaStateFor(state, this.replica.tenantId)),
    );
    setReplicaSnapshot(
      state,
      this.replica.account,
      snapshotFor(
        state,
        this.replica.tenantId,
        await this.legacy.getRevision(),
        true,
      ),
    );
    const value = JSON.stringify(state);
    await this.primary.store(value);
    this.synchronizedValue = value;
  }
}

function emptyState<
  TPrincipal extends AgentPrincipal,
>(): KeychainMcpCredentialState<TPrincipal> {
  return { schemaVersion: 1, credentials: {}, authorizations: {} };
}

function parseState<TPrincipal extends AgentPrincipal>(
  raw: string | undefined,
): KeychainMcpCredentialState<TPrincipal> {
  if (!raw) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("agentlink_mcp_keychain_state_invalid");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("agentlink_mcp_keychain_state_invalid");
  }
  const credentials = parseCredentials<TPrincipal>(parsed.credentials);
  const authorizations = parseAuthorizations<TPrincipal>(parsed.authorizations);
  const credentialGeneration = parseCredentialGeneration(
    parsed.credentialGeneration,
    credentials,
  );
  const legacyReplicas = parseLegacyReplicas(parsed.legacyReplicas);
  return {
    schemaVersion: 1,
    credentials,
    authorizations,
    ...(credentialGeneration === undefined ? {} : { credentialGeneration }),
    ...(legacyReplicas ? { legacyReplicas } : {}),
  };
}

function parseCredentials<TPrincipal extends AgentPrincipal>(
  value: unknown,
): Record<string, StoredCredential<TPrincipal>> {
  if (!isRecord(value) || Object.keys(value).length > MAX_STORED_ENTRIES) {
    throw new Error("agentlink_mcp_keychain_state_invalid");
  }
  const result: Record<string, StoredCredential<TPrincipal>> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.revision) ||
      (candidate.revision as number) < 1
    ) {
      throw new Error("agentlink_mcp_keychain_state_invalid");
    }
    const record = candidate.record as McpCredentialRecord<TPrincipal>;
    validateCredential(record);
    if (key !== credentialKey(record.principal, record.serverId)) {
      throw new Error("agentlink_mcp_keychain_state_invalid");
    }
    result[key] = {
      record: clone(record),
      revision: candidate.revision as number,
    };
  }
  return result;
}

function parseAuthorizations<TPrincipal extends AgentPrincipal>(
  value: unknown,
): Record<string, StoredAuthorization<TPrincipal>> {
  if (!isRecord(value) || Object.keys(value).length > MAX_STORED_ENTRIES) {
    throw new Error("agentlink_mcp_keychain_state_invalid");
  }
  const result: Record<string, StoredAuthorization<TPrincipal>> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isRecord(candidate) || typeof candidate.consumed !== "boolean") {
      throw new Error("agentlink_mcp_keychain_state_invalid");
    }
    const authorization =
      candidate.authorization as McpPendingAuthorization<TPrincipal>;
    validateAuthorization(authorization);
    if (
      key !==
      authorizationKey(
        authorization.principal,
        authorization.serverId,
        authorization.transactionId,
      )
    ) {
      throw new Error("agentlink_mcp_keychain_state_invalid");
    }
    result[key] = {
      authorization: clone(authorization),
      consumed: candidate.consumed,
    };
  }
  return result;
}

function parseCredentialGeneration(
  value: unknown,
  credentials: Record<string, StoredCredential<AgentPrincipal>>,
): number | undefined {
  const storedMaximum = Math.max(
    0,
    ...Object.values(credentials).map(({ revision }) => revision),
  );
  if (value === undefined) return storedMaximum || undefined;
  if (!Number.isSafeInteger(value) || (value as number) < storedMaximum) {
    throw new Error("agentlink_mcp_keychain_state_invalid");
  }
  return value as number;
}

function parseLegacyReplicas(
  value: unknown,
): Record<string, LegacyReplicaSnapshot> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > MAX_LEGACY_REPLICAS) {
    throw new Error("agentlink_mcp_keychain_state_invalid");
  }
  const result: Record<string, LegacyReplicaSnapshot> = {};
  for (const [account, candidate] of Object.entries(value)) {
    if (
      !account.trim() ||
      !isRecord(candidate) ||
      (candidate.revision !== null && typeof candidate.revision !== "string") ||
      typeof candidate.present !== "boolean" ||
      !isRecord(candidate.credentials) ||
      !isRecord(candidate.authorizations)
    ) {
      throw new Error("agentlink_mcp_keychain_state_invalid");
    }
    const credentials: Record<string, string> = {};
    for (const [key, signature] of Object.entries(candidate.credentials)) {
      if (typeof signature !== "string") {
        throw new Error("agentlink_mcp_keychain_state_invalid");
      }
      credentials[key] = signature;
    }
    const authorizations: Record<string, string> = {};
    for (const [key, signature] of Object.entries(candidate.authorizations)) {
      if (typeof signature !== "string") {
        throw new Error("agentlink_mcp_keychain_state_invalid");
      }
      authorizations[key] = signature;
    }
    result[account] = {
      revision: candidate.revision as string | null,
      present: candidate.present,
      credentials,
      authorizations,
    };
  }
  return result;
}

function mergeLegacyTenant(
  primary: KeychainMcpCredentialState<AgentPrincipal>,
  legacy: KeychainMcpCredentialState<AgentPrincipal>,
  previous: LegacyReplicaSnapshot | undefined,
  tenantId: string,
): void {
  const legacyCredentials = ownedCredentials(legacy, tenantId);
  const legacyAuthorizations = ownedAuthorizations(legacy, tenantId);
  assertLegacyTenantCapacity(legacy, tenantId);
  if (previous) {
    for (const key of Object.keys(previous.credentials)) {
      if (!(key in legacyCredentials)) {
        delete primary.credentials[key];
      }
    }
    for (const key of Object.keys(previous.authorizations)) {
      if (!(key in legacyAuthorizations)) delete primary.authorizations[key];
    }
  }
  for (const [key, stored] of Object.entries(legacyCredentials)) {
    if (
      !previous ||
      previous.credentials[key] !== credentialSignature(stored)
    ) {
      const replacement = clone(stored);
      const generation = currentCredentialGeneration(primary);
      if (previous && replacement.revision <= generation) {
        replacement.revision = nextCredentialRevision(primary);
      } else {
        primary.credentialGeneration = Math.max(
          generation,
          replacement.revision,
        );
      }
      primary.credentials[key] = replacement;
    }
  }
  for (const [key, stored] of Object.entries(legacyAuthorizations)) {
    if (
      !previous ||
      previous.authorizations[key] !== authorizationSignature(stored)
    ) {
      primary.authorizations[key] = clone(stored);
    }
  }
  if (
    Object.keys(primary.credentials).length > MAX_STORED_ENTRIES ||
    Object.keys(primary.authorizations).length > MAX_STORED_ENTRIES
  ) {
    throw new Error("agentlink_mcp_keychain_state_full");
  }
}

function assertLegacyTenantCapacity(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  tenantId: string,
): void {
  if (
    Object.keys(ownedCredentials(state, tenantId)).length >
      MAX_LEGACY_STORED_ENTRIES ||
    Object.keys(ownedAuthorizations(state, tenantId)).length >
      MAX_LEGACY_STORED_ENTRIES
  ) {
    throw new Error("agentlink_mcp_keychain_state_full");
  }
}

function replicaStateFor(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  tenantId: string,
): KeychainMcpCredentialState<AgentPrincipal> {
  return {
    schemaVersion: 1,
    credentials: clone(ownedCredentials(state, tenantId)),
    authorizations: clone(ownedAuthorizations(state, tenantId)),
  };
}

function removeTenant(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  tenantId: string,
): void {
  for (const key of Object.keys(ownedCredentials(state, tenantId))) {
    delete state.credentials[key];
  }
  for (const key of Object.keys(ownedAuthorizations(state, tenantId))) {
    delete state.authorizations[key];
  }
}

function isInvalidStoredState(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "agentlink_mcp_keychain_state_invalid"
  );
}

function snapshotFor(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  tenantId: string,
  revision: string | null,
  present: boolean,
): LegacyReplicaSnapshot {
  return {
    revision,
    present,
    credentials: Object.fromEntries(
      Object.entries(ownedCredentials(state, tenantId)).map(([key, stored]) => [
        key,
        credentialSignature(stored),
      ]),
    ),
    authorizations: Object.fromEntries(
      Object.entries(ownedAuthorizations(state, tenantId)).map(
        ([key, stored]) => [key, authorizationSignature(stored)],
      ),
    ),
  };
}

function setReplicaSnapshot(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  account: string,
  snapshot: LegacyReplicaSnapshot,
): void {
  state.legacyReplicas ??= {};
  state.legacyReplicas[account] = snapshot;
}

function ownedCredentials(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  tenantId: string,
): Record<string, StoredCredential<AgentPrincipal>> {
  return Object.fromEntries(
    Object.entries(state.credentials).filter(
      ([, stored]) => stored.record.principal.tenantId === tenantId,
    ),
  );
}

function ownedAuthorizations(
  state: KeychainMcpCredentialState<AgentPrincipal>,
  tenantId: string,
): Record<string, StoredAuthorization<AgentPrincipal>> {
  return Object.fromEntries(
    Object.entries(state.authorizations).filter(
      ([, stored]) => stored.authorization.principal.tenantId === tenantId,
    ),
  );
}

function credentialSignature(stored: StoredCredential<AgentPrincipal>): string {
  return createHash("sha256")
    .update(JSON.stringify([stored.revision, stored.record]))
    .digest("hex");
}

function authorizationSignature(
  stored: StoredAuthorization<AgentPrincipal>,
): string {
  return JSON.stringify([
    stored.authorization.createdAt,
    stored.authorization.expiresAt,
    stored.consumed,
  ]);
}

function validateCredential(record: McpCredentialRecord): void {
  if (!isRecord(record)) throw new Error("agentlink_mcp_credential_invalid");
  validateScope(record.principal, record.serverId);
  if (record.schemaVersion !== 1 || (!record.client && !record.tokens)) {
    throw new Error("agentlink_mcp_credential_invalid");
  }
  nonNegativeInteger(record.updatedAt, "updatedAt");
  if (record.client && !isRecord(record.client)) {
    throw new Error("agentlink_mcp_credential_invalid");
  }
  if (record.tokens && !isRecord(record.tokens)) {
    throw new Error("agentlink_mcp_credential_invalid");
  }
}

function validateAuthorization(record: McpPendingAuthorization): void {
  if (!isRecord(record)) throw new Error("agentlink_mcp_authorization_invalid");
  validateScope(record.principal, record.serverId);
  if (record.schemaVersion !== 1) {
    throw new Error("agentlink_mcp_authorization_invalid");
  }
  requiredText(record.transactionId, "transactionId");
  requiredText(record.redirectUri, "redirectUri");
  requiredText(record.state, "state");
  requiredText(record.codeVerifier, "codeVerifier");
  nonNegativeInteger(record.createdAt, "createdAt");
  nonNegativeInteger(record.expiresAt, "expiresAt");
  if (record.expiresAt <= record.createdAt) {
    throw new Error("agentlink_mcp_authorization_invalid");
  }
}

function validateScope(principal: AgentPrincipal, serverId: string): void {
  if (!isRecord(principal)) throw new Error("agentlink_mcp_scope_invalid");
  requiredText(principal.tenantId, "principal.tenantId");
  requiredText(principal.subjectId, "principal.subjectId");
  requiredText(serverId, "serverId");
}

function credentialKey(principal: AgentPrincipal, serverId: string): string {
  return JSON.stringify([principal.tenantId, principal.subjectId, serverId]);
}

function currentCredentialGeneration(
  state: KeychainMcpCredentialState<AgentPrincipal>,
): number {
  return Math.max(
    state.credentialGeneration ?? 0,
    ...Object.values(state.credentials).map(({ revision }) => revision),
  );
}

function nextCredentialRevision(
  state: KeychainMcpCredentialState<AgentPrincipal>,
): number {
  const revision = currentCredentialGeneration(state) + 1;
  state.credentialGeneration = revision;
  return revision;
}

function authorizationKey(
  principal: AgentPrincipal,
  serverId: string,
  transactionId: string,
): string {
  return JSON.stringify([
    principal.tenantId,
    principal.subjectId,
    serverId,
    transactionId,
  ]);
}

function pruneAuthorizations<TPrincipal extends AgentPrincipal>(
  authorizations: Record<string, StoredAuthorization<TPrincipal>>,
  now: number,
): void {
  for (const [key, stored] of Object.entries(authorizations)) {
    if (stored.authorization.expiresAt < now) delete authorizations[key];
  }
}

function assertCapacity(value: Record<string, unknown>, key: string): void {
  if (!(key in value) && Object.keys(value).length >= MAX_STORED_ENTRIES) {
    throw new Error("agentlink_mcp_keychain_state_full");
  }
}

function requiredText(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new Error(`agentlink_mcp_${field}_invalid`);
  }
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agentlink_mcp_${field}_invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
