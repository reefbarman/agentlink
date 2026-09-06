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
const MAX_STORED_ENTRIES = 200;

interface StoredCredential<TPrincipal extends AgentPrincipal> {
  record: McpCredentialRecord<TPrincipal>;
  revision: number;
}

interface StoredAuthorization<TPrincipal extends AgentPrincipal> {
  authorization: McpPendingAuthorization<TPrincipal>;
  consumed: boolean;
}

interface KeychainMcpCredentialState<TPrincipal extends AgentPrincipal> {
  schemaVersion: 1;
  credentials: Record<string, StoredCredential<TPrincipal>>;
  authorizations: Record<string, StoredAuthorization<TPrincipal>>;
}

export interface CreateKeychainMcpCredentialRepositoryOptions extends Omit<
  KeychainSecretStorageOptions,
  "account"
> {
  account?: string;
}

/**
 * Native, same-machine MCP OAuth repository. The complete versioned document is
 * kept in one Keychain entry and every mutation is serialized by the shared
 * Keychain storage lock, preserving core compare-and-swap semantics across
 * Desktop and extension-host processes.
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
        state.credentials[key] = { record: clone(request.record), revision: 1 };
        return { changed: true, result: { ok: true, revision: "1" } };
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
      const revision = current.revision + 1;
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

export async function createKeychainMcpCredentialRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateKeychainMcpCredentialRepositoryOptions = {},
): Promise<KeychainMcpCredentialRepository<TPrincipal>> {
  const storage = await createKeychainSecretStorage({
    ...options,
    account: options.account?.trim() || DEFAULT_KEYCHAIN_ACCOUNT,
  });
  return new KeychainMcpCredentialRepository<TPrincipal>(storage);
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
  return { schemaVersion: 1, credentials, authorizations };
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
