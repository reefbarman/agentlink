import { lstat, readFile, realpath } from "node:fs/promises";

import type { TerminalExecuteOptions } from "../core/capabilities/terminal.js";
import { createHash } from "node:crypto";
import path from "node:path";

export interface VerifiedTerminalInlineFiles {
  readonly binding: Array<{ name: string; bytes: number; sha256: string }>;
  readonly canonicalPaths: string[];
}

export async function verifyTerminalInlineFiles(
  files: TerminalExecuteOptions["sandboxInlineFiles"],
  options: { requireCanonicalPaths?: boolean } = {},
): Promise<VerifiedTerminalInlineFiles> {
  const binding: Array<{ name: string; bytes: number; sha256: string }> = [];
  const canonicalPaths: string[] = [];
  const names = new Set<string>();
  for (const file of files ?? []) {
    if (names.has(file.name)) {
      throw new Error(`Duplicate inline file: ${file.name}`);
    }
    names.add(file.name);
    if (!path.isAbsolute(file.path) || file.path.includes("\0")) {
      throw new Error(
        `Inline file path must be absolute without NUL: ${file.name}`,
      );
    }
    const metadata = await lstat(file.path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Inline file must be a regular non-symlink file: ${file.name}`,
      );
    }
    const content = await readFile(file.path);
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== file.bytes || digest !== file.sha256) {
      throw new Error(
        `Inline file changed after materialization: ${file.name}`,
      );
    }
    const canonicalPath = await realpath(file.path);
    if (options.requireCanonicalPaths && canonicalPath !== file.path) {
      throw new Error(
        `Inline file path changed after materialization: ${file.name}`,
      );
    }
    binding.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
    canonicalPaths.push(canonicalPath);
  }
  return { binding, canonicalPaths };
}
