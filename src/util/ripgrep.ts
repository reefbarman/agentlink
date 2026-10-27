import * as childProcess from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { SEARCH_FILES_MAX_OUTPUT_LINES } from "@agentlink/core/search-files";

export {
  parseRipgrepOutput,
  truncateLine,
  type RgBegin,
  type RgContext,
  type RgEnd,
  type RgMatch,
  type RgMessage,
  type SearchFileResult,
  type SearchLineResult,
  type SearchResult,
} from "@agentlink/core/search-files";

const isWindows = process.platform.startsWith("win");
const binName = isWindows ? "rg.exe" : "rg";
const SYSTEM_RG_PROBE_TIMEOUT_MS = 2_000;

let cachedRgPath: string | undefined;

const MAX_LINES = SEARCH_FILES_MAX_OUTPUT_LINES;

// --- Binary discovery ---

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function getBundledRipgrepCandidates(appRoot: string): string[] {
  const universalBinDir = `${process.platform}-${process.arch}`;

  return [
    path.join(
      appRoot,
      "node_modules.asar.unpacked/@vscode/ripgrep-universal/bin",
      universalBinDir,
      binName,
    ),
    path.join(
      appRoot,
      "node_modules/@vscode/ripgrep-universal/bin",
      universalBinDir,
      binName,
    ),
    path.join(appRoot, "node_modules/@vscode/ripgrep/bin/", binName),
    path.join(appRoot, "node_modules/vscode-ripgrep/bin/", binName),
    path.join(
      appRoot,
      "node_modules.asar.unpacked/vscode-ripgrep/bin/",
      binName,
    ),
    path.join(
      appRoot,
      "node_modules.asar.unpacked/@vscode/ripgrep/bin/",
      binName,
    ),
  ];
}

async function canExecuteSystemRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    childProcess.execFile(
      binName,
      ["--version"],
      { timeout: SYSTEM_RG_PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resolve(!error && /^ripgrep\s+\d/i.test(stdout.trim()));
      },
    );
  });
}

export async function getRipgrepBinPath(): Promise<string> {
  if (cachedRgPath) return cachedRgPath;

  const candidates = getBundledRipgrepCandidates(vscode.env.appRoot);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      cachedRgPath = candidate;
      return candidate;
    }
  }

  if (await canExecuteSystemRipgrep()) {
    cachedRgPath = binName;
    return binName;
  }

  throw new Error(
    "Could not find a usable ripgrep binary in the VS Code installation or on PATH",
  );
}

// --- Execution helpers ---

/**
 * Execute ripgrep with --json output and parse results into structured data.
 */
export async function execRipgrepSearch(
  rgPath: string,
  args: string[],
  options?: { cwd?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const rgProcess = childProcess.spawn(rgPath, args, {
      cwd: options?.cwd,
    });
    const rl = readline.createInterface({
      input: rgProcess.stdout,
      crlfDelay: Infinity,
    });

    let output = "";
    let lineCount = 0;

    rl.on("line", (line) => {
      if (lineCount < MAX_LINES) {
        output += line + "\n";
        lineCount++;
      } else {
        rl.close();
        rgProcess.kill();
      }
    });

    let errorOutput = "";
    rgProcess.stderr.on("data", (data: Buffer) => {
      errorOutput += data.toString();
    });

    rl.on("close", () => {
      // Ripgrep returns exit code 1 when no matches found — that's not an error
      if (errorOutput && output.length === 0) {
        reject(new Error(`ripgrep error: ${errorOutput}`));
      } else {
        resolve(output);
      }
    });

    rgProcess.on("error", (error) => {
      reject(new Error(`ripgrep process error: ${error.message}`));
    });
  });
}

/**
 * Execute ripgrep in --files mode, collecting up to `limit` file paths.
 */
export interface RipgrepFilesResult {
  files: string[];
  warnings: string[];
  exitCode: number | null;
  truncated: boolean;
}

export async function execRipgrepFiles(
  rgPath: string,
  args: string[],
  limit: number,
  options: { cwd?: string } = {},
): Promise<RipgrepFilesResult> {
  return new Promise((resolve, reject) => {
    const rgProcess = childProcess.spawn(rgPath, args, options);
    const rl = readline.createInterface({
      input: rgProcess.stdout,
      crlfDelay: Infinity,
    });

    const files: string[] = [];
    let truncated = false;
    let settled = false;

    rl.on("line", (line) => {
      if (files.length < limit) {
        files.push(line);
        return;
      }
      if (!truncated) {
        truncated = true;
        rgProcess.kill();
      }
    });

    let errorOutput = "";
    let errorOutputTruncated = false;
    rgProcess.stderr.on("data", (data: Buffer) => {
      const combined = errorOutput + data.toString();
      errorOutputTruncated ||= combined.length > 16_384;
      errorOutput = combined.slice(0, 16_384);
    });

    rgProcess.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      rl.close();
      const allWarnings = Array.from(
        new Set(
          errorOutput
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      );
      const warnings = allWarnings.slice(0, 20);
      const traversalWarningsOnly =
        exitCode === 2 &&
        !errorOutputTruncated &&
        allWarnings.length > 0 &&
        allWarnings.every(
          (warning) =>
            /^rg: .+: .+ \(os error \d+\)$/.test(warning) ||
            /^rg: .+: (?:No such file or directory|Permission denied|Operation not permitted|Too many levels of symbolic links)$/.test(
              warning,
            ) ||
            /^(?:rg: )?File system loop found: /.test(warning),
        );
      if (
        files.length === 0 &&
        !truncated &&
        !traversalWarningsOnly &&
        (warnings.length > 0 || (exitCode !== 0 && exitCode !== 1))
      ) {
        reject(
          new Error(
            `ripgrep error: ${warnings.join("\n") || `exit code ${exitCode}`}`,
          ),
        );
        return;
      }
      resolve({ files, warnings, exitCode, truncated });
    });

    rgProcess.on("error", (error) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(new Error(`ripgrep process error: ${error.message}`));
    });
  });
}
