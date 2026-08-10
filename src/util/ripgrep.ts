import * as childProcess from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";

const isWindows = process.platform.startsWith("win");
const binName = isWindows ? "rg.exe" : "rg";
const SYSTEM_RG_PROBE_TIMEOUT_MS = 2_000;

let cachedRgPath: string | undefined;

const MAX_RESULTS = 300;
const MAX_LINES = MAX_RESULTS * 5;
const MAX_LINE_LENGTH = 500;

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

// --- Ripgrep JSON output types ---

export interface RgBegin {
  type: "begin";
  data: { path: { text: string } };
}

export interface RgMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
  };
}

export interface RgContext {
  type: "context";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
}

export interface RgEnd {
  type: "end";
  data: { path: { text: string } };
}

export type RgMessage = RgBegin | RgMatch | RgContext | RgEnd;

// --- Search result types ---

export interface SearchLineResult {
  line: number;
  text: string;
  isMatch: boolean;
}

export interface SearchResult {
  lines: SearchLineResult[];
}

export interface SearchFileResult {
  file: string;
  searchResults: SearchResult[];
}

// --- Execution helpers ---

export function truncateLine(
  line: string,
  maxLength: number = MAX_LINE_LENGTH,
): string {
  return line.length > maxLength
    ? line.substring(0, maxLength) + " [truncated...]"
    : line;
}

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
}

export async function execRipgrepFiles(
  rgPath: string,
  args: string[],
  limit: number,
): Promise<RipgrepFilesResult> {
  return new Promise((resolve, reject) => {
    const rgProcess = childProcess.spawn(rgPath, args);
    const rl = readline.createInterface({
      input: rgProcess.stdout,
      crlfDelay: Infinity,
    });

    const files: string[] = [];

    rl.on("line", (line) => {
      if (files.length < limit) {
        files.push(line);
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
      const warnings = errorOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /file system loop/i.test(line));
      const nonLoopErrors = errorOutput
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/file system loop/i.test(line))
        .join("\n");
      if (nonLoopErrors && files.length === 0) {
        reject(new Error(`ripgrep error: ${nonLoopErrors}`));
      } else {
        resolve({ files, warnings });
      }
    });

    rgProcess.on("error", (error) => {
      reject(new Error(`ripgrep process error: ${error.message}`));
    });
  });
}

/**
 * Parse ripgrep --json output into structured search results.
 */
export function parseRipgrepOutput(
  output: string,
  _cwd: string,
): { results: SearchFileResult[]; totalMatches: number } {
  const results: SearchFileResult[] = [];
  let currentFile: SearchFileResult | null = null;
  let totalMatches = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as RgMessage;

      if (parsed.type === "begin") {
        currentFile = {
          file: parsed.data.path.text,
          searchResults: [],
        };
      } else if (parsed.type === "end") {
        if (currentFile) {
          results.push(currentFile);
          currentFile = null;
        }
      } else if (
        (parsed.type === "match" || parsed.type === "context") &&
        currentFile
      ) {
        if (parsed.type === "match") {
          totalMatches++;
        }

        const lineResult: SearchLineResult = {
          line: parsed.data.line_number,
          text: truncateLine(parsed.data.lines.text),
          isMatch: parsed.type === "match",
        };

        const lastResult =
          currentFile.searchResults[currentFile.searchResults.length - 1];
        if (lastResult?.lines.length > 0) {
          const lastLine = lastResult.lines[lastResult.lines.length - 1];
          // If contiguous with last result, add to it
          if (parsed.data.line_number <= lastLine.line + 1) {
            lastResult.lines.push(lineResult);
          } else {
            currentFile.searchResults.push({ lines: [lineResult] });
          }
        } else {
          currentFile.searchResults.push({ lines: [lineResult] });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return { results, totalMatches };
}
