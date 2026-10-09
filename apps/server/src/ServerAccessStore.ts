import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const STATE_FILE = "access-state.json";
const LOCK_FILE = "access-state.lock";
const RECOVERY_FILE = "recovery-request.json";
const DEFAULT_RECOVERY_TTL_MS = 15 * 60 * 1000;
const MAX_RECOVERY_FILE_BYTES = 4_096;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SETUP_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 1000;
const MAX_ACTIVE_PAIRINGS = 5;
const MIN_PASSPHRASE_LENGTH = 12;
const MAX_PASSPHRASE_LENGTH = 1_024;
const MAX_LABEL_LENGTH = 80;
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH = 10;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CSRF_CONTEXT = "agentlink-server-csrf-v1";

/** scrypt work factor. Tests may lower it; production uses the default. */
export interface PassphraseCost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

const DEFAULT_PASSPHRASE_COST: PassphraseCost = { N: 2 ** 15, r: 8, p: 1 };

export type ServerAccessErrorCode =
  | "owner_exists"
  | "owner_missing"
  | "invalid_setup_credential"
  | "weak_passphrase"
  | "invalid_pairing_code"
  | "pairing_limit_reached"
  | "invalid_label"
  | "invalid_recovery_credential"
  | "recovery_wrong_user"
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
  /** Last time the owner proved the passphrase or credential for this session. */
  readonly authenticatedAt: number;
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
  readonly passphraseCost?: PassphraseCost;
  readonly sessionTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
  readonly setupTtlMs?: number;
  readonly pairingTtlMs?: number;
}

interface StoredPassphrase {
  readonly salt: string;
  readonly hash: string;
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

interface StoredOwner {
  readonly ownerId: string;
  readonly createdAt: number;
  readonly passphrase: StoredPassphrase;
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
  authenticatedAt: number;
  revokedAt?: number;
}

interface StoredSetup {
  readonly tokenHash: string;
  readonly expiresAt: number;
}

interface AccessState {
  schemaVersion: 1;
  owner?: StoredOwner;
  setup?: StoredSetup;
  devices: StoredDevice[];
  sessions: StoredSession[];
}

interface StoredRecoveryRequest {
  readonly schemaVersion: 1;
  readonly tokenHash: string;
  readonly expiresAt: number;
}

interface PendingPairing {
  readonly codeHash: string;
  readonly expiresAt: number;
}

/**
 * Durable owner, device, and session records for the standalone server.
 * Stores only hashes of bearer secrets. An exclusive lock file makes one
 * store instance own a data root, so two servers cannot hold diverging
 * revocation state. Call `close` to release it.
 */
export class ServerAccessStore {
  private readonly pairings: PendingPairing[] = [];
  private readonly lastPersistedSeen = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private recoveries: Promise<unknown> = Promise.resolve();
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
    let state: AccessState;
    try {
      state = await readState(filePath);
    } catch (error) {
      await releaseLock(lockPath, lockToken);
      throw error;
    }
    return new ServerAccessStore(filePath, lockPath, lockToken, state, {
      now: options.now ?? Date.now,
      passphraseCost: options.passphraseCost ?? DEFAULT_PASSPHRASE_COST,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      sessionIdleTtlMs: options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS,
      setupTtlMs: options.setupTtlMs ?? DEFAULT_SETUP_TTL_MS,
      pairingTtlMs: options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS,
    });
  }

  get ownerConfigured(): boolean {
    return this.state.owner !== undefined;
  }

  /** The single owner's ID, once bootstrapped. */
  get ownerId(): string | undefined {
    return this.state.owner?.ownerId;
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

  /**
   * Issue the one-time local setup credential. Replaces any earlier one.
   * Only valid before an owner exists.
   */
  async issueSetupCredential(): Promise<{ token: string; expiresAt: number }> {
    if (this.state.owner) throw new ServerAccessError("owner_exists");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.options.now() + this.options.setupTtlMs;
    this.state.setup = { tokenHash: hashSecret(token), expiresAt };
    await this.persist();
    return { token, expiresAt };
  }

  async bootstrapOwner(input: {
    readonly setupToken: string;
    readonly passphrase: string;
    readonly deviceLabel?: string;
  }): Promise<IssuedServerSession> {
    if (this.state.owner) throw new ServerAccessError("owner_exists");
    const setup = this.state.setup;
    if (
      !setup ||
      setup.expiresAt <= this.options.now() ||
      !hashesEqual(hashSecret(input.setupToken), setup.tokenHash)
    ) {
      throw new ServerAccessError("invalid_setup_credential");
    }
    validatePassphrase(input.passphrase);
    const label = normalizeLabel(input.deviceLabel);
    const passphrase = await hashPassphrase(
      input.passphrase,
      this.options.passphraseCost,
    );
    // Re-check after the async hash so two concurrent requests cannot both win.
    if (this.state.owner || this.state.setup !== setup) {
      throw new ServerAccessError("invalid_setup_credential");
    }
    this.state.owner = {
      ownerId: randomUUID(),
      createdAt: this.options.now(),
      passphrase,
    };
    delete this.state.setup;
    return await this.issueSessionForNewDevice(label);
  }

  /** Create a single-use pairing code for another browser or device. */
  createPairing(): { code: string; expiresAt: number } {
    if (!this.state.owner) throw new ServerAccessError("owner_missing");
    this.prunePairings();
    if (this.pairings.length >= MAX_ACTIVE_PAIRINGS) {
      throw new ServerAccessError("pairing_limit_reached");
    }
    let raw = "";
    for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
      raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
    }
    const expiresAt = this.options.now() + this.options.pairingTtlMs;
    this.pairings.push({ codeHash: hashSecret(raw), expiresAt });
    return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt };
  }

  async redeemPairing(input: {
    readonly code: string;
    readonly deviceLabel?: string;
  }): Promise<IssuedServerSession> {
    if (!this.state.owner) throw new ServerAccessError("owner_missing");
    this.prunePairings();
    const label = normalizeLabel(input.deviceLabel);
    const codeHash = hashSecret(normalizePairingCode(input.code));
    const index = this.pairings.findIndex((pairing) =>
      hashesEqual(pairing.codeHash, codeHash),
    );
    if (index < 0) throw new ServerAccessError("invalid_pairing_code");
    this.pairings.splice(index, 1);
    return await this.issueSessionForNewDevice(label);
  }

  /**
   * Redeem a local recovery credential written by
   * `issueLocalRecoveryCredential`. The owner passphrase is also required,
   * so a leaked recovery code alone cannot sign anyone in. Success consumes
   * the credential and creates a new device and session; a wrong passphrase
   * leaves it valid until it expires. Redemptions run one at a time.
   */
  redeemRecovery(input: {
    readonly recoveryToken: string;
    readonly passphrase: string;
    readonly deviceLabel?: string;
  }): Promise<IssuedServerSession> {
    const run = this.recoveries.then(() => this.redeemRecoveryNow(input));
    this.recoveries = run.catch(() => undefined);
    return run;
  }

  private async redeemRecoveryNow(input: {
    readonly recoveryToken: string;
    readonly passphrase: string;
    readonly deviceLabel?: string;
  }): Promise<IssuedServerSession> {
    const owner = this.state.owner;
    if (!owner) throw new ServerAccessError("owner_missing");
    const label = normalizeLabel(input.deviceLabel);
    const recoveryPath = path.join(path.dirname(this.filePath), RECOVERY_FILE);
    const request = await readRecoveryRequest(recoveryPath);
    if (!request) throw new ServerAccessError("invalid_recovery_credential");
    if (request.expiresAt <= this.options.now()) {
      await fs.unlink(recoveryPath).catch(() => undefined);
      throw new ServerAccessError("invalid_recovery_credential");
    }
    const tokenHash = hashSecret(
      typeof input.recoveryToken === "string" ? input.recoveryToken : "",
    );
    if (!hashesEqual(tokenHash, request.tokenHash)) {
      throw new ServerAccessError("invalid_recovery_credential");
    }
    if (
      typeof input.passphrase !== "string" ||
      input.passphrase.length > MAX_PASSPHRASE_LENGTH ||
      !(await verifyPassphrase(input.passphrase, owner.passphrase))
    ) {
      throw new ServerAccessError("invalid_recovery_credential");
    }
    // The local command may have replaced the credential during the slow
    // passphrase check. Consume only the one that was verified, and fail
    // closed if it cannot be removed, so it can never be used twice.
    const current = await readRecoveryRequest(recoveryPath);
    if (!current || current.tokenHash !== request.tokenHash) {
      throw new ServerAccessError("invalid_recovery_credential");
    }
    await fs.unlink(recoveryPath);
    await syncDirectory(path.dirname(recoveryPath));
    return await this.issueSessionForNewDevice(label);
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
    if (session.revokedAt !== undefined || !device || device.revokedAt) {
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

  /** Verify the owner passphrase and refresh the session's authentication time. */
  async reauthenticate(
    sessionId: string,
    passphrase: string,
  ): Promise<boolean> {
    const owner = this.state.owner;
    const session = this.state.sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!owner || !session || session.revokedAt !== undefined) return false;
    if (
      typeof passphrase !== "string" ||
      passphrase.length > MAX_PASSPHRASE_LENGTH
    ) {
      return false;
    }
    if (!(await verifyPassphrase(passphrase, owner.passphrase))) return false;
    if (session.revokedAt !== undefined) return false;
    session.authenticatedAt = this.options.now();
    await this.persist();
    return true;
  }

  listDevices(): readonly ServerAccessDevice[] {
    return this.state.devices.map((device) => ({ ...device }));
  }

  /**
   * Revoke a device and every session it holds. Revoking the last active
   * device is allowed; the owner then signs in again with a local recovery
   * credential (`agentlink-server recover`).
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const device = this.state.devices.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (!device || device.revokedAt !== undefined) return false;
    const now = this.options.now();
    device.revokedAt = now;
    const revoked: string[] = [];
    for (const session of this.state.sessions) {
      if (session.deviceId === deviceId && session.revokedAt === undefined) {
        session.revokedAt = now;
        revoked.push(session.sessionId);
      }
    }
    await this.persist();
    this.notifyRevoked(revoked);
    return true;
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const session = this.state.sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!session || session.revokedAt !== undefined) return false;
    session.revokedAt = this.options.now();
    await this.persist();
    this.notifyRevoked([sessionId]);
    return true;
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
      authenticatedAt: now,
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
      ownerId: this.state.owner!.ownerId,
      sessionId: session.sessionId,
      deviceId: device.deviceId,
      deviceLabel: device.label,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      authenticatedAt: session.authenticatedAt,
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
        session.revokedAt === undefined &&
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
 * Issue a local recovery credential for an existing owner. Run by the
 * `agentlink-server recover` command on the server machine, as the account
 * that owns the data root; it works whether or not the server is running.
 * Only a hash is written, to a private file next to the access state. A new
 * credential replaces any earlier one.
 */
export async function issueLocalRecoveryCredential(options: {
  readonly dataRoot: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): Promise<{ token: string; expiresAt: number }> {
  if (!path.isAbsolute(options.dataRoot)) {
    throw new Error("Local recovery requires an absolute data root");
  }
  let root: Stats;
  try {
    root = await fs.stat(options.dataRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ServerAccessError("owner_missing");
    }
    throw error;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && root.uid !== uid) {
    throw new ServerAccessError("recovery_wrong_user");
  }
  const state = await readState(path.join(options.dataRoot, STATE_FILE));
  if (!state.owner) throw new ServerAccessError("owner_missing");
  const token = randomBytes(32).toString("base64url");
  const expiresAt =
    (options.now ?? Date.now)() + (options.ttlMs ?? DEFAULT_RECOVERY_TTL_MS);
  const request: StoredRecoveryRequest = {
    schemaVersion: 1,
    tokenHash: hashSecret(token),
    expiresAt,
  };
  await writeState(
    path.join(options.dataRoot, RECOVERY_FILE),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  return { token, expiresAt };
}

/**
 * Read the recovery request, accepting only a small regular file that is
 * private to this account. Anything else is treated as no credential.
 */
async function readRecoveryRequest(
  filePath: string,
): Promise<StoredRecoveryRequest | undefined> {
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
      stat.size > MAX_RECOVERY_FILE_BYTES
    ) {
      return undefined;
    }
    const parsed = JSON.parse(
      await handle.readFile("utf8"),
    ) as Partial<StoredRecoveryRequest>;
    if (
      parsed?.schemaVersion !== 1 ||
      typeof parsed.tokenHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(parsed.tokenHash) ||
      typeof parsed.expiresAt !== "number"
    ) {
      return undefined;
    }
    return parsed as StoredRecoveryRequest;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** CSRF token bound to one session token; nothing extra is stored. */
export function csrfTokenForSession(sessionToken: string): string {
  return createHmac("sha256", sessionToken)
    .update(CSRF_CONTEXT)
    .digest("base64url");
}

export function verifyCsrfToken(
  sessionToken: string,
  supplied: string | undefined,
): boolean {
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(csrfTokenForSession(sessionToken));
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
  return typeof code === "string"
    ? code.toUpperCase().replace(/[\s-]/gu, "")
    : "";
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

function validatePassphrase(passphrase: string): void {
  if (
    typeof passphrase !== "string" ||
    [...passphrase].length < MIN_PASSPHRASE_LENGTH ||
    passphrase.length > MAX_PASSPHRASE_LENGTH
  ) {
    throw new ServerAccessError("weak_passphrase");
  }
}

function scryptAsync(
  passphrase: string,
  salt: Buffer,
  cost: PassphraseCost,
): Promise<Buffer> {
  const options: ScryptOptions = {
    N: cost.N,
    r: cost.r,
    p: cost.p,
    maxmem: 256 * cost.N * cost.r + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFC"), salt, 32, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

async function hashPassphrase(
  passphrase: string,
  cost: PassphraseCost,
): Promise<StoredPassphrase> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(passphrase, salt, cost);
  return {
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    ...cost,
  };
}

async function verifyPassphrase(
  passphrase: string,
  stored: StoredPassphrase,
): Promise<boolean> {
  const expected = Buffer.from(stored.hash, "base64");
  const actual = await scryptAsync(
    passphrase,
    Buffer.from(stored.salt, "base64"),
    stored,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readState(filePath: string): Promise<AccessState> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, devices: [], sessions: [] };
    }
    throw error;
  }
  // Fail closed: a damaged file must never look like "no owner yet", which
  // would reopen bootstrap to whoever reaches the listener first.
  try {
    const parsed = JSON.parse(raw) as Partial<AccessState>;
    if (
      parsed?.schemaVersion !== 1 ||
      !Array.isArray(parsed.devices) ||
      !Array.isArray(parsed.sessions) ||
      (parsed.owner !== undefined &&
        (typeof parsed.owner.ownerId !== "string" ||
          typeof parsed.owner.passphrase?.hash !== "string"))
    ) {
      throw new Error("invalid");
    }
    return parsed as AccessState;
  } catch {
    throw new ServerAccessError("access_state_corrupt");
  }
}

async function writeState(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  // Make the rename durable before reporting success, so a crash after a
  // revocation response cannot restore the earlier state.
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Create the lock file exclusively. A lock left by a process that no longer
 * exists is replaced; a live holder (including this process) is refused.
 */
async function acquireLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  const content = `${JSON.stringify({ pid: process.pid, token })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readLockHolder(lockPath);
    if (holder !== undefined && processExists(holder)) {
      throw new ServerAccessError("access_state_locked");
    }
    await fs.unlink(lockPath).catch(() => undefined);
  }
  throw new ServerAccessError("access_state_locked");
}

async function readLockHolder(lockPath: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      token?: unknown;
    };
    if (parsed.token === token) await fs.unlink(lockPath);
  } catch {
    // Already released or replaced; nothing to do.
  }
}
