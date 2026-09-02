import type { AgentPrincipal } from "./modelIdentity.js";

export type McpCredentialRevision = string;

/** Opaque OAuth client registration or token payload owned by the embedding host. */
export type McpCredentialPayload = Readonly<Record<string, unknown>>;

/**
 * Durable OAuth material scoped to one authenticated principal and stable MCP
 * server identity. Core never logs, serializes to events, or interprets secrets.
 */
export interface McpCredentialRecord<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly schemaVersion: 1;
  readonly principal: TPrincipal;
  readonly serverId: string;
  readonly client?: McpCredentialPayload;
  readonly tokens?: McpCredentialPayload;
  readonly updatedAt: number;
}

export type ReadMcpCredentialResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | {
      readonly ok: true;
      readonly record: McpCredentialRecord<TPrincipal>;
      readonly revision: McpCredentialRevision;
    }
  | { readonly ok: false; readonly reason: "not_found" };

export type SaveMcpCredentialResult =
  | { readonly ok: true; readonly revision: McpCredentialRevision }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "already_exists" | "revision_conflict";
      readonly currentRevision?: McpCredentialRevision;
    };

/**
 * Host-owned credential storage. Persist only server-side encrypted material;
 * implementations must compare revisions atomically within principal/server scope.
 */
export interface McpCredentialRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readCredential(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
  }): Promise<ReadMcpCredentialResult<TPrincipal>>;
  saveCredential(request: {
    readonly record: McpCredentialRecord<TPrincipal>;
    /** `undefined` creates a record; a value performs compare-and-swap. */
    readonly expectedRevision: McpCredentialRevision | undefined;
  }): Promise<SaveMcpCredentialResult>;
  deleteCredential(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly expectedRevision: McpCredentialRevision;
  }): Promise<SaveMcpCredentialResult>;
}

/** A short-lived, single-use OAuth callback transaction; the callback host owns delivery. */
export interface McpPendingAuthorization<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly principal: TPrincipal;
  readonly serverId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type CreateMcpPendingAuthorizationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "already_exists" };

export type ReadMcpPendingAuthorizationResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | {
      readonly ok: true;
      readonly authorization: McpPendingAuthorization<TPrincipal>;
    }
  | { readonly ok: false; readonly reason: "not_found" | "consumed" };

export type ConsumeMcpPendingAuthorizationResult<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | {
      readonly ok: true;
      readonly authorization: McpPendingAuthorization<TPrincipal>;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "expired" | "consumed";
    };

/**
 * Host-owned pending transaction storage. `consume` must be atomic and
 * single-use, including across multiple callback workers.
 */
export interface McpPendingAuthorizationRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  createPendingAuthorization(request: {
    readonly authorization: McpPendingAuthorization<TPrincipal>;
  }): Promise<CreateMcpPendingAuthorizationResult>;
  readPendingAuthorization(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly transactionId: string;
  }): Promise<ReadMcpPendingAuthorizationResult<TPrincipal>>;
  consumePendingAuthorization(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly transactionId: string;
    readonly state: string;
    readonly consumedAt: number;
  }): Promise<ConsumeMcpPendingAuthorizationResult<TPrincipal>>;
}

/** Deterministic test adapter; production hosts provide encrypted durable storage. */
export class InMemoryMcpCredentialRepository<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>
  implements
    McpCredentialRepository<TPrincipal>,
    McpPendingAuthorizationRepository<TPrincipal>
{
  private readonly credentials = new Map<
    string,
    { record: McpCredentialRecord<TPrincipal>; revisionNumber: number }
  >();
  private readonly authorizations = new Map<
    string,
    { authorization: McpPendingAuthorization<TPrincipal>; consumed: boolean }
  >();

  async readCredential(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
  }): Promise<ReadMcpCredentialResult<TPrincipal>> {
    validateScope(request.principal, request.serverId);
    const stored = this.credentials.get(
      credentialKey(request.principal, request.serverId),
    );
    if (!stored) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      record: clone(stored.record),
      revision: revision(stored.revisionNumber),
    };
  }

  async saveCredential(request: {
    readonly record: McpCredentialRecord<TPrincipal>;
    readonly expectedRevision: McpCredentialRevision | undefined;
  }): Promise<SaveMcpCredentialResult> {
    validateCredential(request.record);
    const key = credentialKey(
      request.record.principal,
      request.record.serverId,
    );
    const stored = this.credentials.get(key);
    if (!stored) {
      if (request.expectedRevision !== undefined)
        return { ok: false, reason: "not_found" };
      this.credentials.set(key, {
        record: clone(request.record),
        revisionNumber: 1,
      });
      return { ok: true, revision: revision(1) };
    }
    if (request.expectedRevision === undefined)
      return { ok: false, reason: "already_exists" };
    if (request.expectedRevision !== revision(stored.revisionNumber)) {
      return {
        ok: false,
        reason: "revision_conflict",
        currentRevision: revision(stored.revisionNumber),
      };
    }
    stored.revisionNumber += 1;
    stored.record = clone(request.record);
    return { ok: true, revision: revision(stored.revisionNumber) };
  }

  async deleteCredential(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly expectedRevision: McpCredentialRevision;
  }): Promise<SaveMcpCredentialResult> {
    validateScope(request.principal, request.serverId);
    const key = credentialKey(request.principal, request.serverId);
    const stored = this.credentials.get(key);
    if (!stored) return { ok: false, reason: "not_found" };
    if (request.expectedRevision !== revision(stored.revisionNumber)) {
      return {
        ok: false,
        reason: "revision_conflict",
        currentRevision: revision(stored.revisionNumber),
      };
    }
    this.credentials.delete(key);
    return { ok: true, revision: revision(stored.revisionNumber) };
  }

  async createPendingAuthorization(request: {
    readonly authorization: McpPendingAuthorization<TPrincipal>;
  }): Promise<CreateMcpPendingAuthorizationResult> {
    validatePendingAuthorization(request.authorization);
    const key = authorizationKey(
      request.authorization.principal,
      request.authorization.serverId,
      request.authorization.transactionId,
    );
    if (this.authorizations.has(key))
      return { ok: false, reason: "already_exists" };
    this.authorizations.set(key, {
      authorization: clone(request.authorization),
      consumed: false,
    });
    return { ok: true };
  }

  async readPendingAuthorization(request: {
    readonly principal: TPrincipal;
    readonly serverId: string;
    readonly transactionId: string;
  }): Promise<ReadMcpPendingAuthorizationResult<TPrincipal>> {
    validateScope(request.principal, request.serverId);
    requiredText(request.transactionId, "transactionId");
    const stored = this.authorizations.get(
      authorizationKey(
        request.principal,
        request.serverId,
        request.transactionId,
      ),
    );
    if (!stored) return { ok: false, reason: "not_found" };
    if (stored.consumed) return { ok: false, reason: "consumed" };
    return { ok: true, authorization: clone(stored.authorization) };
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
    const stored = this.authorizations.get(
      authorizationKey(
        request.principal,
        request.serverId,
        request.transactionId,
      ),
    );
    if (!stored || stored.authorization.state !== request.state) {
      return { ok: false, reason: "not_found" };
    }
    if (stored.consumed) return { ok: false, reason: "consumed" };
    if (request.consumedAt > stored.authorization.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    stored.consumed = true;
    return { ok: true, authorization: clone(stored.authorization) };
  }
}

function validateCredential(record: McpCredentialRecord): void {
  validateScope(record.principal, record.serverId);
  if (record.schemaVersion !== 1)
    throw new Error("MCP credential schemaVersion must be 1");
  nonNegativeInteger(record.updatedAt, "credential updatedAt");
  if (!record.client && !record.tokens) {
    throw new Error("MCP credential record requires client or tokens");
  }
  if (record.client) validatePayload(record.client, "client");
  if (record.tokens) validatePayload(record.tokens, "tokens");
}

function validatePendingAuthorization(record: McpPendingAuthorization): void {
  validateScope(record.principal, record.serverId);
  if (record.schemaVersion !== 1)
    throw new Error("MCP pending authorization schemaVersion must be 1");
  requiredText(record.transactionId, "transactionId");
  requiredText(record.redirectUri, "redirectUri");
  requiredText(record.state, "state");
  requiredText(record.codeVerifier, "codeVerifier");
  nonNegativeInteger(record.createdAt, "createdAt");
  nonNegativeInteger(record.expiresAt, "expiresAt");
  if (record.expiresAt <= record.createdAt) {
    throw new Error(
      "MCP pending authorization expiresAt must follow createdAt",
    );
  }
}

function validatePayload(payload: McpCredentialPayload, field: string): void {
  if (
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    throw new Error(`MCP credential ${field} must be a plain object`);
  }
}

function validateScope(principal: AgentPrincipal, serverId: string): void {
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

function revision(value: number): McpCredentialRevision {
  return String(value);
}

function requiredText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`MCP ${field} must not be empty`);
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`MCP ${field} must be a non-negative integer`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
