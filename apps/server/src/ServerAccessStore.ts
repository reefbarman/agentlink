import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { syncDirectory, writeFileAtomic } from "./atomicFile.js";
import {
  FileLockHeldError,
  acquireFileLock,
  releaseFileLock,
} from "./fileLock.js";

const STATE_FILE = "access-state.json";
const LOCK_FILE = "access-state.lock";
const LOCAL_PAIRING_FILE = "local-pairing.json";
const DEFAULT_LOCAL_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_LOCAL_PAIRING_FILE_BYTES = 4_096;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000;
const MAX_ACTIVE_PAIRINGS = 5;
/**
 * Wrong codes tolerated across all clients before every outstanding code is
 * withdrawn. With six digits this keeps the chance of a guess landing far
 * below one in ten thousand, whatever the per-address rate limit allows.
 */
export const MAX_FAILED_PAIRING_ATTEMPTS = 10;
const MAX_LABEL_LENGTH = 80;
export const PAIRING_CODE_PATTERN = /^[0-9]{6}$/u;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type ServerAccessErrorCode =
  | "invalid_pairing_code"
  | "pairing_limit_reached"
  | "invalid_label"
  | "local_pairing_wrong_user"
  | "access_state_locked"
  | "access_state_closed"
  | "access_state_corrupt";

export class ServerAccessError extends Error {
  constructor(readonly code: ServerAccessErrorCode) {
    super(code);
    this.name = "ServerAccessError";
  }
}

export interface ServerAccessSession {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface IssuedServerSession {
  /** Raw bearer token; only ever placed in the session cookie. */
  readonly token: string;
  readonly session: ServerAccessSession;
}

export type ServerAuthenticationResult =
  | { readonly ok: true; readonly session: ServerAccessSession }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unknown" | "expired" | "revoked";
    };

export interface ServerAccessDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export interface ServerAccessStoreOptions {
  /** Private directory owned by the service account. */
  readonly dataRoot: string;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
  readonly pairingTtlMs?: number;
}

interface StoredOwner {
  readonly ownerId: string;
  readonly createdAt: number;
}

interface StoredDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly createdAt: number;
  revokedAt?: number;
}

interface StoredSession {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly deviceId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  lastSeenAt: number;
}

interface AccessState {
  schemaVersion: 1;
  owner: StoredOwner;
  devices: StoredDevice[];
  sessions: StoredSession[];
}

interface StoredLocalPairing {
  readonly schemaVersion: 1;
  readonly codeHash: string;
  readonly expiresAt: number;
}

interface PendingPairing {
  readonly codeHash: string;
  readonly expiresAt: number;
}

/**
 * Durable owner, device, and session records for the standalone server.
 * There is one owner, created on first start. Devices sign in with a
 * single-use six-digit pairing code: the first from `agentlink-server pair`
 * on the server machine, later ones from any signed-in device. Stores only
 * hashes of bearer secrets. An exclusive lock file makes one store instance
 * own a data root, so two servers cannot hold diverging revocation state.
 * Call `close` to release it.
 */
export class ServerAccessStore {
  private readonly pairings: PendingPairing[] = [];
  private readonly lastPersistedSeen = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private failedPairingAttempts = 0;
  /** Redemptions run one at a time so a code can never be used twice. */
  private redemptions: Promise<unknown> = Promise.resolve();
  private readonly revocationListeners = new Set<
    (sessionIds: readonly string[]) => void
  >();

  private constructor(
    private readonly filePath: string,
    private readonly lockPath: string,
    private readonly lockToken: string,
    private state: AccessState,
    private readonly options: Required<
      Omit<ServerAccessStoreOptions, "dataRoot">
    >,
  ) {}

  static async open(
    options: ServerAccessStoreOptions,
  ): Promise<ServerAccessStore> {
    if (!path.isAbsolute(options.dataRoot)) {
      throw new Error("Server access store requires an absolute data root");
    }
    await fs.mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(options.dataRoot, 0o700);
    const filePath = path.join(options.dataRoot, STATE_FILE);
    const lockPath = path.join(options.dataRoot, LOCK_FILE);
    const lockToken = await acquireLock(lockPath);
    const now = options.now ?? Date.now;
    let store: ServerAccessStore;
    try {
      const loaded = await readState(filePath);
      store = new ServerAccessStore(
        filePath,
        lockPath,
        lockToken,
        loaded.state,
        {
          now,
          sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
          sessionIdleTtlMs:
            options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS,
          pairingTtlMs: options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS,
        },
      );
      // A new owner, or a state file from before pairing-only sign-in.
      if (loaded.changed) await store.persist();
    } catch (error) {
      await releaseLock(lockPath, lockToken);
      throw error;
    }
    return store;
  }

  /** The single owner's ID. */
  get ownerId(): string {
    return this.state.owner.ownerId;
  }

  /** True while at least one device that has not been revoked exists. */
  get hasActiveDevices(): boolean {
    return this.state.devices.some((device) => device.revokedAt === undefined);
  }

  /** Observe durable session revocations. Returns an unsubscribe function. */
  onSessionsRevoked(
    listener: (sessionIds: readonly string[]) => void,
  ): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  /** Wait for pending writes and release the data-root lock. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes;
    await releaseLock(this.lockPath, this.lockToken);
  }

  /** Create a single-use pairing code for another browser or device. */
  createPairing(): { code: string; expiresAt: number } {
    this.prunePairings();
    if (this.pairings.length >= MAX_ACTIVE_PAIRINGS) {
      throw new ServerAccessError("pairing_limit_reached");
    }
    const code = newPairingCode();
    const expiresAt = this.options.now() + this.options.pairingTtlMs;
    this.pairings.push({ codeHash: hashSecret(code), expiresAt });
    return { code, expiresAt };
  }

  /**
   * Redeem a pairing code from `createPairing` or `agentlink-server pair`.
   * Success consumes it and signs in a new device.
   */
  redeemPairing(input: {
    readonly code: string;
    readonly deviceLabel?: string;
  }): Promise<IssuedServerSession> {
    const run = this.redemptions.then(() => this.redeemPairingNow(input));
    this.redemptions = run.catch(() => undefined);
    return run;
  }

  private async redeemPairingNow(input: {
    readonly code: string;
    readonly deviceLabel?: string;
  }): Promise<IssuedServerSession> {
    if (this.closed) throw new ServerAccessError("access_state_closed");
    // A withdrawal that could not finish keeps every code blocked.
    if (this.failedPairingAttempts >= MAX_FAILED_PAIRING_ATTEMPTS) {
      return await this.rejectPairing();
    }
    this.prunePairings();
    const label = normalizeLabel(input.deviceLabel);
    const code = normalizePairingCode(input.code);
    if (!PAIRING_CODE_PATTERN.test(code)) {
      return await this.rejectPairing();
    }
    const codeHash = hashSecret(code);
    const index = this.pairings.findIndex((pairing) =>
      hashesEqual(pairing.codeHash, codeHash),
    );
    if (index >= 0) {
      this.pairings.splice(index, 1);
      this.failedPairingAttempts = 0;
      return await this.issueSessionForNewDevice(label);
    }
    const localPath = this.localPairingPath();
    const local = await readLocalPairing(localPath);
    if (
      local &&
      local.expiresAt > this.options.now() &&
      hashesEqual(local.codeHash, codeHash)
    ) {
      // Consume before signing in, and fail closed if that is impossible.
      await fs.unlink(localPath);
      await syncDirectory(path.dirname(localPath));
      this.failedPairingAttempts = 0;
      return await this.issueSessionForNewDevice(label);
    }
    return await this.rejectPairing();
  }

  /**
   * Count a wrong code; too many withdraw every outstanding code. If the
   * local code cannot be removed, the counter stays at the limit so no code
   * is accepted until a later attempt removes it.
   */
  private async rejectPairing(): Promise<never> {
    this.failedPairingAttempts += 1;
    if (this.failedPairingAttempts >= MAX_FAILED_PAIRING_ATTEMPTS) {
      this.pairings.length = 0;
      await this.withdrawLocalPairing();
      this.failedPairingAttempts = 0;
    }
    throw new ServerAccessError("invalid_pairing_code");
  }

  private async withdrawLocalPairing(): Promise<void> {
    const localPath = this.localPairingPath();
    try {
      await fs.unlink(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await syncDirectory(path.dirname(localPath));
  }

  /**
   * Validate a session token. By default this records client activity and
   * extends the idle window; pass `recordActivity: false` for server-side
   * rechecks (stream heartbeats, pre-execution checks) that must not keep an
   * unattended session alive.
   */
  async authenticate(
    token: string | undefined,
    options: { readonly recordActivity?: boolean } = {},
  ): Promise<ServerAuthenticationResult> {
    if (!token || !SESSION_TOKEN_PATTERN.test(token)) {
      return { ok: false, reason: "malformed" };
    }
    const tokenHash = hashSecret(token);
    const session = this.state.sessions.find((candidate) =>
      hashesEqual(candidate.tokenHash, tokenHash),
    );
    if (!session) return { ok: false, reason: "unknown" };
    const device = this.state.devices.find(
      (candidate) => candidate.deviceId === session.deviceId,
    );
    if (!device || device.revokedAt !== undefined) {
      return { ok: false, reason: "revoked" };
    }
    const now = this.options.now();
    if (
      now >= session.expiresAt ||
      now - session.lastSeenAt >= this.options.sessionIdleTtlMs
    ) {
      return { ok: false, reason: "expired" };
    }
    if (options.recordActivity === false) {
      return { ok: true, session: this.toPublicSession(session, device) };
    }
    session.lastSeenAt = now;
    const persistedAt = this.lastPersistedSeen.get(session.sessionId) ?? 0;
    if (now - persistedAt >= LAST_SEEN_PERSIST_INTERVAL_MS) {
      this.lastPersistedSeen.set(session.sessionId, now);
      await this.persist();
    }
    return { ok: true, session: this.toPublicSession(session, device) };
  }

  listDevices(): readonly ServerAccessDevice[] {
    return this.state.devices.map((device) => ({ ...device }));
  }

  /**
   * Revoke a device and every session it holds. Revoking the last active
   * device is allowed; the owner pairs again with `agentlink-server pair`.
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.state.devices.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (!device || device.revokedAt !== undefined) return false;
    device.revokedAt = this.options.now();
    const revoked = this.state.sessions
      .filter((session) => session.deviceId === deviceId)
      .map((session) => session.sessionId);
    this.state.sessions = this.state.sessions.filter(
      (session) => session.deviceId !== deviceId,
    );
    await this.persist();
    this.notifyRevoked(revoked);
    return true;
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter(
      (session) => session.sessionId !== sessionId,
    );
    if (this.state.sessions.length === before) return false;
    await this.persist();
    this.notifyRevoked([sessionId]);
    return true;
  }

  private localPairingPath(): string {
    return path.join(path.dirname(this.filePath), LOCAL_PAIRING_FILE);
  }

  private notifyRevoked(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    for (const listener of this.revocationListeners) {
      try {
        listener(sessionIds);
      } catch {
        // A listener failure must not undo or hide a committed revocation.
      }
    }
  }

  private async issueSessionForNewDevice(
    label: string,
  ): Promise<IssuedServerSession> {
    const now = this.options.now();
    const device: StoredDevice = {
      deviceId: randomUUID(),
      label,
      createdAt: now,
    };
    const token = randomBytes(32).toString("base64url");
    const session: StoredSession = {
      sessionId: randomUUID(),
      tokenHash: hashSecret(token),
      deviceId: device.deviceId,
      createdAt: now,
      expiresAt: now + this.options.sessionTtlMs,
      lastSeenAt: now,
    };
    this.state.devices.push(device);
    this.state.sessions.push(session);
    this.lastPersistedSeen.set(session.sessionId, now);
    await this.persist();
    return { token, session: this.toPublicSession(session, device) };
  }

  private toPublicSession(
    session: StoredSession,
    device: StoredDevice,
  ): ServerAccessSession {
    return {
      ownerId: this.state.owner.ownerId,
      sessionId: session.sessionId,
      deviceId: device.deviceId,
      deviceLabel: device.label,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  private prunePairings(): void {
    const now = this.options.now();
    for (let index = this.pairings.length - 1; index >= 0; index -= 1) {
      if (this.pairings[index]!.expiresAt <= now) {
        this.pairings.splice(index, 1);
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.closed) throw new ServerAccessError("access_state_closed");
    const now = this.options.now();
    // Drop sessions that can never authenticate again; keep devices for history.
    this.state.sessions = this.state.sessions.filter(
      (session) =>
        now < session.expiresAt &&
        now - session.lastSeenAt < this.options.sessionIdleTtlMs,
    );
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const write = this.writes.then(() => writeState(this.filePath, snapshot));
    this.writes = write.catch(() => undefined);
    await write;
  }
}

/**
 * Issue a pairing code on the server machine for the first (or a lost)
 * device. Run by `agentlink-server pair` as the account that owns the data
 * root; it works whether or not the server is running. Only a hash is
 * written, to a private file next to the access state. A new code replaces
 * any earlier one.
 */
export async function issueLocalPairingCode(options: {
  readonly dataRoot: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): Promise<{ code: string; expiresAt: number }> {
  if (!path.isAbsolute(options.dataRoot)) {
    throw new Error("Local pairing requires an absolute data root");
  }
  await fs.mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  const root: Stats = await fs.stat(options.dataRoot);
  const uid = process.getuid?.();
  if (uid !== undefined && root.uid !== uid) {
    throw new ServerAccessError("local_pairing_wrong_user");
  }
  const code = newPairingCode();
  const expiresAt =
    (options.now ?? Date.now)() +
    (options.ttlMs ?? DEFAULT_LOCAL_PAIRING_TTL_MS);
  const request: StoredLocalPairing = {
    schemaVersion: 1,
    codeHash: hashSecret(code),
    expiresAt,
  };
  await writeState(
    path.join(options.dataRoot, LOCAL_PAIRING_FILE),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  return { code, expiresAt };
}

/**
 * Read the local pairing request, accepting only a small regular file that
 * is private to this account. Anything else is treated as no code.
 */
async function readLocalPairing(
  filePath: string,
): Promise<StoredLocalPairing | undefined> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    const uid = process.getuid?.();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid) ||
      stat.size > MAX_LOCAL_PAIRING_FILE_BYTES
    ) {
      return undefined;
    }
    const parsed = JSON.parse(
      await handle.readFile("utf8"),
    ) as Partial<StoredLocalPairing>;
    if (
      parsed?.schemaVersion !== 1 ||
      typeof parsed.codeHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(parsed.codeHash) ||
      typeof parsed.expiresAt !== "number"
    ) {
      return undefined;
    }
    return parsed as StoredLocalPairing;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function newPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.length > 0 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function normalizePairingCode(code: string): string {
  return typeof code === "string" ? code.replace(/[\s-]/gu, "") : "";
}

function normalizeLabel(label: string | undefined): string {
  if (label === undefined) return "Browser";
  const trimmed = typeof label === "string" ? label.trim() : "";
  const hasControl = [...trimmed].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });
  if (!trimmed || trimmed.length > MAX_LABEL_LENGTH || hasControl) {
    throw new ServerAccessError("invalid_label");
  }
  return trimmed;
}

/**
 * Read the access state, creating the owner on first start. Earlier
 * versions also stored an owner passphrase and a setup credential; both are
 * dropped (sign-in is by pairing code only) while devices stay signed in.
 */
async function readState(
  filePath: string,
): Promise<{ readonly state: AccessState; readonly changed: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        state: {
          schemaVersion: 1,
          owner: { ownerId: randomUUID(), createdAt: Date.now() },
          devices: [],
          sessions: [],
        },
        changed: true,
      };
    }
    throw error;
  }
  // Fail closed: a damaged file must never look like a fresh install, which
  // would sign every device out and change the owner's identity.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ServerAccessError("access_state_corrupt");
  }
  const owner = parsed?.owner as Partial<StoredOwner> | undefined;
  if (
    parsed?.schemaVersion !== 1 ||
    !Array.isArray(parsed.devices) ||
    !Array.isArray(parsed.sessions) ||
    (owner !== undefined &&
      (typeof owner !== "object" ||
        owner === null ||
        typeof owner.ownerId !== "string"))
  ) {
    throw new ServerAccessError("access_state_corrupt");
  }
  const legacy =
    owner === undefined ||
    "passphrase" in owner ||
    "setup" in parsed ||
    (parsed.sessions as Array<Record<string, unknown>>).some(
      (session) => "authenticatedAt" in session || "revokedAt" in session,
    );
  const state: AccessState = {
    schemaVersion: 1,
    owner: {
      ownerId: owner?.ownerId ?? randomUUID(),
      createdAt:
        typeof owner?.createdAt === "number" ? owner.createdAt : Date.now(),
    },
    devices: parsed.devices as StoredDevice[],
    sessions: (parsed.sessions as Array<StoredSession & { revokedAt?: number }>)
      .filter((session) => session.revokedAt === undefined)
      .map((session) => ({
        sessionId: session.sessionId,
        tokenHash: session.tokenHash,
        deviceId: session.deviceId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
      })),
  };
  return { state, changed: legacy };
}

/**
 * The rename is durable before this resolves, so a crash after a revocation
 * response cannot restore the earlier state.
 */
async function writeState(filePath: string, content: string): Promise<void> {
  await writeFileAtomic(filePath, content, 0o600);
}

async function acquireLock(lockPath: string): Promise<string> {
  try {
    return await acquireFileLock(lockPath);
  } catch (error) {
    if (error instanceof FileLockHeldError) {
      throw new ServerAccessError("access_state_locked");
    }
    throw error;
  }
}

const releaseLock = releaseFileLock;
