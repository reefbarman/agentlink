import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspaceCommandMode = "foreground" | "background";
export type WorkspaceCommandState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface PreparedWorkspaceCommandLaunch {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly environmentDigest: string;
  readonly mode: WorkspaceCommandMode;
  readonly timeoutMs: number;
  readonly policyFingerprint: string;
  readonly operationDigest: string;
}

export interface WorkspaceCommandLaunch extends PreparedWorkspaceCommandLaunch {
  readonly environment: Readonly<Record<string, string>>;
  readonly concurrentEditingAcknowledged: boolean;
}

export interface WorkspaceCommandRecord {
  readonly commandId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly mode: WorkspaceCommandMode;
  readonly state: WorkspaceCommandState;
  readonly concurrentEditingAcknowledged: boolean;
  readonly policyFingerprint: string;
  readonly operationDigest: string;
  readonly pid?: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly outputStartOffset: number;
  readonly outputEndOffset: number;
  readonly outputDroppedBytes: number;
}

export interface WorkspaceCommandOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly offset: number;
  readonly text: string;
}

export interface WorkspaceCommandObservation {
  readonly record: WorkspaceCommandRecord;
  readonly requestedOffset: number;
  readonly nextOffset: number;
  readonly truncatedBeforeOffset: boolean;
  readonly output: readonly WorkspaceCommandOutputChunk[];
}

export interface WorkspaceCommandIdentity {
  readonly ownerId: string;
  readonly sessionId?: string;
}

export interface CreateWorkspaceCommandSupervisorOptions {
  readonly stateDirectory: string;
  readonly ownerId: string;
  readonly maxRetainedOutputBytes?: number;
  readonly terminationGraceMs?: number;
  readonly now?: () => number;
  readonly createCommandId?: () => string;
}

interface RetainedChunk {
  readonly stream: "stdout" | "stderr";
  offset: number;
  bytes: Buffer;
}

interface LiveCommand {
  readonly child: ChildProcess;
  readonly completion: Promise<WorkspaceCommandRecord>;
  readonly finish: (
    state: WorkspaceCommandState,
    exitCode?: number,
    signal?: NodeJS.Signals,
  ) => void;
  readonly redactionValues: readonly Buffer[];
  readonly pendingOutput: Record<"stdout" | "stderr", Buffer>;
  terminalState?: "cancelled" | "timed_out";
  timeout?: NodeJS.Timeout;
}

interface DurableCommandRecord extends WorkspaceCommandRecord {
  readonly output: readonly {
    readonly stream: "stdout" | "stderr";
    readonly offset: number;
    readonly base64: string;
  }[];
}

const STATE_FILE = "commands.json";
const STATE_VERSION = 1;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export class WorkspaceCommandSupervisor {
  private readonly records = new Map<string, WorkspaceCommandRecord>();
  private readonly output = new Map<string, RetainedChunk[]>();
  private readonly live = new Map<string, LiveCommand>();
  private readonly statePath: string;
  private readonly maxRetainedOutputBytes: number;
  private readonly terminationGraceMs: number;
  private readonly now: () => number;
  private readonly createCommandId: () => string;
  private persistTail: Promise<void> = Promise.resolve();
  private persistTimer: NodeJS.Timeout | undefined;
  private persistError: Error | undefined;
  private closed = false;

  private constructor(
    private readonly options: CreateWorkspaceCommandSupervisorOptions,
  ) {
    this.statePath = path.join(options.stateDirectory, STATE_FILE);
    this.maxRetainedOutputBytes =
      options.maxRetainedOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.createCommandId = options.createCommandId ?? randomUUID;
  }

  static async create(
    options: CreateWorkspaceCommandSupervisorOptions,
  ): Promise<WorkspaceCommandSupervisor> {
    if (!path.isAbsolute(options.stateDirectory)) {
      throw new Error("command_state_directory_must_be_absolute");
    }
    if (!options.ownerId.trim()) throw new Error("command_owner_id_required");
    const supervisor = new WorkspaceCommandSupervisor(options);
    await supervisor.open();
    return supervisor;
  }

  nextCommandId(): string {
    return this.createCommandId();
  }

  async launchForeground(
    launch: WorkspaceCommandLaunch,
    signal?: AbortSignal,
  ): Promise<WorkspaceCommandRecord> {
    const live = await this.launch(launch, signal);
    return await live.completion;
  }

  async launchBackground(
    launch: WorkspaceCommandLaunch,
    signal?: AbortSignal,
  ): Promise<WorkspaceCommandRecord> {
    await this.launch(launch, signal);
    return this.requireRecord(launch.commandId);
  }

  list(identity: WorkspaceCommandIdentity): readonly WorkspaceCommandRecord[] {
    this.assertOwner(identity.ownerId);
    return [...this.records.values()]
      .filter(
        (record) =>
          record.ownerId === identity.ownerId &&
          (!identity.sessionId || record.sessionId === identity.sessionId),
      )
      .sort(
        (left, right) =>
          right.startedAt - left.startedAt ||
          left.commandId.localeCompare(right.commandId),
      )
      .map((record) => structuredClone(record));
  }

  observe(
    commandId: string,
    identity: WorkspaceCommandIdentity,
    options: { readonly offset?: number; readonly limitBytes?: number } = {},
  ): WorkspaceCommandObservation {
    const record = this.authorizedRecord(commandId, identity);
    const requestedOffset = boundedInteger(
      options.offset,
      record.outputStartOffset,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limitBytes = boundedInteger(options.limitBytes, 64_000, 1, 1_000_000);
    const effectiveOffset = Math.max(requestedOffset, record.outputStartOffset);
    let remaining = limitBytes;
    let nextOffset = effectiveOffset;
    const output: WorkspaceCommandOutputChunk[] = [];
    for (const chunk of this.output.get(commandId) ?? []) {
      const chunkEnd = chunk.offset + chunk.bytes.length;
      if (chunkEnd <= effectiveOffset || remaining <= 0) continue;
      const requestedStart = Math.max(0, effectiveOffset - chunk.offset);
      const start = utf8SafeStart(chunk.bytes, requestedStart);
      const requestedEnd = Math.min(chunk.bytes.length, start + remaining);
      const end = utf8SafeEnd(chunk.bytes, start, requestedEnd);
      const selected = chunk.bytes.subarray(start, end);
      if (selected.length === 0) continue;
      output.push({
        stream: chunk.stream,
        offset: chunk.offset + start,
        text: selected.toString("utf8"),
      });
      remaining -= selected.length;
      nextOffset = chunk.offset + start + selected.length;
    }
    return {
      record: structuredClone(record),
      requestedOffset,
      nextOffset,
      truncatedBeforeOffset: requestedOffset < record.outputStartOffset,
      output,
    };
  }

  async stop(
    commandId: string,
    identity: WorkspaceCommandIdentity,
  ): Promise<WorkspaceCommandRecord> {
    const record = this.authorizedRecord(commandId, identity);
    const live = this.live.get(commandId);
    if (
      !live ||
      (record.state !== "running" && record.state !== "interrupted")
    ) {
      return structuredClone(record);
    }
    const stopped = await this.terminate(commandId, "cancelled");
    return stopped
      ? await live.completion
      : structuredClone(this.requireRecord(commandId));
  }

  async close(): Promise<void> {
    if (this.closed && this.live.size === 0) return;
    this.closed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await Promise.all(
      [...this.live.keys()].map((commandId) =>
        this.terminate(commandId, "cancelled"),
      ),
    );
    await this.persist();
    if (this.persistError) throw this.persistError;
    if (this.live.size > 0)
      throw new Error("command_process_cleanup_incomplete");
  }

  private async open(): Promise<void> {
    await fs.mkdir(this.options.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const serialized = await fs
      .readFile(this.statePath, "utf8")
      .catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
    if (!serialized) return;
    const parsed = JSON.parse(serialized) as {
      version?: unknown;
      records?: unknown;
    };
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.records)) {
      throw new Error("command_state_invalid");
    }
    let changed = false;
    for (const candidate of parsed.records as DurableCommandRecord[]) {
      if (!validDurableRecord(candidate))
        throw new Error("command_state_invalid");
      const record = withoutOutput({
        ...candidate,
        ...(candidate.state === "running"
          ? { state: "interrupted", finishedAt: this.now() }
          : {}),
      });
      if (candidate.state === "running") changed = true;
      this.records.set(record.commandId, record);
      this.output.set(
        record.commandId,
        candidate.output.map((chunk) => ({
          stream: chunk.stream,
          offset: chunk.offset,
          bytes: Buffer.from(chunk.base64, "base64"),
        })),
      );
    }
    if (changed) await this.persist();
  }

  private async launch(
    launch: WorkspaceCommandLaunch,
    signal?: AbortSignal,
  ): Promise<LiveCommand> {
    if (this.closed) throw new Error("command_supervisor_closed");
    validateLaunch(launch, this.options.ownerId);
    if (this.records.has(launch.commandId)) {
      throw new Error("command_id_already_exists");
    }
    if (signal?.aborted) throw new Error("command_cancelled_before_launch");

    const startedAt = this.now();
    const child = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.environment },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let resolveCompletion!: (record: WorkspaceCommandRecord) => void;
    const completion = new Promise<WorkspaceCommandRecord>((resolve) => {
      resolveCompletion = resolve;
    });
    const finish = (
      state: WorkspaceCommandState,
      exitCode?: number,
      exitSignal?: NodeJS.Signals,
    ) => {
      if (settled) return;
      settled = true;
      const live = this.live.get(launch.commandId);
      if (live) this.flushPendingOutput(launch.commandId, live);
      if (live?.timeout) clearTimeout(live.timeout);
      signal?.removeEventListener("abort", onAbort);
      const prior = this.requireRecord(launch.commandId);
      const record: WorkspaceCommandRecord = {
        ...prior,
        state,
        finishedAt: this.now(),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(exitSignal !== undefined ? { signal: exitSignal } : {}),
      };
      this.records.set(launch.commandId, record);
      this.live.delete(launch.commandId);
      void this.persist()
        .catch(() => undefined)
        .then(() => resolveCompletion(structuredClone(record)));
    };
    const live: LiveCommand = {
      child,
      completion,
      finish,
      redactionValues: sensitiveEnvironmentValues(launch.environment),
      pendingOutput: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    };
    const onAbort = () => {
      void this.terminate(launch.commandId, "cancelled").catch(() => undefined);
    };
    this.output.set(launch.commandId, []);
    const running: WorkspaceCommandRecord = {
      ...publicRecord(launch, startedAt),
      state: "running",
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      outputStartOffset: 0,
      outputEndOffset: 0,
      outputDroppedBytes: 0,
    };
    this.records.set(launch.commandId, running);
    this.live.set(launch.commandId, live);

    child.stdout?.on("data", (bytes: Buffer | string) => {
      this.appendProcessOutput(launch.commandId, "stdout", Buffer.from(bytes));
    });
    child.stderr?.on("data", (bytes: Buffer | string) => {
      this.appendProcessOutput(launch.commandId, "stderr", Buffer.from(bytes));
    });
    // Wait for `close`, not merely `exit`, so the retained record includes all
    // stdout/stderr delivered before the process handles close.
    child.once("close", (code, exitSignal) => {
      const current = this.records.get(launch.commandId);
      if (
        !current ||
        (current.state !== "running" && current.state !== "interrupted")
      ) {
        return;
      }
      finish(
        live.terminalState ?? (code === 0 ? "completed" : "failed"),
        code ?? undefined,
        exitSignal ?? undefined,
      );
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(async (error) => {
      const failed: WorkspaceCommandRecord = {
        ...publicRecord(launch, startedAt),
        state: "failed",
        finishedAt: this.now(),
        outputStartOffset: 0,
        outputEndOffset: 0,
        outputDroppedBytes: 0,
      };
      this.records.set(launch.commandId, failed);
      this.live.delete(launch.commandId);
      await this.persist();
      throw new Error(`command_launch_failed:${errorCode(error) ?? "unknown"}`);
    });

    if (!settled) {
      signal?.addEventListener("abort", onAbort, { once: true });
      live.timeout = setTimeout(() => {
        void this.terminate(launch.commandId, "timed_out").catch(
          () => undefined,
        );
      }, launch.timeoutMs);
      live.timeout.unref?.();
      if (signal?.aborted) onAbort();
    }
    try {
      await this.persist();
    } catch (error) {
      await this.terminate(launch.commandId, "cancelled").catch(
        () => undefined,
      );
      throw error;
    }
    return live;
  }

  private appendProcessOutput(
    commandId: string,
    stream: "stdout" | "stderr",
    bytes: Buffer,
  ): void {
    const live = this.live.get(commandId);
    if (!live || bytes.length === 0) return;
    const combined = Buffer.concat([live.pendingOutput[stream], bytes]);
    const redacted = redactBuffer(combined, live.redactionValues);
    // Detect an incomplete secret prefix after replacing every complete match.
    // This avoids retaining a self-overlapping suffix from a value that was
    // already fully redacted (for example, a repeated-character token).
    const keepBytes = secretPrefixSuffixLength(redacted, live.redactionValues);
    const emitBytes = combined.length - keepBytes;
    if (emitBytes > 0) {
      this.appendOutput(commandId, stream, redacted.subarray(0, emitBytes));
    }
    live.pendingOutput[stream] = combined.subarray(emitBytes);
  }

  private flushPendingOutput(commandId: string, live: LiveCommand): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const pending = live.pendingOutput[stream];
      if (pending.length > 0) {
        this.appendOutput(
          commandId,
          stream,
          redactBuffer(pending, live.redactionValues),
        );
        live.pendingOutput[stream] = Buffer.alloc(0);
      }
    }
  }

  private appendOutput(
    commandId: string,
    stream: "stdout" | "stderr",
    bytes: Buffer,
  ): void {
    if (bytes.length === 0) return;
    const record = this.records.get(commandId);
    if (!record) return;
    const chunks = this.output.get(commandId) ?? [];
    chunks.push({ stream, offset: record.outputEndOffset, bytes });
    let retained = chunks.reduce(
      (total, chunk) => total + chunk.bytes.length,
      0,
    );
    let dropped = record.outputDroppedBytes;
    while (retained > this.maxRetainedOutputBytes && chunks.length > 0) {
      const excess = retained - this.maxRetainedOutputBytes;
      const first = chunks[0]!;
      if (first.bytes.length <= excess) {
        retained -= first.bytes.length;
        dropped += first.bytes.length;
        chunks.shift();
      } else {
        let trim = excess;
        while (
          trim < first.bytes.length &&
          (first.bytes[trim]! & 0xc0) === 0x80
        ) {
          trim += 1;
        }
        first.bytes = first.bytes.subarray(trim);
        first.offset += trim;
        retained -= trim;
        dropped += trim;
      }
    }
    const end = record.outputEndOffset + bytes.length;
    this.output.set(commandId, chunks);
    this.records.set(commandId, {
      ...record,
      outputStartOffset: chunks[0]?.offset ?? end,
      outputEndOffset: end,
      outputDroppedBytes: dropped,
    });
    this.schedulePersist();
  }

  private async terminate(
    commandId: string,
    terminalState: "cancelled" | "timed_out",
  ): Promise<boolean> {
    const live = this.live.get(commandId);
    const record = this.records.get(commandId);
    if (
      !live ||
      !record ||
      (record.state !== "running" && record.state !== "interrupted")
    ) {
      return true;
    }
    live.terminalState = terminalState;
    if (!signalProcess(live.child, "SIGTERM")) {
      await this.markInterrupted(commandId);
      return false;
    }
    const exited = await Promise.race([
      live.completion.then(() => true),
      delay(this.terminationGraceMs).then(() => false),
    ]);
    if (exited) return true;
    if (!signalProcess(live.child, "SIGKILL")) {
      await this.markInterrupted(commandId);
      return false;
    }
    const killed = await Promise.race([
      live.completion.then(() => true),
      delay(this.terminationGraceMs).then(() => false),
    ]);
    if (killed) return true;
    await this.markInterrupted(commandId);
    return false;
  }

  private async markInterrupted(commandId: string): Promise<void> {
    const current = this.records.get(commandId);
    if (!current) return;
    this.records.set(commandId, { ...current, state: "interrupted" });
    await this.persist().catch(() => undefined);
  }

  private authorizedRecord(
    commandId: string,
    identity: WorkspaceCommandIdentity,
  ): WorkspaceCommandRecord {
    this.assertOwner(identity.ownerId);
    const record = this.requireRecord(commandId);
    if (
      record.ownerId !== identity.ownerId ||
      (identity.sessionId !== undefined &&
        record.sessionId !== identity.sessionId)
    ) {
      throw new Error("command_not_owned");
    }
    return record;
  }

  private assertOwner(ownerId: string): void {
    if (ownerId !== this.options.ownerId) throw new Error("command_not_owned");
  }

  private requireRecord(commandId: string): WorkspaceCommandRecord {
    const record = this.records.get(commandId);
    if (!record) throw new Error("command_not_found");
    return record;
  }

  private schedulePersist(): void {
    if (this.persistTimer || this.persistError) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => undefined);
    }, 250);
    this.persistTimer.unref?.();
  }

  private persist(): Promise<void> {
    if (this.persistError) return Promise.reject(this.persistError);
    const operation = this.persistTail.then(async () => {
      const records: DurableCommandRecord[] = [...this.records.values()].map(
        (record) => ({
          ...record,
          output: (this.output.get(record.commandId) ?? []).map((chunk) => ({
            stream: chunk.stream,
            offset: chunk.offset,
            base64: chunk.bytes.toString("base64"),
          })),
        }),
      );
      const content = `${JSON.stringify({ version: STATE_VERSION, records }, null, 2)}\n`;
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.statePath);
      await fs.chmod(this.statePath, 0o600);
    });
    this.persistTail = operation.catch((error: unknown) => {
      this.persistError = new Error(
        `command_state_persist_failed:${errorCode(error) ?? "unknown"}`,
      );
    });
    return operation;
  }
}

function publicRecord(
  launch: WorkspaceCommandLaunch,
  startedAt: number,
): Omit<
  WorkspaceCommandRecord,
  "state" | "outputStartOffset" | "outputEndOffset" | "outputDroppedBytes"
> {
  return {
    commandId: launch.commandId,
    ownerId: launch.ownerId,
    sessionId: launch.sessionId,
    turnId: launch.turnId,
    command: launch.command,
    executable: launch.executable,
    args: [...launch.args],
    cwd: launch.cwd,
    environmentKeys: [...launch.environmentKeys],
    mode: launch.mode,
    concurrentEditingAcknowledged: launch.concurrentEditingAcknowledged,
    policyFingerprint: launch.policyFingerprint,
    operationDigest: launch.operationDigest,
    startedAt,
  };
}

function withoutOutput(record: DurableCommandRecord): WorkspaceCommandRecord {
  const { output: _output, ...rest } = record;
  return rest;
}

function validateLaunch(launch: WorkspaceCommandLaunch, ownerId: string): void {
  if (launch.schemaVersion !== 1) throw new Error("command_launch_invalid");
  if (launch.ownerId !== ownerId) throw new Error("command_not_owned");
  if (!launch.commandId || !launch.sessionId || !launch.turnId) {
    throw new Error("command_launch_invalid");
  }
  if (!path.isAbsolute(launch.executable) || !path.isAbsolute(launch.cwd)) {
    throw new Error("command_launch_paths_must_be_absolute");
  }
  if (launch.mode === "background" && !launch.concurrentEditingAcknowledged) {
    throw new Error("background_concurrent_editing_not_acknowledged");
  }
  if (!Number.isSafeInteger(launch.timeoutMs) || launch.timeoutMs <= 0) {
    throw new Error("command_timeout_invalid");
  }
  if (
    !launch.environment ||
    Object.values(launch.environment).some(
      (value) => typeof value !== "string",
    ) ||
    JSON.stringify(Object.keys(launch.environment).sort()) !==
      JSON.stringify(launch.environmentKeys)
  ) {
    throw new Error("command_environment_invalid");
  }
}

function validDurableRecord(value: DurableCommandRecord): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.commandId === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.output) &&
    value.output.every(
      (chunk) =>
        (chunk.stream === "stdout" || chunk.stream === "stderr") &&
        Number.isSafeInteger(chunk.offset) &&
        typeof chunk.base64 === "string",
    )
  );
}

function sensitiveEnvironmentValues(
  environment: Readonly<Record<string, string>>,
): readonly Buffer[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        /(api[_-]?key|auth|cookie|credential|pass(word)?|secret|token)/iu.test(
          key,
        ) && isLikelySecretValue(value),
    )
    .map(([, value]) => Buffer.from(value, "utf8"))
    .sort((left, right) => right.length - left.length);
}

function isLikelySecretValue(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") < 8) return false;
  const normalized = value.trim().toLowerCase();
  if (/^(false|none|null|off|on|true|yes|no|undefined)$/u.test(normalized)) {
    return false;
  }
  if (/^\d+$/u.test(normalized) || path.isAbsolute(value)) return false;
  return true;
}

function secretPrefixSuffixLength(
  bytes: Buffer,
  values: readonly Buffer[],
): number {
  let keep = 0;
  for (const value of values) {
    const maximum = Math.min(bytes.length, value.length - 1);
    for (let length = maximum; length > keep; length -= 1) {
      if (
        bytes.subarray(bytes.length - length).equals(value.subarray(0, length))
      ) {
        keep = length;
        break;
      }
    }
  }
  return keep;
}

function redactBuffer(bytes: Buffer, values: readonly Buffer[]): Buffer {
  if (values.length === 0) return bytes;
  const redacted = Buffer.from(bytes);
  for (const value of values) {
    let offset = redacted.indexOf(value);
    while (offset !== -1) {
      redacted.fill(0x2a, offset, offset + value.length);
      offset = redacted.indexOf(value, offset + value.length);
    }
  }
  return redacted;
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function utf8SafeStart(bytes: Buffer, requestedStart: number): number {
  let start = requestedStart;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

function utf8SafeEnd(
  bytes: Buffer,
  start: number,
  requestedEnd: number,
): number {
  if (requestedEnd >= bytes.length) return requestedEnd;
  let lead = requestedEnd - 1;
  while (lead >= start && (bytes[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < start) return start;
  const first = bytes[lead]!;
  const length =
    (first & 0x80) === 0
      ? 1
      : (first & 0xe0) === 0xc0
        ? 2
        : (first & 0xf0) === 0xe0
          ? 3
          : (first & 0xf8) === 0xf0
            ? 4
            : 1;
  return lead + length <= requestedEnd ? requestedEnd : lead;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum
    ? value!
    : fallback;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
