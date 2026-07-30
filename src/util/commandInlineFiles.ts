import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  scanShellLexLiteralOccurrences,
  type ShellLexLiteralOccurrence,
} from "./shellLex.js";

export const INLINE_FILE_TOKEN_RE = /\$AL_FILE\(([A-Za-z0-9_.-]+)\)/g;
const INLINE_FILE_TOKEN_PREFIX = "$AL_FILE(";
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
  | "duplicate_filename"
  | "unknown_reference"
  | "unreferenced_file"
  | "unresolved_token"
  | "unsupported_context"
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

interface InlineFileTokenOccurrence extends ShellLexLiteralOccurrence {
  name: string;
}

function scanInlineFileTokens(command: string): InlineFileTokenOccurrence[] {
  const scan = scanShellLexLiteralOccurrences(
    command,
    INLINE_FILE_TOKEN_PREFIX,
  );
  if (scan.occurrences.length > 0 && scan.unsupportedSyntax.length > 0) {
    const kinds = [...new Set(scan.unsupportedSyntax.map(({ kind }) => kind))];
    throw new InlineCommandFileError(
      "unsupported_context",
      `Inline command files do not support ${kinds.join(", ")} in the same command. Use a simpler direct command.`,
    );
  }

  if (
    scan.occurrences.length > 0 &&
    (scan.finalState.quote !== null || scan.finalState.danglingEscape)
  ) {
    throw new InlineCommandFileError(
      "unsupported_context",
      "Inline command file tokens require balanced shell quotes and no dangling trailing escape.",
    );
  }

  const occurrences: InlineFileTokenOccurrence[] = [];
  for (const occurrence of scan.occurrences) {
    if (occurrence.escaped || occurrence.comment) {
      throw new InlineCommandFileError(
        "unsupported_context",
        occurrence.escaped
          ? "Inline command file tokens cannot be shell-escaped. Use an unquoted, single-quoted, or double-quoted $AL_FILE(name) token."
          : "Inline command file tokens cannot appear in shell comments.",
      );
    }
    const close = command.indexOf(")", occurrence.end);
    if (close < 0) {
      throw new InlineCommandFileError(
        "unresolved_token",
        `Invalid inline command file token starting at '${command.slice(occurrence.start)}'. Use $AL_FILE(name) with /^[A-Za-z0-9_.-]{1,64}$/.`,
      );
    }
    const name = command.slice(occurrence.end, close);
    const token = command.slice(occurrence.start, close + 1);
    if (!NAME_RE.test(name) || name.includes("..")) {
      throw new InlineCommandFileError(
        "unresolved_token",
        `Invalid inline command file token '${token}'. Use $AL_FILE(name) with /^[A-Za-z0-9_.-]{1,64}$/.`,
      );
    }
    occurrences.push({ ...occurrence, end: close + 1, name });
  }

  return occurrences;
}

export function materializeInlineCommandFiles(
  command: string,
  files: InlineCommandFileInput[] | undefined,
): MaterializedInlineCommandFiles | undefined {
  if (!files || files.length === 0) return undefined;
  const occurrences = validateInlineCommandFilesAndGetOccurrences(
    command,
    files,
  );

  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cmd-")),
  );
  let cleaned = false;

  try {
    const previews: InlineCommandFilePreview[] = [];
    const pathByName = new Map<string, string>();

    for (const file of files) {
      const ext = normalizedExtension(file.name, file.ext);
      const filename = `${file.name}${ext ? `.${ext}` : ""}`;
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
        ext,
        bytes,
        sha256,
        truncated: shouldTruncatePreview(file.content, file.mode === "755"),
        executable: file.mode === "755",
        preview: buildPreview(file.content, file.mode === "755"),
      });
    }

    const substitutedParts: string[] = [];
    let sourceOffset = 0;
    for (const occurrence of occurrences) {
      const source = command.slice(sourceOffset, occurrence.start);
      if (source.includes(INLINE_FILE_TOKEN_PREFIX)) {
        throw new InlineCommandFileError(
          "unresolved_token",
          "Command contains an unresolved $AL_FILE(name) token before substitution.",
        );
      }
      substitutedParts.push(source);

      const filePath = pathByName.get(occurrence.name);
      if (!filePath) {
        throw new InlineCommandFileError(
          "unknown_reference",
          `No inline command file named '${occurrence.name}' was provided.`,
        );
      }
      const quotedPath = quotePosixShellArg(filePath);
      substitutedParts.push(
        occurrence.quote
          ? `${occurrence.quote === "single" ? "'" : '"'}${quotedPath}${occurrence.quote === "single" ? "'" : '"'}`
          : quotedPath,
      );
      sourceOffset = occurrence.end;
    }
    const sourceTail = command.slice(sourceOffset);
    if (sourceTail.includes(INLINE_FILE_TOKEN_PREFIX)) {
      throw new InlineCommandFileError(
        "unresolved_token",
        "Command contains an unresolved $AL_FILE(name) token after substitution.",
      );
    }
    substitutedParts.push(sourceTail);
    const substituted = substitutedParts.join("");

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

function validateInlineCommandFilesAndGetOccurrences(
  command: string,
  files: InlineCommandFileInput[],
): InlineFileTokenOccurrence[] {
  if (files.length > MAX_INLINE_COMMAND_FILES) {
    throw new InlineCommandFileError(
      "too_many_files",
      `execute_command files is limited to ${MAX_INLINE_COMMAND_FILES} entries.`,
    );
  }

  const names = new Set<string>();
  const filenames = new Set<string>();
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

    const ext = normalizedExtension(file.name, file.ext);
    const filename = `${file.name}${ext ? `.${ext}` : ""}`;
    const filenameKey = filename.toLowerCase();
    if (filenames.has(filenameKey)) {
      throw new InlineCommandFileError(
        "duplicate_filename",
        `Inline command files resolve to the same temp filename '${filename}'. Use distinct names or extensions.`,
      );
    }
    filenames.add(filenameKey);

    totalBytes += Buffer.byteLength(file.content, "utf-8");
  }

  if (totalBytes > MAX_INLINE_COMMAND_FILE_BYTES) {
    throw new InlineCommandFileError(
      "size_limit_exceeded",
      `Inline command file content is limited to ${MAX_INLINE_COMMAND_FILE_BYTES} bytes total.`,
    );
  }

  const occurrences = scanInlineFileTokens(command);
  const referenced = new Set(occurrences.map(({ name }) => name));

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

  return occurrences;
}

export function validateInlineCommandFiles(
  command: string,
  files: InlineCommandFileInput[],
): void {
  validateInlineCommandFilesAndGetOccurrences(command, files);
}

export function assertNoInvalidInlineFileTokens(command: string): void {
  scanInlineFileTokens(command);
}

export function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizedExtension(
  name: string,
  ext: string | undefined,
): string | undefined {
  if (!ext || name.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
    return undefined;
  return ext;
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
