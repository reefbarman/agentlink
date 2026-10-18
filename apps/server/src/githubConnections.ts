import { HttpError } from "./httpJson.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * GitHub connections as the assistant server knows them, in
 * `<dataRoot>/github/connections.json`: which account each is, and the name
 * and email its tasks' commits credit as co-author. Never a token: those
 * live only in the publisher, under the same connection ID.
 */

export const MAX_CONNECTIONS = 20;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/u;

export interface GitHubConnection {
  readonly id: string;
  /** `app`: signed in through the GitHub App. `token`: a pasted token. */
  readonly kind: "app" | "token";
  /** The GitHub account, once signed in. */
  readonly login?: string;
  /** Credited as `Co-authored-by` on this connection's task commits. */
  readonly commitName: string;
  readonly commitEmail: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CommitIdentity {
  readonly commitName: string;
  readonly commitEmail: string;
}

export interface GitHubConnectionStore {
  list(): readonly GitHubConnection[];
  get(id: string): GitHubConnection | undefined;
  create(
    kind: GitHubConnection["kind"],
    identity: CommitIdentity,
    now: number,
  ): Promise<GitHubConnection>;
  update(
    id: string,
    patch: Partial<CommitIdentity> & {
      readonly login?: string;
      readonly kind?: GitHubConnection["kind"];
    },
    now: number,
  ): Promise<GitHubConnection>;
  delete(id: string): Promise<boolean>;
}

interface StoredConnections {
  readonly schemaVersion: 1;
  readonly connections: readonly GitHubConnection[];
}

/** Validate a commit identity from an untrusted body. */
export function parseCommitIdentity(
  body: Record<string, unknown>,
  partial = false,
): Partial<CommitIdentity> {
  const result: { commitName?: string; commitEmail?: string } = {};
  if (body.commitName !== undefined || !partial) {
    const name = body.commitName;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > MAX_NAME_LENGTH ||
      [...name].some(
        (character) =>
          character === "<" ||
          character === ">" ||
          character.charCodeAt(0) < 0x20 ||
          character.charCodeAt(0) === 0x7f,
      )
    ) {
      throw new HttpError(400, "commit_name_invalid");
    }
    result.commitName = name.trim();
  }
  if (body.commitEmail !== undefined || !partial) {
    const email = body.commitEmail;
    if (
      typeof email !== "string" ||
      email.trim().length > MAX_EMAIL_LENGTH ||
      !EMAIL_PATTERN.test(email.trim())
    ) {
      throw new HttpError(400, "commit_email_invalid");
    }
    result.commitEmail = email.trim();
  }
  return result;
}

export async function openGitHubConnections(options: {
  readonly file: string;
}): Promise<GitHubConnectionStore> {
  const connections = new Map<string, GitHubConnection>();
  for (const entry of await readConnections(options.file)) {
    connections.set(entry.id, entry);
  }
  let writes: Promise<void> = Promise.resolve();
  const persist = () => {
    const content: StoredConnections = {
      schemaVersion: 1,
      connections: [...connections.values()],
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
  return {
    list: () =>
      [...connections.values()].sort(
        (left, right) => left.createdAt - right.createdAt,
      ),
    get: (id) => connections.get(id),
    async create(kind, identity, now) {
      if (connections.size >= MAX_CONNECTIONS) {
        throw new HttpError(409, "connection_limit_reached");
      }
      const connection: GitHubConnection = {
        id: randomBytes(6).toString("hex"),
        kind,
        commitName: identity.commitName,
        commitEmail: identity.commitEmail,
        createdAt: now,
        updatedAt: now,
      };
      connections.set(connection.id, connection);
      await persist();
      return connection;
    },
    async update(id, patch, now) {
      const current = connections.get(id);
      if (!current) throw new HttpError(404, "connection_not_found");
      const next: GitHubConnection = {
        ...current,
        ...(patch.commitName !== undefined
          ? { commitName: patch.commitName }
          : {}),
        ...(patch.commitEmail !== undefined
          ? { commitEmail: patch.commitEmail }
          : {}),
        ...(patch.login !== undefined ? { login: patch.login } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        updatedAt: now,
      };
      connections.set(id, next);
      await persist();
      return next;
    },
    async delete(id) {
      if (!connections.delete(id)) return false;
      await persist();
      return true;
    },
  };
}

async function readConnections(file: string): Promise<GitHubConnection[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: Partial<StoredConnections> | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<StoredConnections>;
  } catch {
    parsed = undefined;
  }
  const valid =
    parsed?.schemaVersion === 1 &&
    Array.isArray(parsed.connections) &&
    parsed.connections.every(
      (entry) =>
        typeof entry?.id === "string" &&
        /^[0-9a-f]{12}$/u.test(entry.id) &&
        (entry.kind === "app" || entry.kind === "token") &&
        typeof entry.commitName === "string" &&
        typeof entry.commitEmail === "string" &&
        typeof entry.createdAt === "number",
    );
  if (!valid) {
    throw new Error(
      `GitHub connections are unreadable: ${file}. Fix or remove it (removing forgets every connection's name and email; connect them again).`,
    );
  }
  return [...parsed!.connections!];
}
