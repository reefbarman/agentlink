import { promises as fs, constants as fsConstants } from "node:fs";

import path from "node:path";
import { randomUUID } from "node:crypto";

const ENABLEMENT_SCHEMA_VERSION = 1;
const PROJECT_ID_PATTERN = /^[a-f0-9]{64}$/u;

export interface ManagedTypeScriptProjectEnablement {
  readonly enabled: boolean;
  readonly enabledAt?: string;
}

export async function readManagedTypeScriptProjectEnablement(
  dataRoot: string,
  projectId: string,
): Promise<ManagedTypeScriptProjectEnablement> {
  const filePath = enablementPath(dataRoot, projectId);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { enabled: false };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== ENABLEMENT_SCHEMA_VERSION ||
    value.enabled !== true ||
    typeof value.enabledAt !== "string"
  ) {
    throw new Error("invalid_managed_typescript_project_enablement");
  }
  return { enabled: true, enabledAt: value.enabledAt };
}

export async function enableManagedTypeScriptForProject(
  dataRoot: string,
  projectId: string,
): Promise<ManagedTypeScriptProjectEnablement> {
  const filePath = enablementPath(dataRoot, projectId);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const enabledAt = new Date().toISOString();
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(
      `${JSON.stringify({
        schemaVersion: ENABLEMENT_SCHEMA_VERSION,
        enabled: true,
        enabledAt,
      })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { enabled: true, enabledAt };
}

export async function disableManagedTypeScriptForProject(
  dataRoot: string,
  projectId: string,
): Promise<boolean> {
  const filePath = enablementPath(dataRoot, projectId);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function enablementPath(dataRoot: string, projectId: string): string {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error("Managed TypeScript dataRoot must be an absolute path");
  }
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("invalid_managed_typescript_project_id");
  }
  return path.join(
    dataRoot,
    "projects",
    projectId,
    "language-intelligence.json",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return error instanceof Error ? error.message : String(error);
}
