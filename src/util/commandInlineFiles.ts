import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const INLINE_FILE_TOKEN_RE = /\$AL_FILE\(([A-Za-z0-9_.-]+)\)/g;
export const MAX_INLINE_COMMAND_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_COMMAND_FILES = 8;

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const EXT_RE = /^[A-Za-z0-9]{1,16}$/;

export interface InlineCommandFileInput {
  name: string;
  content: string;
  ext?: string;
  mode?: "644" | "755";
}

export interface InlineCommandFilePreview {
  name: string;
  path: string;
  ext?: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  executable: boolean;
  preview: string;
}

export interface MaterializedInlineCommandFiles {
  commandTemplate: string;
  command: string;
  previews: InlineCommandFilePreview[];
  cleanup: () => void;
}

export type InlineCommandFileErrorCode =
  | "too_many_files"
  | "invalid_name"
  | "invalid_ext"
  | "duplicate_name"
  | "unknown_reference"
  | "unreferenced_file"
  | "unresolved_token"
  | "size_limit_exceeded";

export class InlineCommandFileError extends Error {
  constructor(
    public readonly code: InlineCommandFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InlineCommandFileError";
  }
}

export function materializeInlineCommandFiles(
  command: string,
  files: InlineCommandFileInput[] | undefined,
): MaterializedInlineCommandFiles | undefined {
  if (!files || files.length === 0) return undefined;
  validateInlineCommandFiles(command, files);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cmd-"));
  let cleaned = false;

  try {
    const previews: InlineCommandFilePreview[] = [];
    const pathByName = new Map<string, string>();

    for (const file of files) {
      const filename = `${file.name}${file.ext ? `.${file.ext}` : ""}`;
      const filePath = path.join(dir, filename);
      const bytes = Buffer.byteLength(file.content, "utf-8");
      const sha256 = crypto
        .createHash("sha256")
        .update(file.content, "utf-8")
        .digest("hex");
      const mode = file.mode === "755" ? 0o755 : 0o600;

      fs.writeFileSync(filePath, file.content, { encoding: "utf-8", mode });
      pathByName.set(file.name, filePath);
      previews.push({
        name: file.name,
        path: filePath,
        ext: file.ext,
        bytes,
        sha256,
        truncated: shouldTruncatePreview(file.content, file.mode === "755"),
        executable: file.mode === "755",
        preview: buildPreview(file.content, file.mode === "755"),
      });
    }

    const substituted = command.replace(
      INLINE_FILE_TOKEN_RE,
      (_token, name) => {
        const filePath = pathByName.get(String(name));
        if (!filePath) {
          throw new InlineCommandFileError(
            "unknown_reference",
            `No inline command file named '${String(name)}' was provided.`,
          );
        }
        return quotePosixShellArg(filePath);
      },
    );

    return {
      commandTemplate: command,
      command: substituted,
      previews,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function validateInlineCommandFiles(
  command: string,
  files: InlineCommandFileInput[],
): void {
  if (files.length > MAX_INLINE_COMMAND_FILES) {
    throw new InlineCommandFileError(
      "too_many_files",
      `execute_command files is limited to ${MAX_INLINE_COMMAND_FILES} entries.`,
    );
  }

  const names = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (!NAME_RE.test(file.name) || file.name.includes("..")) {
      throw new InlineCommandFileError(
        "invalid_name",
        `Invalid inline command file name '${file.name}'. Use /^[A-Za-z0-9_.-]{1,64}$/.`,
      );
    }
    if (names.has(file.name)) {
      throw new InlineCommandFileError(
        "duplicate_name",
        `Duplicate inline command file name '${file.name}'.`,
      );
    }
    names.add(file.name);

    if (file.ext !== undefined && !EXT_RE.test(file.ext)) {
      throw new InlineCommandFileError(
        "invalid_ext",
        `Invalid inline command file extension '${file.ext}'. Use /^[A-Za-z0-9]{1,16}$/.`,
      );
    }

    totalBytes += Buffer.byteLength(file.content, "utf-8");
  }

  if (totalBytes > MAX_INLINE_COMMAND_FILE_BYTES) {
    throw new InlineCommandFileError(
      "size_limit_exceeded",
      `Inline command file content is limited to ${MAX_INLINE_COMMAND_FILE_BYTES} bytes total.`,
    );
  }

  const referenced = new Set<string>();
  for (const match of command.matchAll(INLINE_FILE_TOKEN_RE)) {
    referenced.add(match[1]);
  }

  if (referenced.size === 0) {
    throw new InlineCommandFileError(
      "unreferenced_file",
      "execute_command files were provided, but the command does not reference any $AL_FILE(name) tokens.",
    );
  }

  for (const ref of referenced) {
    if (!names.has(ref)) {
      throw new InlineCommandFileError(
        "unknown_reference",
        `Command references $AL_FILE(${ref}), but no inline command file named '${ref}' was provided.`,
      );
    }
  }

  for (const name of names) {
    if (!referenced.has(name)) {
      throw new InlineCommandFileError(
        "unreferenced_file",
        `Inline command file '${name}' is not referenced by the command.`,
      );
    }
  }

  assertNoInvalidInlineFileTokens(command);
}

export function assertNoInvalidInlineFileTokens(command: string): void {
  const leftover = command.match(/\$AL_FILE\([^)]*\)/);
  if (!leftover) return;
  if (!leftover[0].match(/^\$AL_FILE\([A-Za-z0-9_.-]+\)$/)) {
    throw new InlineCommandFileError(
      "unresolved_token",
      `Invalid inline command file token '${leftover[0]}'. Use $AL_FILE(name) with /^[A-Za-z0-9_.-]{1,64}$/.`,
    );
  }
}

export function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPreview(content: string, executable: boolean): string {
  if (executable) return content;
  const lines = content.split(/\r?\n/);
  const firstLines = lines.slice(0, 40).join("\n");
  return firstLines.length > 4096 ? firstLines.slice(0, 4096) : firstLines;
}

function shouldTruncatePreview(content: string, executable: boolean): boolean {
  if (executable) return false;
  const lines = content.split(/\r?\n/);
  return lines.length > 40 || content.length > 4096;
}
