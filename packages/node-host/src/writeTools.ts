import {
  defineTool,
  type AgentPrincipal,
  type HostToolResolver,
  type MultiFileWriteChange,
  type MultiFileWriteTransactionProvider,
} from "@agentlink/core";
import {
  APPLY_DIFF_INPUT_GRAMMAR,
  planApplyDiff,
  type ApplyDiffBlockOption,
} from "@agentlink/core/apply-diff";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  createNodeHostLocalFileSystem,
  type NodeHostFileSystem,
} from "./fileSystem.js";

const MAX_FILE_BYTES = 1_000_000;
const MAX_MULTI_FILE_CHANGES = 20;

export type NodeWriteGrantKind = "file" | "directory";

/** A host-approved target scope for one write turn. No ambient project root exists. */
export interface NodeHostWriteGrant {
  readonly rootPath: string;
  readonly kind: NodeWriteGrantKind;
}

export interface ResolveNodeHostWriteGrantsRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
}

export type ResolveNodeHostWriteGrants<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveNodeHostWriteGrantsRequest<TPrincipal>,
) => readonly NodeHostWriteGrant[] | Promise<readonly NodeHostWriteGrant[]>;

export interface CreateNodeHostWriteToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  /** Resolve explicit grants separately for the authenticated principal/session/turn. */
  readonly resolveGrants: ResolveNodeHostWriteGrants<TPrincipal>;
  /** Maximum UTF-8 content size accepted for one replacement. */
  readonly maxFileBytes?: number;
  /**
   * Filesystem used for grant resolution, preconditions, locks, and the
   * atomic write. Defaults to this machine's filesystem.
   */
  readonly fileSystem?: NodeHostFileSystem;
}

export interface CreateNodeHostApplyDiffToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends CreateNodeHostWriteToolsOptions<TPrincipal> {
  /**
   * `required` (default): the model must send `expectedContentHash`.
   * `host_prepared`: the schema marks it optional because the host's
   * authorizer pins the reviewed baseline through `preparedInput`. Execution
   * always requires the hash either way.
   */
  readonly contentHashInput?: "required" | "host_prepared";
}

const MAX_APPLY_DIFF_BLOCK_OPTIONS = 64;

export interface CreateNodeHostMultiFileWriteToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends CreateNodeHostWriteToolsOptions<TPrincipal> {
  /** Host-owned durable prepare/commit/recovery implementation. */
  readonly transactions: MultiFileWriteTransactionProvider<TPrincipal>;
  readonly maxChanges?: number;
}

/**
 * Create the narrow C5 direct-write closure. Every call requires core approval,
 * an explicit host grant, and a content-addressed precondition. This is not an
 * interactive diff/review surface and does not infer a workspace or HOME.
 */
export function createNodeHostWriteTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostWriteToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> {
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes ?? MAX_FILE_BYTES,
    "maxFileBytes",
    MAX_FILE_BYTES,
  );
  const files = options.fileSystem ?? createNodeHostLocalFileSystem();

  return async (request) => {
    const grants = await resolveGrantedRoots(
      files,
      options.resolveGrants,
      request,
    );
    return [
      defineTool<TPrincipal>({
        name: "write_file",
        description:
          "Replace one text file only inside an explicit host-approved write grant. Existing files require their SHA-256 content hash; new files require expectedAbsent=true.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            content: { type: "string" },
            expectedContentHash: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
            },
            expectedAbsent: { type: "boolean" },
          },
          required: ["path", "content"],
          additionalProperties: false,
          allOf: [
            {
              oneOf: [
                {
                  properties: {
                    expectedContentHash: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                  },
                  required: ["expectedContentHash"],
                },
                {
                  properties: { expectedAbsent: { const: true } },
                  required: ["expectedAbsent"],
                },
              ],
            },
          ],
        },
        effect: "write",
        authorization: "required",
        displayInput: (input) => ({ path: input.path }),
        handler: async (input, context) => {
          if (!sameTurn(request, context)) return error("write_turn_mismatch");
          const content =
            typeof input.content === "string" ? input.content : "";
          if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
            return error("file_too_large");
          }
          const target = await resolveWriteTarget(files, input.path, grants);
          if (!target.ok) return error(target.error);
          return await withWriteLock(files, target.path, async () => {
            const precondition = await verifyPrecondition(files, target, input);
            if (!precondition.ok) return error(precondition.error);
            const committed = await atomicWrite(files, target.path, content, {
              expectedAbsent: !precondition.existed,
              expectedContentHash: precondition.existed
                ? String(input.expectedContentHash)
                : undefined,
            });
            if (!committed.ok) return error(committed.error);
            const operation = precondition.existed ? "modified" : "created";
            return {
              modelContent: JSON.stringify({
                path: target.path,
                operation,
                contentHash: committed.contentHash,
                bytes: Buffer.byteLength(content, "utf8"),
                durability: committed.durability,
              }),
              displayContent: {
                path: target.path,
                operation,
                contentHash: committed.contentHash,
                durability: committed.durability,
              },
            };
          });
        },
      }),
    ];
  };
}

/**
 * Create VS Code's `apply_diff` over an explicit write grant: SEARCH/REPLACE
 * or unified hunks, whitespace/escape-tolerant matching, `block_options`
 * occurrence/replace_all selection, `atomic`, and VS Code's result and
 * failure payloads (`@agentlink/core/apply-diff`). Every write is pinned to a
 * SHA-256 baseline, so the written content is exactly what `planApplyDiff`
 * produced for that baseline. Core approval is required.
 */
export function createNodeHostApplyDiffTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostApplyDiffToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> {
  const hostPrepared = options.contentHashInput === "host_prepared";
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes ?? MAX_FILE_BYTES,
    "maxFileBytes",
    MAX_FILE_BYTES,
  );
  const files = options.fileSystem ?? createNodeHostLocalFileSystem();

  return async (request) => {
    const grants = await resolveGrantedRoots(
      files,
      options.resolveGrants,
      request,
    );
    return [
      defineTool<TPrincipal>({
        name: "apply_diff",
        description: hostPrepared
          ? "Edit one existing granted text file with SEARCH/REPLACE blocks or unified-diff hunks. Each block requires a unique match by default; block_options can select a 1-based occurrence or replace all exact matches, and atomic=true requires every block to succeed. The host reviews the exact result before writing."
          : "Edit one existing granted, SHA-256-pinned text file with SEARCH/REPLACE blocks or unified-diff hunks. Each block requires a unique match by default; block_options can select a 1-based occurrence or replace all exact matches, and atomic=true requires every block to succeed.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            diff: {
              type: "string",
              minLength: 1,
              maxLength: MAX_FILE_BYTES,
              description: APPLY_DIFF_INPUT_GRAMMAR,
            },
            block_options: {
              type: "array",
              maxItems: MAX_APPLY_DIFF_BLOCK_OPTIONS,
              description:
                "Optional per-block controls. Use occurrence to select a 1-based exact/flexible/escape-normalized match, or replace_all to replace every exact match. Unlisted blocks retain unique-match safety.",
              items: {
                type: "object",
                properties: {
                  index: {
                    type: "integer",
                    minimum: 0,
                    description:
                      "Zero-based positional SEARCH/REPLACE block index, counting malformed block slots before the target",
                  },
                  occurrence: {
                    type: "integer",
                    minimum: 1,
                    description:
                      "Select this 1-based matching occurrence for the block",
                  },
                  replace_all: {
                    type: "boolean",
                    const: true,
                    description:
                      "Replace every exact occurrence for this block",
                  },
                },
                required: ["index"],
                additionalProperties: false,
              },
            },
            atomic: {
              type: "boolean",
              description:
                "When true, require every parsed block to succeed and no malformed blocks before review or applying any change.",
            },
            expectedContentHash: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
              ...(hostPrepared
                ? {
                    description:
                      "Optional SHA-256 of the file you read. When omitted, the host pins the baseline it reviews.",
                  }
                : {}),
            },
          },
          required: hostPrepared
            ? ["path", "diff"]
            : ["path", "diff", "expectedContentHash"],
          additionalProperties: false,
        },
        effect: "write",
        authorization: "required",
        displayInput: (input) => ({ path: input.path }),
        handler: async (input, context) => {
          if (!sameTurn(request, context)) return error("write_turn_mismatch");
          const target = await resolveWriteTarget(files, input.path, grants);
          if (!target.ok) return error(target.error);
          if (typeof input.diff !== "string" || !input.diff) {
            return error("invalid_diff");
          }
          const diff = input.diff;
          return await withWriteLock(files, target.path, async () => {
            const current = await readPinnedText(
              files,
              target,
              input.expectedContentHash,
            );
            if (!current.ok) return error(current.error);
            const plan = planApplyDiff(target.path, current.content, {
              diff,
              block_options: applyDiffBlockOptions(input.block_options),
              atomic: input.atomic === true,
            });
            if (plan.status === "failed") {
              return {
                modelContent: JSON.stringify(plan.payload),
                displayContent: {
                  path: target.path,
                  error: plan.payload.error,
                },
                isError: true,
              };
            }
            const baselineHash = String(input.expectedContentHash);
            if (!plan.changed) {
              const display = {
                status: "accepted",
                path: target.path,
                operation: "modified",
                contentHash: baselineHash,
                post_edit_content_hash: baselineHash,
                ...plan.report,
              };
              return {
                modelContent: JSON.stringify(display),
                displayContent: display,
              };
            }
            if (Buffer.byteLength(plan.content, "utf8") > maxFileBytes) {
              return error("file_too_large");
            }
            const committed = await atomicWrite(
              files,
              target.path,
              plan.content,
              {
                expectedAbsent: false,
                expectedContentHash: baselineHash,
              },
            );
            if (!committed.ok) return error(committed.error);
            const result = {
              status: "accepted",
              path: target.path,
              operation: "modified",
              contentHash: committed.contentHash,
              post_edit_content_hash: committed.contentHash,
              durability: committed.durability,
              ...plan.report,
            };
            return {
              modelContent: JSON.stringify(result),
              displayContent: result,
            };
          });
        },
      }),
    ];
  };
}

/**
 * Create a transaction-backed C5 multi-file replacement resolver. The provider
 * never loops over files to emulate atomicity; the embedding host owns durable
 * staging, commit, and recovery through MultiFileWriteTransactionProvider.
 */
export function createNodeHostMultiFileWriteTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateNodeHostMultiFileWriteToolsOptions<TPrincipal>,
): HostToolResolver<TPrincipal> {
  const maxChanges = boundedPositiveInteger(
    options.maxChanges ?? MAX_MULTI_FILE_CHANGES,
    "maxChanges",
    MAX_MULTI_FILE_CHANGES,
  );
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes ?? MAX_FILE_BYTES,
    "maxFileBytes",
    MAX_FILE_BYTES,
  );
  const files = options.fileSystem ?? createNodeHostLocalFileSystem();

  return async (request) => {
    const grants = await resolveGrantedRoots(
      files,
      options.resolveGrants,
      request,
    );
    return [
      defineTool<TPrincipal>({
        name: "apply_multi_file",
        description:
          "Apply a host-transaction-backed, hash-pinned replacement set to explicit granted files. The host stages, commits, and recovers the whole set atomically.",
        inputSchema: {
          type: "object",
          properties: {
            changes: {
              type: "array",
              minItems: 1,
              maxItems: MAX_MULTI_FILE_CHANGES,
              items: {
                type: "object",
                properties: {
                  path: { type: "string", minLength: 1 },
                  expectedContentHash: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                  content: { type: "string" },
                },
                required: ["path", "expectedContentHash", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["changes"],
          additionalProperties: false,
        },
        effect: "write",
        authorization: "required",
        displayInput: (input) => ({
          files: Array.isArray(input.changes) ? input.changes.length : 0,
        }),
        handler: async (input, context) => {
          if (!sameTurn(request, context)) return error("write_turn_mismatch");
          const resolved = await resolveMultiFileChanges(
            files,
            input.changes,
            grants,
            maxChanges,
            maxFileBytes,
          );
          if (!resolved.ok) return error(resolved.error);
          const prepared = await options.transactions.prepare({
            ...request,
            changes: resolved.changes,
          });
          if (!prepared.ok) return error(`transaction_${prepared.reason}`);
          const committed = await options.transactions.commit({
            ...request,
            transactionId: prepared.transactionId,
          });
          if (!committed.ok) {
            return {
              modelContent: JSON.stringify({
                error: `transaction_${committed.reason}`,
                transactionId: prepared.transactionId,
                ...(committed.recoveryId
                  ? { recoveryId: committed.recoveryId }
                  : {}),
              }),
              displayContent: {
                transactionId: prepared.transactionId,
                isError: true,
                ...(committed.recoveryId
                  ? { recoveryId: committed.recoveryId }
                  : {}),
              },
              isError: true,
            };
          }
          return {
            modelContent: JSON.stringify({
              transactionId: prepared.transactionId,
              status: committed.status,
              changes: resolved.changes.map(
                ({ path, expectedContentHash, content }) => ({
                  path,
                  expectedContentHash,
                  contentHash: contentHash(content),
                }),
              ),
            }),
            displayContent: {
              transactionId: prepared.transactionId,
              status: committed.status,
              files: resolved.changes.length,
            },
          };
        },
      }),
    ];
  };
}

async function resolveMultiFileChanges(
  files: NodeHostFileSystem,
  input: unknown,
  grants: readonly GrantedRoot[],
  maxChanges: number,
  maxFileBytes: number,
): Promise<
  | { readonly ok: true; readonly changes: readonly MultiFileWriteChange[] }
  | { readonly ok: false; readonly error: string }
> {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > maxChanges
  ) {
    return { ok: false, error: "invalid_change_set" };
  }
  const changes: MultiFileWriteChange[] = [];
  const paths = new Set<string>();
  for (const change of input) {
    if (!isRecord(change)) return { ok: false, error: "invalid_change_set" };
    const target = await resolveWriteTarget(files, change.path, grants);
    if (!target.ok) return target;
    if (paths.has(target.path))
      return { ok: false, error: "duplicate_change_path" };
    const expectedContentHash = change.expectedContentHash;
    const content = change.content;
    if (
      typeof expectedContentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedContentHash) ||
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > maxFileBytes
    ) {
      return { ok: false, error: "invalid_change_set" };
    }
    paths.add(target.path);
    changes.push({ path: target.path, expectedContentHash, content });
  }
  return { ok: true, changes };
}

interface GrantedRoot {
  readonly path: string;
  readonly kind: NodeWriteGrantKind;
}

async function resolveGrantedRoots<TPrincipal extends AgentPrincipal>(
  files: NodeHostFileSystem,
  resolveGrants: ResolveNodeHostWriteGrants<TPrincipal>,
  request: ResolveNodeHostWriteGrantsRequest<TPrincipal>,
): Promise<readonly GrantedRoot[]> {
  const roots: GrantedRoot[] = [];
  for (const grant of await resolveGrants(request)) {
    if (
      (grant.kind !== "file" && grant.kind !== "directory") ||
      !path.isAbsolute(grant.rootPath)
    ) {
      continue;
    }
    const realPath = await files
      .realpath(grant.rootPath)
      .catch(() => undefined);
    if (realPath) roots.push({ path: realPath, kind: grant.kind });
  }
  return roots;
}

type WriteTarget =
  | { readonly ok: true; readonly path: string; readonly rootPath: string }
  | { readonly ok: false; readonly error: string };

async function resolveWriteTarget(
  files: NodeHostFileSystem,
  input: unknown,
  grants: readonly GrantedRoot[],
): Promise<WriteTarget> {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    return { ok: false, error: "absolute_path_required" };
  }
  const requested = path.resolve(input);
  const existing = await files.realpath(requested).catch(() => undefined);
  if (existing) {
    if (existing !== requested) return { ok: false, error: "path_alias" };
    for (const grant of grants) {
      if (
        (grant.kind === "file" && existing === grant.path) ||
        (grant.kind === "directory" && isPathWithin(existing, grant.path))
      ) {
        return { ok: true, path: existing, rootPath: grant.path };
      }
    }
    return { ok: false, error: "path_not_granted" };
  }

  const parent = await files
    .realpath(path.dirname(requested))
    .catch(() => undefined);
  if (!parent) return { ok: false, error: "parent_not_found" };
  if (parent !== path.dirname(requested)) {
    return { ok: false, error: "path_alias" };
  }
  for (const grant of grants) {
    if (grant.kind !== "directory" || !isPathWithin(parent, grant.path)) {
      continue;
    }
    const destination = path.join(parent, path.basename(requested));
    return { ok: true, path: destination, rootPath: grant.path };
  }
  return { ok: false, error: "path_not_granted" };
}

async function readPinnedText(
  files: NodeHostFileSystem,
  target: Extract<WriteTarget, { ok: true }>,
  expectedHash: unknown,
): Promise<
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string }
> {
  if (typeof expectedHash !== "string") {
    return { ok: false, error: "expected_content_hash_required" };
  }
  const stat = await files.lstat(target.path).catch(() => undefined);
  if (!stat) return { ok: false, error: "expected_file_missing" };
  if (stat.kind !== "file" || stat.nlink > 1) {
    return { ok: false, error: "not_a_private_regular_file" };
  }
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
  const bytes = await files.readFile(target.path).catch(() => undefined);
  if (!bytes) return { ok: false, error: "file_unreadable" };
  if (contentHash(bytes) !== expectedHash) {
    return { ok: false, error: "content_hash_mismatch" };
  }
  return { ok: true, content: bytes.toString("utf8") };
}

/** Read already schema-validated `block_options` into the engine's shape. */
export function applyDiffBlockOptions(
  value: unknown,
): ApplyDiffBlockOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((option) => ({
    index: Number(option.index),
    ...(option.occurrence !== undefined
      ? { occurrence: Number(option.occurrence) }
      : {}),
    ...(option.replace_all === true ? { replace_all: true as const } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function verifyPrecondition(
  files: NodeHostFileSystem,
  target: Extract<WriteTarget, { ok: true }>,
  input: Record<string, unknown>,
): Promise<
  | { readonly ok: true; readonly existed: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const stat = await files.lstat(target.path).catch(() => undefined);
  const expectedAbsent = input.expectedAbsent === true;
  const expectedHash = input.expectedContentHash;
  if (!stat) {
    return expectedAbsent
      ? { ok: true, existed: false }
      : { ok: false, error: "expected_file_missing" };
  }
  if (stat.kind !== "file" || stat.nlink > 1) {
    return { ok: false, error: "not_a_private_regular_file" };
  }
  if (expectedAbsent) return { ok: false, error: "expected_file_absent" };
  if (typeof expectedHash !== "string") {
    return { ok: false, error: "expected_content_hash_required" };
  }
  const bytes = await files.readFile(target.path).catch(() => undefined);
  if (!bytes) return { ok: false, error: "file_unreadable" };
  return contentHash(bytes) === expectedHash
    ? { ok: true, existed: true }
    : { ok: false, error: "content_hash_mismatch" };
}

interface WriteLockOwner {
  readonly version: 1;
  readonly ownerNonce: string;
  readonly hostname: string;
  readonly pid: number;
}

async function withWriteLock<T>(
  files: NodeHostFileSystem,
  destination: string,
  operation: () => Promise<T>,
): Promise<T | ReturnType<typeof error>> {
  const lockPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.agentlink-write.lock`,
  );
  const owner: WriteLockOwner = {
    version: 1,
    ownerNonce: randomUUID(),
    hostname: os.hostname(),
    pid: process.pid,
  };
  if (!(await acquireWriteLock(files, lockPath, owner))) {
    return error("write_locked");
  }
  try {
    return await operation();
  } finally {
    await releaseWriteLock(files, lockPath, owner.ownerNonce).catch(
      () => undefined,
    );
  }
}

async function acquireWriteLock(
  files: NodeHostFileSystem,
  lockPath: string,
  owner: WriteLockOwner,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporary = `${lockPath}.${owner.ownerNonce}.tmp`;
    try {
      await files.createFile(temporary, `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
      });
      await files.link(temporary, lockPath);
      await files.unlink(temporary).catch(() => undefined);
      return true;
    } catch (lockError) {
      await files.unlink(temporary).catch(() => undefined);
      if (!hasCode(lockError, "EEXIST")) return false;
    }
    if (!(await reclaimDeadWriteLock(files, lockPath))) return false;
  }
  return false;
}

async function reclaimDeadWriteLock(
  files: NodeHostFileSystem,
  lockPath: string,
): Promise<boolean> {
  const owner = await readWriteLock(files, lockPath);
  if (!owner || owner.hostname !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (lockError) {
    if (!hasCode(lockError, "ESRCH")) return false;
  }
  const current = await readWriteLock(files, lockPath);
  if (!current || current.ownerNonce !== owner.ownerNonce) return false;
  try {
    await files.unlink(lockPath);
    return true;
  } catch (lockError) {
    return hasCode(lockError, "ENOENT");
  }
}

async function readWriteLock(
  files: NodeHostFileSystem,
  lockPath: string,
): Promise<WriteLockOwner | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(
      (await files.readFile(lockPath)).toString("utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.ownerNonce !== "string" ||
    !value.ownerNonce ||
    typeof value.hostname !== "string" ||
    !value.hostname ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    ownerNonce: value.ownerNonce,
    hostname: value.hostname,
    pid: Number(value.pid),
  };
}

async function releaseWriteLock(
  files: NodeHostFileSystem,
  lockPath: string,
  ownerNonce: string,
): Promise<void> {
  const current = await readWriteLock(files, lockPath);
  if (!current || current.ownerNonce !== ownerNonce) return;
  await files.unlink(lockPath).catch((lockError: unknown) => {
    if (!hasCode(lockError, "ENOENT")) throw lockError;
  });
}

interface NodeHostWriteDurabilityEvidence {
  readonly status: "durable";
  readonly outcome: "exact";
  readonly policy: "preserve_exact";
  readonly final_exists: true;
  readonly final_content_hash: string;
  readonly requires_reread: false;
}

async function atomicWrite(
  files: NodeHostFileSystem,
  destination: string,
  content: string,
  baseline: {
    readonly expectedAbsent: boolean;
    readonly expectedContentHash: string | undefined;
  },
): Promise<
  | {
      readonly ok: true;
      readonly contentHash: string;
      readonly durability: NodeHostWriteDurabilityEvidence;
    }
  | { readonly ok: false; readonly error: string }
> {
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.agentlink-${randomUUID()}.tmp`,
  );
  try {
    await files.createFile(temporary, Buffer.from(content, "utf8"), {
      mode: 0o600,
    });
    const current = await verifyStagedWriteBaseline(
      files,
      destination,
      baseline,
    );
    if (!current.ok) return current;
    await files.rename(temporary, destination);
    await files.chmod(destination, 0o600).catch(() => undefined);
    await files.syncDirectory(directory);
    const finalStat = await files.lstat(destination).catch(() => undefined);
    if (finalStat?.kind !== "file" || finalStat.nlink > 1) {
      return { ok: false, error: "post_write_verification_failed" };
    }
    const finalBytes = await files.readFile(destination).catch(() => undefined);
    if (!finalBytes || finalBytes.toString("utf8") !== content) {
      return { ok: false, error: "post_write_verification_failed" };
    }
    const finalContentHash = contentHash(finalBytes);
    return {
      ok: true,
      contentHash: finalContentHash,
      durability: {
        status: "durable",
        outcome: "exact",
        policy: "preserve_exact",
        final_exists: true,
        final_content_hash: finalContentHash,
        requires_reread: false,
      },
    };
  } catch {
    return { ok: false, error: "write_failed" };
  } finally {
    await files.unlink(temporary).catch(() => undefined);
  }
}

async function verifyStagedWriteBaseline(
  files: NodeHostFileSystem,
  destination: string,
  baseline: {
    readonly expectedAbsent: boolean;
    readonly expectedContentHash: string | undefined;
  },
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const stat = await files.lstat(destination).catch(() => undefined);
  if (!stat) {
    return baseline.expectedAbsent
      ? { ok: true }
      : { ok: false, error: "expected_file_missing" };
  }
  if (stat.kind !== "file" || stat.nlink > 1) {
    return { ok: false, error: "not_a_private_regular_file" };
  }
  if (baseline.expectedAbsent) {
    return { ok: false, error: "expected_file_absent" };
  }
  const bytes = await files.readFile(destination).catch(() => undefined);
  if (!bytes) return { ok: false, error: "file_unreadable" };
  return contentHash(bytes) === baseline.expectedContentHash
    ? { ok: true }
    : { ok: false, error: "content_hash_mismatch" };
}

function sameTurn<TPrincipal extends AgentPrincipal>(
  discovery: ResolveNodeHostWriteGrantsRequest<TPrincipal>,
  invocation: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
  },
): boolean {
  return (
    discovery.principal.tenantId === invocation.principal.tenantId &&
    discovery.principal.subjectId === invocation.principal.subjectId &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function hasCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function error(code: string) {
  return { modelContent: JSON.stringify({ error: code }), isError: true };
}
