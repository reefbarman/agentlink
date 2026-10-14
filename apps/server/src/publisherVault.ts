import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * The publisher's GitHub credentials, one per connection, in a single file
 * encrypted with AES-256-GCM under a key the publisher reads from its own
 * secret file. Only the publisher process ever holds this file or the key:
 * the assistant server, the command worker and model context never do.
 */

export const CONNECTION_ID_PATTERN = /^[0-9a-f]{12}$/u;

export interface StoredCredential {
  readonly id: string;
  /** `app`: GitHub App device-flow sign-in. `token`: a pasted token. */
  readonly kind: "app" | "token";
  /** The GitHub account the token belongs to. */
  readonly login: string;
  readonly accessToken: string;
  /** Epoch milliseconds; absent when the token does not expire. */
  readonly accessTokenExpiresAt?: number;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: number;
  readonly updatedAt: number;
}

export interface CredentialVault {
  get(id: string): StoredCredential | undefined;
  put(credential: StoredCredential): Promise<void>;
  delete(id: string): Promise<boolean>;
}

interface SealedFile {
  readonly schemaVersion: 1;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** A 32-byte key: 64 hex characters (`openssl rand -hex 32`) or raw bytes. */
export function parseVaultKey(raw: Buffer): Buffer {
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return Buffer.from(text, "hex");
  if (raw.length === 32) return Buffer.from(raw);
  throw new Error(
    "the key must be 32 bytes: create it with `openssl rand -hex 32`",
  );
}

export function sealCredentials(
  key: Buffer,
  credentials: readonly StoredCredential[],
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  const sealed: SealedFile = {
    schemaVersion: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return `${JSON.stringify(sealed)}\n`;
}

export function openCredentials(
  key: Buffer,
  content: string,
): StoredCredential[] {
  const sealed = JSON.parse(content) as Partial<SealedFile>;
  if (
    sealed.schemaVersion !== 1 ||
    typeof sealed.iv !== "string" ||
    typeof sealed.tag !== "string" ||
    typeof sealed.data !== "string"
  ) {
    throw new Error("unrecognised format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(plain);
  if (!Array.isArray(parsed) || !parsed.every(isCredential)) {
    throw new Error("unrecognised contents");
  }
  return parsed;
}

function isCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    CONNECTION_ID_PATTERN.test(entry.id) &&
    (entry.kind === "app" || entry.kind === "token") &&
    typeof entry.login === "string" &&
    typeof entry.accessToken === "string" &&
    typeof entry.updatedAt === "number"
  );
}

/**
 * Open the vault at `file`. A missing file is an empty vault; a file the key
 * cannot open stops the publisher rather than silently losing connections.
 */
export async function openCredentialVault(options: {
  readonly file: string;
  readonly key: Buffer;
}): Promise<CredentialVault> {
  const credentials = new Map<string, StoredCredential>();
  let content: string | undefined;
  try {
    content = await fs.readFile(options.file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (content !== undefined) {
    let entries: StoredCredential[];
    try {
      entries = openCredentials(options.key, content);
    } catch {
      throw new Error(
        `GitHub connections are unreadable with this key: ${options.file}. Restore the matching key, or remove the file and connect GitHub again.`,
      );
    }
    for (const entry of entries) credentials.set(entry.id, entry);
  }
  let writes: Promise<void> = Promise.resolve();
  const persist = () => {
    const sealed = sealCredentials(options.key, [...credentials.values()]);
    const next = writes.then(async () => {
      await fs.mkdir(path.dirname(options.file), {
        recursive: true,
        mode: 0o700,
      });
      await writeFileAtomic(options.file, sealed, 0o600);
    });
    writes = next.catch(() => undefined);
    return next;
  };
  return {
    get: (id) => credentials.get(id),
    async put(credential) {
      credentials.set(credential.id, credential);
      await persist();
    },
    async delete(id) {
      if (!credentials.delete(id)) return false;
      await persist();
      return true;
    },
  };
}
