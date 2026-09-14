import { createKeychainSecretStorage } from "@agentlink/node-host";
import {
  type WorkspaceMcpConfiguration,
  loadWorkspaceMcpConfiguration,
} from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

const SERVER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
const MCP_CREDENTIAL_PREFIX = "cli-mcp-credential:";

interface CliMcpHostConfig {
  readonly schemaVersion: 1;
  readonly trustedProjectServerIds: readonly string[];
  readonly servers: readonly unknown[];
}

export function cliMcpGlobalConfigPath(dataRoot: string): string {
  return path.join(dataRoot, "cli", "mcp.json");
}

export function cliMcpProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".agentlink", "mcp.json");
}

export async function ensureCliMcpGlobalConfig(
  dataRoot: string,
): Promise<string> {
  const configPath = cliMcpGlobalConfigPath(dataRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(
      configPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            trustedProjectServerIds: [],
            servers: [],
          } satisfies CliMcpHostConfig,
          null,
          2,
        )}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  return configPath;
}

export async function loadCliMcpConfiguration(
  dataRoot: string,
  projectRoot: string,
): Promise<WorkspaceMcpConfiguration> {
  return await loadWorkspaceMcpConfiguration({
    globalConfigPath: await ensureCliMcpGlobalConfig(dataRoot),
    projectRoot,
    projectConfigPath: cliMcpProjectConfigPath(projectRoot),
  });
}

export async function trustCliProjectMcpServer(
  dataRoot: string,
  serverId: string,
): Promise<void> {
  if (!SERVER_ID_PATTERN.test(serverId)) {
    throw new Error("MCP server ID is invalid");
  }
  const configPath = await ensureCliMcpGlobalConfig(dataRoot);
  const config = parseHostConfig(
    JSON.parse(await fs.readFile(configPath, "utf8")),
  );
  if (config.trustedProjectServerIds.includes(serverId)) return;
  await writeHostConfig(configPath, {
    ...config,
    trustedProjectServerIds: [
      ...config.trustedProjectServerIds,
      serverId,
    ].sort(),
  });
}

export async function setCliMcpCredential(
  credentialId: string,
  value: string,
): Promise<void> {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new Error("MCP credential ID is invalid");
  }
  const normalized = value.trim();
  if (!normalized) throw new Error("MCP credential cannot be empty");
  const storage = await createKeychainSecretStorage({
    account: `${MCP_CREDENTIAL_PREFIX}${credentialId}`,
  });
  await storage.store(normalized);
}

export async function resolveCliMcpCredential(
  credentialId: string,
): Promise<string> {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
    throw new Error("MCP credential ID is invalid");
  }
  const storage = await createKeychainSecretStorage({
    account: `${MCP_CREDENTIAL_PREFIX}${credentialId}`,
  });
  const value = await storage.get();
  if (!value)
    throw new Error(`MCP credential is not configured: ${credentialId}`);
  return value;
}

function parseHostConfig(value: unknown): CliMcpHostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Global MCP config must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.trustedProjectServerIds) ||
    !record.trustedProjectServerIds.every(
      (item) => typeof item === "string" && SERVER_ID_PATTERN.test(item),
    ) ||
    !Array.isArray(record.servers)
  ) {
    throw new Error("Global MCP config is invalid");
  }
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        key !== "schemaVersion" &&
        key !== "trustedProjectServerIds" &&
        key !== "servers",
    )
  ) {
    throw new Error("Global MCP config has unknown properties");
  }
  return {
    schemaVersion: 1,
    trustedProjectServerIds: [...record.trustedProjectServerIds],
    servers: [...record.servers],
  };
}

async function writeHostConfig(
  configPath: string,
  config: CliMcpHostConfig,
): Promise<void> {
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, configPath);
    await fs.chmod(configPath, 0o600);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
