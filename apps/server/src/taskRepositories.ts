import { HttpError } from "./httpJson.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { planRepositories } from "./projectCatalog.js";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * Owner settings per repository, in `<dataRoot>/tasks/repositories.json`:
 * the validation commands the server runs against each task's commit, and
 * the standing permission to publish its tasks. They come from the owner,
 * never from the repository's own files, so a repository cannot choose
 * what runs on the server or where it is published.
 */

export const MAX_VALIDATION_COMMANDS = 10;
export const MAX_VALIDATION_COMMAND_LENGTH = 1_000;
const MAX_REPOSITORIES = 200;

/**
 * Standing permission to publish this repository's tasks: push each task's
 * commit to its own `agentlink/*` branch (never forced) and open or update
 * that task's draft pull request, with one GitHub connection. Nothing else
 * (merging, other branches, comments, labels) can be granted.
 */
export interface PublishPermission {
  readonly connectionId: string;
  readonly grantedAt: number;
}

export interface RepositorySettings {
  /** As given, normalized: `https://host/owner/name` without `.git`. */
  readonly repository: string;
  /** Shell commands run in order in the task's clone; all must pass. */
  readonly validation: readonly string[];
  readonly publish?: PublishPermission;
  readonly updatedAt: number;
}

export interface RepositorySettingsStore {
  list(): readonly RepositorySettings[];
  get(repository: string): RepositorySettings | undefined;
  /**
   * Replace a repository's validation commands, keeping its permission. An
   * entry with neither is removed.
   */
  set(
    repository: string,
    validation: readonly string[],
    now: number,
  ): Promise<RepositorySettings | undefined>;
  /** Grant (with a connection) or revoke (undefined) publishing. */
  setPublish(
    repository: string,
    connectionId: string | undefined,
    now: number,
  ): Promise<RepositorySettings | undefined>;
  /** Revoke every permission that uses this connection. */
  revokeConnection(connectionId: string, now: number): Promise<void>;
}

interface StoredSettings {
  readonly schemaVersion: 1;
  readonly repositories: readonly RepositorySettings[];
}

/** One key per repository, whatever spelling of its URL a task used. */
export function repositoryKey(repository: string): string {
  const [planned] = planRepositories([repository]);
  const url = new URL(planned!.url);
  const pathname = url.pathname
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
  return `https://${url.host.toLowerCase()}${pathname}`;
}

/** Validate validation commands from an untrusted body. */
export function parseValidationCommands(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "validation_invalid");
  }
  const commands = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new HttpError(400, "validation_invalid");
    }
    const command = entry.trim();
    if (!command || command.length > MAX_VALIDATION_COMMAND_LENGTH) {
      throw new HttpError(400, "validation_command_invalid");
    }
    return command;
  });
  if (commands.length > MAX_VALIDATION_COMMANDS) {
    throw new HttpError(400, "too_many_validation_commands");
  }
  return commands;
}

export async function openRepositorySettings(options: {
  readonly file: string;
}): Promise<RepositorySettingsStore> {
  const entries = new Map<string, RepositorySettings>();
  for (const entry of await readSettings(options.file)) {
    entries.set(entry.repository, entry);
  }
  let writes: Promise<void> = Promise.resolve();
  const persist = () => {
    const content: StoredSettings = {
      schemaVersion: 1,
      repositories: [...entries.values()],
    };
    const next = writes.then(async () => {
      await fs.mkdir(path.dirname(options.file), {
        recursive: true,
        mode: 0o700,
      });
      await writeFileAtomic(
        options.file,
        `${JSON.stringify(content, null, 2)}\n`,
      );
    });
    writes = next.catch(() => undefined);
    return next;
  };
  /** Store an entry, or remove it when it holds nothing. */
  const store = async (
    key: string,
    validation: readonly string[],
    publish: PublishPermission | undefined,
    now: number,
  ): Promise<RepositorySettings | undefined> => {
    if (validation.length === 0 && !publish) {
      if (entries.delete(key)) await persist();
      return undefined;
    }
    if (!entries.has(key) && entries.size >= MAX_REPOSITORIES) {
      throw new HttpError(409, "repository_limit_reached");
    }
    const entry: RepositorySettings = {
      repository: key,
      validation,
      ...(publish ? { publish } : {}),
      updatedAt: now,
    };
    entries.set(key, entry);
    await persist();
    return entry;
  };
  return {
    list: () => [...entries.values()],
    get: (repository) => {
      try {
        return entries.get(repositoryKey(repository));
      } catch {
        return undefined;
      }
    },
    async set(repository, validation, now) {
      const key = repositoryKey(repository);
      const commands = parseValidationCommands(validation);
      return store(key, commands, entries.get(key)?.publish, now);
    },
    async setPublish(repository, connectionId, now) {
      const key = repositoryKey(repository);
      const current = entries.get(key);
      const publish =
        connectionId === undefined
          ? undefined
          : current?.publish?.connectionId === connectionId
            ? current.publish
            : { connectionId, grantedAt: now };
      return store(key, current?.validation ?? [], publish, now);
    },
    async revokeConnection(connectionId, now) {
      // Collected first: storing changes the map being read.
      const granted = Array.from(entries.values()).filter(
        (entry) => entry.publish?.connectionId === connectionId,
      );
      for (const entry of granted) {
        await store(entry.repository, entry.validation, undefined, now);
      }
    },
  };
}

async function readSettings(file: string): Promise<RepositorySettings[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: Partial<StoredSettings> | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<StoredSettings>;
  } catch {
    parsed = undefined;
  }
  const valid =
    parsed?.schemaVersion === 1 &&
    Array.isArray(parsed.repositories) &&
    parsed.repositories.every(
      (entry) =>
        typeof entry?.repository === "string" &&
        Array.isArray(entry.validation) &&
        entry.validation.every(
          (command: unknown) => typeof command === "string",
        ) &&
        (entry.publish === undefined ||
          (typeof entry.publish?.connectionId === "string" &&
            typeof entry.publish.grantedAt === "number")) &&
        typeof entry.updatedAt === "number",
    );
  if (!valid) {
    throw new Error(
      `Repository settings are unreadable: ${file}. Fix or remove it (removing forgets every repository's validation commands).`,
    );
  }
  return [...parsed!.repositories!];
}
