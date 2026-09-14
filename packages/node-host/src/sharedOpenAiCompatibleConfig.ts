import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { randomUUID } from "node:crypto";

export const OPENAI_COMPATIBLE_CONFIG_FILENAME = "openai-compatible.json";
export const OPENAI_COMPATIBLE_CONFIG_SCHEMA_VERSION = 1;

const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;

export interface SharedOpenAiCompatibleConfigDocument {
  readonly schemaVersion: 1;
  readonly connections: readonly unknown[];
}

export interface SharedOpenAiCompatibleConfigOptions {
  dataRoot?: string;
  maxConfigBytes?: number;
}

export class SharedOpenAiCompatibleConfigStore {
  readonly dataRoot: string;
  readonly configPath: string;
  private readonly lockPath: string;
  private readonly maxConfigBytes: number;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SharedOpenAiCompatibleConfigOptions = {}) {
    this.dataRoot = options.dataRoot ?? path.join(os.homedir(), ".agentlink");
    this.configPath = path.join(
      this.dataRoot,
      OPENAI_COMPATIBLE_CONFIG_FILENAME,
    );
    this.lockPath = `${this.configPath}.lock`;
    this.maxConfigBytes = positiveInteger(
      options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES,
      "maxConfigBytes",
    );
  }

  async read(): Promise<SharedOpenAiCompatibleConfigDocument | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.configPath, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxConfigBytes) {
        throw invalidConfig();
      }
      return parseDocument(await readBounded(handle, this.maxConfigBytes));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  write(
    connections: readonly unknown[],
    options: { expectedConnections?: readonly unknown[] } = {},
  ): Promise<void> {
    return this.serializeMutation(async () => {
      const content = serializeDocument(connections, this.maxConfigBytes);
      await this.prepareDataRoot();
      await this.withCrossProcessLock(async () => {
        if (options.expectedConnections) {
          const current = await this.read();
          if (
            JSON.stringify(current?.connections ?? []) !==
            JSON.stringify(options.expectedConnections)
          ) {
            throw new Error("agentlink_openai_compatible_config_changed");
          }
        }
        const temporaryPath = await this.writeTemporary(content);
        try {
          await fs.rename(temporaryPath, this.configPath);
          await fs.chmod(this.configPath, 0o600);
          await syncDirectory(this.dataRoot);
        } finally {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      });
    });
  }

  /** Copies legacy connections only when the shared config is absent. */
  importLegacyIfAbsent(connections: readonly unknown[]): Promise<boolean> {
    return this.serializeMutation(async () => {
      const content = serializeDocument(connections, this.maxConfigBytes);
      await this.prepareDataRoot();
      const temporaryPath = await this.writeTemporary(content);
      try {
        try {
          await fs.link(temporaryPath, this.configPath);
        } catch (error) {
          if (errorCode(error) === "EEXIST") return false;
          throw error;
        }
        await syncDirectory(this.dataRoot);
        return true;
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
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
          throw new Error("agentlink_openai_compatible_config_lock_timeout");
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

  private async writeTemporary(content: string): Promise<string> {
    const temporaryPath = path.join(
      this.dataRoot,
      `.${OPENAI_COMPATIBLE_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      return temporaryPath;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
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
    throw new Error("agentlink_openai_compatible_config_too_large");
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function serializeDocument(
  connections: readonly unknown[],
  maxBytes: number,
): string {
  if (!Array.isArray(connections)) {
    throw new Error("agentlink_openai_compatible_connections_invalid");
  }
  const content = JSON.stringify(
    { schemaVersion: OPENAI_COMPATIBLE_CONFIG_SCHEMA_VERSION, connections },
    null,
    2,
  );
  if (content === undefined) {
    throw new Error("agentlink_openai_compatible_connections_invalid");
  }
  const serialized = `${content}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("agentlink_openai_compatible_config_too_large");
  }
  return serialized;
}

function parseDocument(content: string): SharedOpenAiCompatibleConfigDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidConfig();
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== OPENAI_COMPATIBLE_CONFIG_SCHEMA_VERSION ||
    !Array.isArray(parsed.connections)
  ) {
    throw invalidConfig();
  }
  return {
    schemaVersion: OPENAI_COMPATIBLE_CONFIG_SCHEMA_VERSION,
    connections: parsed.connections,
  };
}

function invalidConfig(): Error {
  return new Error("agentlink_openai_compatible_config_invalid");
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
