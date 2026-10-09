import {
  createCodexOAuthRuntime,
  type CodexOAuthRuntime,
  type CodexOAuthStateStorage,
} from "@agentlink/node-host";
import { promises as fs } from "node:fs";
import path from "node:path";

import { syncDirectory, writeFileAtomic } from "./atomicFile.js";
import { withFileLock } from "./fileLock.js";
import type { AssistantServerConfig } from "./serverConfig.js";

const SIGN_IN_FILE = "codex-sign-in.json";
const LOCK_FILE = "codex-sign-in.lock";
const MAX_STATE_BYTES = 1024 * 1024;
/** A token refresh holds the lock across a 30-second network request. */
const LOCK_TIMEOUT_MS = 45_000;

/** Private directory for sign-in tokens under the data root. */
export function serverCredentialsDirectory(
  config: AssistantServerConfig,
): string {
  return path.join(config.dataRoot, "credentials");
}

export function hasCodexProvider(config: AssistantServerConfig): boolean {
  return config.providers.some((provider) => provider.type === "codex");
}

/**
 * Codex (ChatGPT) sign-in state in one private file, shared by the running
 * service and the local `codex-login` command. Mutations are serialised
 * with a lock file, so a token refresh in the service and a new sign-in
 * cannot overwrite each other. A file readable by group or others, or not
 * a regular file, is refused rather than used.
 */
export function createFileCodexOAuthStorage(
  directory: string,
  options: { readonly lockTimeoutMs?: number } = {},
): CodexOAuthStateStorage {
  const file = path.join(directory, SIGN_IN_FILE);
  const ensureDirectory = () =>
    fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return {
    async get() {
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      if (!stat.isFile()) {
        throw new Error(`Codex sign-in state ${file} is not a regular file`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(
          `Codex sign-in state ${file} must not be accessible by group or others (chmod 600)`,
        );
      }
      if (stat.size > MAX_STATE_BYTES) {
        throw new Error(`Codex sign-in state ${file} is too large`);
      }
      return await fs.readFile(file, "utf8");
    },
    async store(value) {
      await ensureDirectory();
      await writeFileAtomic(file, value, 0o600);
    },
    async delete() {
      try {
        await fs.unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await syncDirectory(directory);
    },
    async withMutationLock(operation) {
      await ensureDirectory();
      return await withFileLock(path.join(directory, LOCK_FILE), operation, {
        timeoutMs: options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
      });
    },
  };
}

/** The Codex runtime backed by this server's private sign-in file. */
export function createServerCodexRuntime(
  config: AssistantServerConfig,
  log?: (line: string) => void,
): CodexOAuthRuntime<unknown> {
  return createCodexOAuthRuntime({
    storage: createFileCodexOAuthStorage(serverCredentialsDirectory(config)),
    ...(log ? { log } : {}),
  });
}

/** One line describing who is signed in, for `--check` and startup logs. */
export async function describeCodexSignIn(
  runtime: CodexOAuthRuntime<unknown>,
): Promise<string> {
  await runtime.ready();
  const accounts = await runtime.manager.listAccounts();
  if (accounts.length === 0) {
    return "Codex: not signed in (run `agentlink-server codex-login`)";
  }
  const active = accounts.find((account) => account.isActive) ?? accounts[0]!;
  return `Codex: signed in as ${active.label}${accounts.length > 1 ? ` (+${accounts.length - 1} more)` : ""}`;
}
