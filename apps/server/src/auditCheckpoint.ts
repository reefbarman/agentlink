import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "./atomicFile.js";

/**
 * Audit checkpoints: the audit log's head (sequence number and hash),
 * signed with this assistant's Ed25519 key and kept in the append-only
 * backup store (the witness), through the backup sidecar.
 *
 * The local hash chain detects a changed or shortened log, but not one
 * rewritten consistently with its head. A checkpoint in the witness cannot
 * be changed or removed from here, so a rewritten log no longer has the
 * checkpointed hash at that sequence number. The signature says a
 * checkpoint came from this assistant; the witness's append-only rule is
 * what stops it being replaced. Entries after the latest checkpoint are
 * protected by the local chain only.
 *
 * The key that signed the witness's first checkpoint is the one trusted:
 * checkpoints signed with another key are rejected, and a local key that
 * differs from it is reported, so replacing the key does not hide a
 * rewrite either.
 */

/** Checkpoints are stored as snapshots of this restic host and tag. */
export const CHECKPOINT_HOST = "agentlink-audit";
export const CHECKPOINT_TAG = "audit-checkpoint";
/** `data/credentials/<file>`. */
export const SIGNING_KEY_FILE = "audit-signing.key";
const TAG_PREFIX = "cp1.";
const SIGNED_PREFIX = "agentlink-audit-checkpoint\n";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
/** At most this many problems are listed. */
const MAX_PROBLEMS = 5;

export interface AuditCheckpoint {
  readonly v: 1;
  readonly seq: number;
  readonly hash: string;
  readonly at: number;
  /** The signer's Ed25519 public key, raw, base64. */
  readonly publicKey: string;
}

/** A checkpoint as sent to the witness: the exact payload and its signature. */
export interface SignedCheckpoint {
  readonly payload: string;
  /** base64 */
  readonly signature: string;
}

/** A checkpoint as listed from the witness, oldest first. */
export interface StoredCheckpoint extends SignedCheckpoint {
  readonly snapshotId: string;
  /** When the witness stored it (ISO). */
  readonly time: string;
}

export interface CheckpointSigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
}

export function checkpointKeyFile(dataRoot: string): string {
  return path.join(dataRoot, "credentials", SIGNING_KEY_FILE);
}

function publicKeyText(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
}

/** Read the signing key, creating it (mode 600) on first use. */
export async function loadCheckpointKey(
  file: string,
  options: { readonly create?: boolean } = {},
): Promise<CheckpointSigningKey | undefined> {
  let pem: string | undefined;
  try {
    pem = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pem === undefined) {
    if (options.create === false) return undefined;
    const pair = generateKeyPairSync("ed25519");
    pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Never replace a key another process created meanwhile.
    await fs
      .writeFile(file, pem, { mode: 0o600, flag: "wx" })
      .catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        pem = await fs.readFile(file, "utf8");
      });
  }
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${file} is not an Ed25519 key`);
  }
  return { privateKey, publicKey: publicKeyText(createPublicKey(privateKey)) };
}

export function signCheckpoint(
  key: CheckpointSigningKey,
  head: { readonly seq: number; readonly hash: string; readonly at: number },
): SignedCheckpoint {
  const checkpoint: AuditCheckpoint = {
    v: 1,
    seq: head.seq,
    hash: head.hash,
    at: head.at,
    publicKey: key.publicKey,
  };
  const payload = JSON.stringify(checkpoint);
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(SIGNED_PREFIX + payload, "utf8"),
      key.privateKey,
    ).toString("base64"),
  };
}

/** The checkpoint, when its shape is right and its own key signed it. */
export function readCheckpoint(
  signed: SignedCheckpoint,
): AuditCheckpoint | undefined {
  let parsed: Partial<AuditCheckpoint>;
  try {
    parsed = JSON.parse(signed.payload) as Partial<AuditCheckpoint>;
  } catch {
    return undefined;
  }
  if (
    parsed.v !== 1 ||
    !Number.isSafeInteger(parsed.seq) ||
    parsed.seq! < 1 ||
    typeof parsed.hash !== "string" ||
    !HASH_PATTERN.test(parsed.hash) ||
    !Number.isSafeInteger(parsed.at) ||
    typeof parsed.publicKey !== "string"
  ) {
    return undefined;
  }
  const raw = Buffer.from(parsed.publicKey, "base64");
  const signature = Buffer.from(signed.signature, "base64");
  if (raw.length !== 32 || signature.length !== 64) return undefined;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    const valid = verify(
      null,
      Buffer.from(SIGNED_PREFIX + signed.payload, "utf8"),
      key,
      signature,
    );
    return valid ? (parsed as AuditCheckpoint) : undefined;
  } catch {
    return undefined;
  }
}

/** A checkpoint as one restic tag (no commas or spaces). */
export function checkpointTag(signed: SignedCheckpoint): string {
  return `${TAG_PREFIX}${Buffer.from(signed.payload, "utf8").toString("base64url")}.${Buffer.from(signed.signature, "base64").toString("base64url")}`;
}

export function parseCheckpointTag(tag: string): SignedCheckpoint | undefined {
  if (!tag.startsWith(TAG_PREFIX)) return undefined;
  const [payload, signature, extra] = tag.slice(TAG_PREFIX.length).split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  return {
    payload: Buffer.from(payload, "base64url").toString("utf8"),
    signature: Buffer.from(signature, "base64url").toString("base64"),
  };
}

/** Whether a request body is a plausible signed checkpoint (the witness side). */
export function isSignedCheckpoint(value: unknown): value is SignedCheckpoint {
  if (!value || typeof value !== "object") return false;
  const { payload, signature } = value as Record<string, unknown>;
  return (
    typeof payload === "string" &&
    payload.length > 0 &&
    payload.length <= 1_000 &&
    typeof signature === "string" &&
    /^[A-Za-z0-9+/]{86}==$/u.test(signature)
  );
}

export interface CheckpointVerification {
  readonly ok: boolean;
  /** Checkpoints signed by the trusted key and compared with the log. */
  readonly checked: number;
  /** Checkpoints with a bad signature or another key: ignored. */
  readonly rejected: number;
  /** The latest checked checkpoint. */
  readonly latest?: { readonly seq: number; readonly at: number };
  /** In plain words; empty when the log matches every checkpoint. */
  readonly problems: readonly string[];
}

/**
 * Compare the log (its entries' hashes, in order) with the witness's
 * checkpoints (oldest first). `publicKey` is this assistant's key.
 */
export function verifyCheckpoints(options: {
  readonly hashes: readonly string[];
  readonly checkpoints: readonly StoredCheckpoint[];
  readonly publicKey: string;
}): CheckpointVerification {
  const problems: string[] = [];
  let rejected = 0;
  const valid: AuditCheckpoint[] = [];
  for (const stored of options.checkpoints) {
    const checkpoint = readCheckpoint(stored);
    if (checkpoint) valid.push(checkpoint);
    else rejected += 1;
  }
  // The witness keeps them in the order they arrived.
  const trusted = valid[0]?.publicKey;
  if (trusted && trusted !== options.publicKey) {
    problems.push(
      "this assistant's signing key is not the one that signed its first checkpoint (the key, and maybe the log, were replaced)",
    );
  }
  const accepted = valid.filter((checkpoint) => {
    if (checkpoint.publicKey === trusted) return true;
    rejected += 1;
    return false;
  });
  const when = (at: number) =>
    new Date(at).toISOString().replace("T", " ").slice(0, 16);
  for (const checkpoint of accepted) {
    if (checkpoint.seq > options.hashes.length) {
      problems.push(
        `the checkpoint of ${when(checkpoint.at)} UTC is at entry ${checkpoint.seq}, but the log has ${options.hashes.length} (entries were removed)`,
      );
    } else if (options.hashes[checkpoint.seq - 1] !== checkpoint.hash) {
      problems.push(
        `entry ${checkpoint.seq} is not the one checkpointed at ${when(checkpoint.at)} UTC (the log was rewritten)`,
      );
    }
  }
  const latest = accepted.reduce<AuditCheckpoint | undefined>(
    (best, checkpoint) =>
      !best || checkpoint.seq > best.seq ? checkpoint : best,
    undefined,
  );
  const unique = [...new Set(problems)];
  return {
    ok: unique.length === 0,
    checked: accepted.length,
    rejected,
    ...(latest ? { latest: { seq: latest.seq, at: latest.at } } : {}),
    problems:
      unique.length > MAX_PROBLEMS
        ? [
            ...unique.slice(0, MAX_PROBLEMS),
            `and ${unique.length - MAX_PROBLEMS} more`,
          ]
        : unique,
  };
}

/** Where checkpoints go: the backup sidecar, in the server. */
export interface CheckpointWitness {
  write(signed: SignedCheckpoint): Promise<{ readonly snapshotId: string }>;
  list(): Promise<readonly StoredCheckpoint[]>;
}

export interface CheckpointStatus {
  readonly publicKey: string;
  readonly lastCheckpoint?: {
    readonly seq: number;
    readonly hash: string;
    readonly at: number;
    readonly snapshotId: string;
  };
  /** The last attempt failed (newer than the last checkpoint). */
  readonly lastFailure?: { readonly at: number; readonly error: string };
  /** Entries written since the last checkpoint. */
  readonly pending: number;
  readonly lastVerification?: CheckpointVerification & {
    readonly at: number;
  };
}

interface StoredState {
  readonly schemaVersion: 1;
  readonly lastCheckpoint?: CheckpointStatus["lastCheckpoint"];
  readonly lastFailure?: CheckpointStatus["lastFailure"];
  readonly lastVerification?: CheckpointStatus["lastVerification"];
}

/** Checkpoint at least this often while the log changes. */
export const CHECKPOINT_INTERVAL_MS = 60 * 60 * 1_000;
/** How often the writer looks (and retries a failed checkpoint). */
const TICK_MS = 10 * 60 * 1_000;

export interface AuditCheckpointer {
  status(): CheckpointStatus;
  /** An external effect was recorded: checkpoint it straight away. */
  effectRecorded(): void;
  /** Checkpoint the current head if it is not yet (tests, and the tick). */
  checkpointNow(): Promise<void>;
  /** Compare the log with the witness now. */
  verifyNow(): Promise<CheckpointVerification | undefined>;
  close(): Promise<void>;
}

export async function startAuditCheckpointer(options: {
  readonly key: CheckpointSigningKey;
  readonly witness: CheckpointWitness;
  /** The log's head, after the writes so far. */
  readonly head: () => Promise<
    { readonly seq: number; readonly hash: string } | undefined
  >;
  /** The log's entry hashes, in order (the good part of a broken log). */
  readonly hashes: () => Promise<readonly string[]>;
  readonly stateFile: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** The first failure after a success (or ever). */
  readonly onFailure?: (error: string) => void;
  /** The log stopped matching its checkpoints (or the problems changed). */
  readonly onMismatch?: (problems: readonly string[]) => void;
  /** Off in tests. */
  readonly schedule?: boolean;
}): Promise<AuditCheckpointer> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  let state = await readState(options.stateFile);
  let pending = 0;
  let effectPending = false;
  let chain: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const save = async (next: StoredState) => {
    state = next;
    await fs.mkdir(path.dirname(options.stateFile), {
      recursive: true,
      mode: 0o700,
    });
    await writeFileAtomic(options.stateFile, `${JSON.stringify(next)}\n`);
  };
  const refreshPending = async () => {
    const head = await options.head();
    pending = Math.max(0, (head?.seq ?? 0) - (state.lastCheckpoint?.seq ?? 0));
    return head;
  };
  // One at a time, in order.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const verifyNow = () =>
    serial(async () => {
      let checkpoints: readonly StoredCheckpoint[];
      try {
        checkpoints = await options.witness.list();
      } catch (error) {
        log(`Audit checkpoints: could not read the witness: ${text(error)}`);
        return undefined;
      }
      const result = verifyCheckpoints({
        hashes: await options.hashes(),
        checkpoints,
        publicKey: options.key.publicKey,
      });
      const before = state.lastVerification;
      await save({ ...state, lastVerification: { ...result, at: now() } });
      if (
        !result.ok &&
        (before?.ok !== false ||
          before.problems.join("\n") !== result.problems.join("\n"))
      ) {
        log(
          `Audit log does not match its checkpoints: ${result.problems.join("; ")}`,
        );
        options.onMismatch?.(result.problems);
      }
      return result;
    });

  const write = async (): Promise<boolean> => {
    const head = await refreshPending();
    if (!head || pending === 0) {
      effectPending = false;
      return false;
    }
    const at = now();
    try {
      const { snapshotId } = await options.witness.write(
        signCheckpoint(options.key, { ...head, at }),
      );
      const { lastFailure: _failure, ...rest } = state;
      await save({
        ...rest,
        schemaVersion: 1,
        lastCheckpoint: { seq: head.seq, hash: head.hash, at, snapshotId },
      });
      pending = 0;
      effectPending = false;
      return true;
    } catch (error) {
      const message = text(error);
      const first =
        !state.lastFailure ||
        (state.lastCheckpoint !== undefined &&
          state.lastCheckpoint.at > state.lastFailure.at);
      await save({ ...state, lastFailure: { at: now(), error: message } });
      log(`Audit checkpoint failed (retried in 10 minutes): ${message}`);
      if (first) options.onFailure?.(message);
      return false;
    }
  };

  const checkpointNow = async () => {
    const wrote = await serial(write);
    if (wrote) await verifyNow();
  };

  const tick = async () => {
    try {
      await refreshPending();
      const last = state.lastCheckpoint?.at;
      const failed =
        state.lastFailure !== undefined &&
        (last === undefined || state.lastFailure.at > last);
      if (
        pending > 0 &&
        (effectPending ||
          failed ||
          last === undefined ||
          now() - last >= CHECKPOINT_INTERVAL_MS)
      ) {
        await checkpointNow();
      }
      const verified = state.lastVerification?.at;
      if (
        verified === undefined ||
        now() - verified >= CHECKPOINT_INTERVAL_MS
      ) {
        await verifyNow();
      }
    } catch (error) {
      log(`Audit checkpoints: ${text(error)}`);
    }
  };

  const scheduleNext = (delay: number) => {
    if (closed || options.schedule === false) return;
    timer = setTimeout(() => {
      void tick().finally(() => scheduleNext(TICK_MS));
    }, delay);
    timer.unref();
  };

  await refreshPending();
  // Soon after starting: catches up on anything written while it was down.
  scheduleNext(60_000);

  return {
    status: () => ({
      publicKey: options.key.publicKey,
      ...(state.lastCheckpoint ? { lastCheckpoint: state.lastCheckpoint } : {}),
      ...(state.lastFailure &&
      (!state.lastCheckpoint || state.lastFailure.at > state.lastCheckpoint.at)
        ? { lastFailure: state.lastFailure }
        : {}),
      pending,
      ...(state.lastVerification
        ? { lastVerification: state.lastVerification }
        : {}),
    }),
    effectRecorded() {
      effectPending = true;
      if (closed) return;
      void checkpointNow().catch((error: unknown) => {
        log(`Audit checkpoint failed: ${text(error)}`);
      });
    },
    checkpointNow,
    verifyNow,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await chain;
    },
  };
}

async function readState(file: string): Promise<StoredState> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(file, "utf8"),
    ) as Partial<StoredState>;
    if (parsed.schemaVersion === 1) return parsed as StoredState;
  } catch {
    // Missing or unreadable: the next checkpoint starts it again.
  }
  return { schemaVersion: 1 };
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
