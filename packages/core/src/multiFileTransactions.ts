import type { AgentPrincipal } from "./modelIdentity.js";

/** One content-addressed replacement in a host-owned multi-file transaction. */
export interface MultiFileWriteChange {
  /** Canonical absolute host path; never an ambient workspace-relative path. */
  readonly path: string;
  /** SHA-256 of the exact baseline content the replacement was computed from. */
  readonly expectedContentHash: string;
  readonly content: string;
}

/** Principal and turn scope for a prepared multi-file write set. */
export interface MultiFileWriteTransactionScope<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface PrepareMultiFileWriteTransactionRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends MultiFileWriteTransactionScope<TPrincipal> {
  /** The provider must stage this complete ordered set as one durable unit. */
  readonly changes: readonly MultiFileWriteChange[];
}

export type PrepareMultiFileWriteTransactionResult =
  | { readonly ok: true; readonly transactionId: string }
  | {
      readonly ok: false;
      readonly reason:
        | "conflict"
        | "transaction_unavailable"
        | "invalid_change_set";
    };

export interface CommitMultiFileWriteTransactionRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends MultiFileWriteTransactionScope<TPrincipal> {
  readonly transactionId: string;
}

export type CommitMultiFileWriteTransactionResult =
  | { readonly ok: true; readonly status: "committed" }
  | {
      readonly ok: false;
      /** The provider has retained enough durable state for explicit recovery. */
      readonly reason: "commit_failed" | "recovery_required" | "not_found";
      readonly recoveryId?: string;
    };

export interface RecoverMultiFileWriteTransactionRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends MultiFileWriteTransactionScope<TPrincipal> {
  readonly transactionId: string;
  readonly recoveryId?: string;
}

export type RecoverMultiFileWriteTransactionResult =
  | { readonly ok: true; readonly status: "committed" | "rolled_back" }
  | { readonly ok: false; readonly reason: "not_found" | "recovery_failed" };

/**
 * Host-owned durable batch-write boundary. The host must atomically validate and
 * durably stage the whole content-addressed set in prepare(), then either commit
 * the complete set or retain recovery state. Core and node-host deliberately do
 * not assume Git, a filesystem journal, a database, or a review UI.
 */
export interface MultiFileWriteTransactionProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  prepare(
    request: PrepareMultiFileWriteTransactionRequest<TPrincipal>,
  ): Promise<PrepareMultiFileWriteTransactionResult>;
  commit(
    request: CommitMultiFileWriteTransactionRequest<TPrincipal>,
  ): Promise<CommitMultiFileWriteTransactionResult>;
  recover(
    request: RecoverMultiFileWriteTransactionRequest<TPrincipal>,
  ): Promise<RecoverMultiFileWriteTransactionResult>;
}
