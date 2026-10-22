import { existsSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";

/**
 * Client for "AgentLink Credentials", the signed macOS helper that reads and
 * writes AgentLink's shared Keychain items for every surface. Routing all
 * writes through one signature stops macOS resetting an item's trusted teams
 * on each write, which made VS Code, the CLI and Desktop keep asking for
 * Keychain access. See packages/node-host/native/credentials-helper.
 */

/** Environment override for the helper path, read when no path is configured. */
export const CREDENTIALS_HELPER_ENV = "AGENTLINK_CREDENTIALS_HELPER";

/** Prompts wait for the user, so allow time to answer one. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

let configuredHelperPath: string | undefined;

/**
 * Use this helper for shared Keychain items in this process. Hosts set it at
 * startup to their own copy (for example "AgentLink Credentials (VS Code)"),
 * so the macOS prompt names the surface that is asking.
 */
export function setCredentialsHelperPath(helperPath: string | undefined): void {
  configuredHelperPath = helperPath?.trim() || undefined;
}

/** The helper to use on macOS, if one is configured and present. */
export function resolveCredentialsHelperPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "darwin") return undefined;
  return [configuredHelperPath, env[CREDENTIALS_HELPER_ENV]?.trim()].find(
    (candidate): candidate is string => !!candidate && existsSync(candidate),
  );
}

/**
 * The helper cannot serve this process (missing, not runnable, or this caller
 * is not an allowed AgentLink or VS Code program). Callers fall back to direct
 * Keychain access, today's behaviour.
 */
export class CredentialsHelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsHelperUnavailableError";
  }
}

export interface CredentialsHelperEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<void>;
}

export interface CredentialsHelperEntryOptions {
  helperPath: string;
  service: string;
  account: string;
  /** Shown by macOS in Keychain prompts and Keychain Access. */
  label: string;
  timeoutMs?: number;
  spawn?: typeof spawnProcess;
}

interface HelperReply {
  ok?: boolean;
  value?: string | null;
  error?: string;
  status?: number;
  message?: string;
}

export function createCredentialsHelperEntry(
  options: CredentialsHelperEntryOptions,
): CredentialsHelperEntry {
  const call = async (request: {
    op: "get" | "store" | "delete";
    value?: string;
  }): Promise<string | undefined> => {
    const reply = await runHelper(options, {
      ...request,
      service: options.service,
      account: options.account,
      label: options.label,
    });
    if (reply.ok) return reply.value ?? undefined;
    if (reply.error === "caller_rejected") {
      throw new CredentialsHelperUnavailableError(
        reply.message ?? "This program may not use the credentials helper.",
      );
    }
    const status = reply.status === undefined ? "" : ` (${reply.status})`;
    throw new Error(
      `agentlink_credentials_helper_${reply.error ?? "failed"}: ${reply.message ?? "Keychain request failed"}${status}`,
    );
  };
  return {
    getPassword: async () => await call({ op: "get" }),
    setPassword: async (value) => {
      await call({ op: "store", value });
    },
    deletePassword: async () => {
      await call({ op: "delete" });
    },
  };
}

function runHelper(
  options: CredentialsHelperEntryOptions,
  request: Record<string, unknown>,
): Promise<HelperReply> {
  const spawn = options.spawn ?? spawnProcess;
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationError: Error | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const child = spawn(options.helperPath, [], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      terminationError = new Error("agentlink_credentials_helper_timeout");
      child.kill();
      // Keep the caller's serialization lock until close confirms the process
      // that owns a possible Keychain prompt is actually gone.
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new CredentialsHelperUnavailableError(
            `The credentials helper could not start: ${error.code ?? error.message}`,
          ),
        ),
      ),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        terminationError = new Error(
          "agentlink_credentials_helper_output_too_large",
        );
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", () =>
      finish(() => {
        if (terminationError) {
          reject(terminationError);
          return;
        }
        try {
          const parsed = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as HelperReply;
          resolve(parsed);
        } catch {
          reject(
            new CredentialsHelperUnavailableError(
              "The credentials helper returned no reply.",
            ),
          );
        }
      }),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(request));
  });
}

const OPENAI_COMPATIBLE_KEY = "openai-compatible-api-key:";
const OPENAI_COMPATIBLE_STATE = "openai-compatible-api-key-state:";

/**
 * Human label for a shared Keychain item, shown by macOS when it asks for
 * access, so the prompt says which AgentLink credential is involved.
 */
export function describeSharedCredential(account: string): string {
  switch (account) {
    case "codex-oauth-credentials":
      return "AgentLink: Codex sign-in (shared by VS Code, CLI and Desktop)";
    case "agentlink-cli-mcp-oauth-v1":
      return "AgentLink: MCP server sign-ins (CLI)";
    case "agentlink-desktop-mcp-oauth-v1":
      return "AgentLink: MCP server sign-ins (Desktop)";
    case "agentlink-standalone-mcp-oauth-v2":
      return "AgentLink: MCP server sign-ins (shared by CLI and Desktop)";
    case "agentlink-mcp-oauth-v1":
      return "AgentLink: MCP server sign-ins";
  }
  if (account.startsWith(OPENAI_COMPATIBLE_STATE)) {
    return "AgentLink: OpenAI-compatible provider key status";
  }
  if (account.startsWith(OPENAI_COMPATIBLE_KEY)) {
    return "AgentLink: OpenAI-compatible provider API key";
  }
  return `AgentLink: ${account.slice(0, 120)}`;
}
