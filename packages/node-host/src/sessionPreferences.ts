import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { isCoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import { randomUUID } from "node:crypto";

export const SESSION_PREFERENCES_FILENAME = "session-preferences.json";
export const SESSION_PREFERENCES_SCHEMA_VERSION = 1;

const DEFAULT_MAX_CONFIG_BYTES = 64 * 1024;

export interface SessionPreferencesSnapshot {
  readonly defaultMode?: string;
  readonly modeModels: Readonly<Record<string, string>>;
  readonly modeReasoningEfforts: Readonly<Record<string, CoreReasoningEffort>>;
  readonly modelCondenseThresholds: Readonly<Record<string, number>>;
}

export interface SessionPreferencesPatch {
  readonly defaultMode?: string;
  readonly modeModels?: Readonly<Record<string, string>>;
  readonly modeReasoningEfforts?: Readonly<Record<string, CoreReasoningEffort>>;
  readonly modelCondenseThresholds?: Readonly<Record<string, number>>;
  readonly removeModelCondenseThresholds?: readonly string[];
}

export interface SessionPreferencesStoreOptions {
  dataRoot?: string;
  environment?: NodeJS.ProcessEnv;
  maxConfigBytes?: number;
}

const EMPTY_SESSION_PREFERENCES: SessionPreferencesSnapshot = {
  modeModels: {},
  modeReasoningEfforts: {},
  modelCondenseThresholds: {},
};

export class SessionPreferencesStore {
  readonly dataRoot: string;
  readonly configPath: string;
  private readonly lockPath: string;
  private readonly maxConfigBytes: number;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionPreferencesStoreOptions = {}) {
    const environment = options.environment ?? process.env;
    this.dataRoot =
      options.dataRoot ??
      path.resolve(
        environment.AGENTLINK_HOME?.trim() ||
          path.join(os.homedir(), ".agentlink"),
      );
    this.configPath = path.join(this.dataRoot, SESSION_PREFERENCES_FILENAME);
    this.lockPath = `${this.configPath}.lock`;
    this.maxConfigBytes = positiveInteger(
      options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES,
      "maxConfigBytes",
    );
  }

  async read(): Promise<SessionPreferencesSnapshot> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.configPath, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxConfigBytes) {
        throw invalidPreferences();
      }
      return parseDocument(await readBounded(handle, this.maxConfigBytes));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return EMPTY_SESSION_PREFERENCES;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  update(patch: SessionPreferencesPatch): Promise<SessionPreferencesSnapshot> {
    return this.serializeMutation(async () => {
      await this.prepareDataRoot();
      return this.withCrossProcessLock(async () => {
        const current = await this.read();
        const next = mergeSessionPreferences(current, patch);
        await this.replace(serializeDocument(next, this.maxConfigBytes));
        return next;
      });
    });
  }

  importLegacyIfAbsent(
    preferences: SessionPreferencesPatch,
  ): Promise<SessionPreferencesSnapshot> {
    return this.serializeMutation(async () => {
      await this.prepareDataRoot();
      return this.withCrossProcessLock(async () => {
        const current = await this.read();
        const next = mergeMissingSessionPreferences(current, preferences);
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          await this.replace(serializeDocument(next, this.maxConfigBytes));
        }
        return next;
      });
    });
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async prepareDataRoot(): Promise<void> {
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataRoot, 0o700);
  }

  private async withCrossProcessLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const stat = await fs.stat(this.lockPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > 30_000) {
          await fs.rm(this.lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("agentlink_session_preferences_lock_timeout");
        }
        await delay(20);
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async replace(content: string): Promise<void> {
    const temporaryPath = path.join(
      this.dataRoot,
      `.${SESSION_PREFERENCES_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, this.configPath);
      await fs.chmod(this.configPath, 0o600);
      await syncDirectory(this.dataRoot);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function mergeSessionPreferences(
  current: SessionPreferencesSnapshot,
  patch: SessionPreferencesPatch,
): SessionPreferencesSnapshot {
  const modelCondenseThresholds = {
    ...current.modelCondenseThresholds,
    ...patch.modelCondenseThresholds,
  };
  for (const modelId of patch.removeModelCondenseThresholds ?? []) {
    delete modelCondenseThresholds[modelId.trim()];
  }
  return normalizePreferences({
    defaultMode: patch.defaultMode ?? current.defaultMode,
    modeModels: { ...current.modeModels, ...patch.modeModels },
    modeReasoningEfforts: {
      ...current.modeReasoningEfforts,
      ...patch.modeReasoningEfforts,
    },
    modelCondenseThresholds,
  });
}

function mergeMissingSessionPreferences(
  current: SessionPreferencesSnapshot,
  legacy: SessionPreferencesPatch,
): SessionPreferencesSnapshot {
  return normalizePreferences({
    defaultMode: current.defaultMode ?? legacy.defaultMode,
    modeModels: { ...legacy.modeModels, ...current.modeModels },
    modeReasoningEfforts: {
      ...legacy.modeReasoningEfforts,
      ...current.modeReasoningEfforts,
    },
    modelCondenseThresholds: {
      ...legacy.modelCondenseThresholds,
      ...current.modelCondenseThresholds,
    },
  });
}

function normalizePreferences(value: unknown): SessionPreferencesSnapshot {
  if (!isRecord(value)) throw invalidPreferences();
  return {
    defaultMode: optionalText(value.defaultMode),
    modeModels: stringMap(value.modeModels),
    modeReasoningEfforts: reasoningEffortMap(value.modeReasoningEfforts),
    modelCondenseThresholds: thresholdMap(value.modelCondenseThresholds),
  };
}

function parseDocument(content: string): SessionPreferencesSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidPreferences();
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== SESSION_PREFERENCES_SCHEMA_VERSION
  ) {
    throw invalidPreferences();
  }
  return normalizePreferences(parsed);
}

function serializeDocument(
  preferences: SessionPreferencesSnapshot,
  maxBytes: number,
): string {
  const serialized = `${JSON.stringify(
    {
      schemaVersion: SESSION_PREFERENCES_SCHEMA_VERSION,
      ...preferences,
    },
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("agentlink_session_preferences_too_large");
  }
  return serialized;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidPreferences();
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    const normalizedValue = optionalText(entry);
    if (normalizedKey && normalizedValue)
      result[normalizedKey] = normalizedValue;
  }
  return result;
}

function reasoningEffortMap(
  value: unknown,
): Record<string, CoreReasoningEffort> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidPreferences();
  const result: Record<string, CoreReasoningEffort> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (normalizedKey && isCoreReasoningEffort(entry)) {
      result[normalizedKey] = entry;
    }
  }
  return result;
}

function thresholdMap(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalidPreferences();
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (
      normalizedKey &&
      typeof entry === "number" &&
      Number.isFinite(entry) &&
      entry >= 0.1 &&
      entry <= 1
    ) {
      result[normalizedKey] = entry;
    }
  }
  return result;
}

async function readBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
  maxBytes: number,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new Error("agentlink_session_preferences_too_large");
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function invalidPreferences(): Error {
  return new Error("agentlink_session_preferences_invalid");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
