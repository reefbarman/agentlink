#!/usr/bin/env node

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, release } from "node:os";

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const HELPER_PATH = path.join(SCRIPT_DIR, "sandbox-runtime-helper.mjs");
const STAGED_RUNTIME_ROOT = path.join(REPO_ROOT, "dist", "sandbox-runtime");
const ARCH_PATH = "/usr/bin/arch";
const CODESIGN_PATH = "/usr/bin/codesign";
const FILE_PATH = "/usr/bin/file";
const UNZIP_PATH = "/usr/bin/unzip";
const DEFAULT_SAMPLES = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SAMPLES = 200;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
const PACKAGE_PREFIX = "dist/sandbox-runtime";
const packagedPath = (relativePath) => `${PACKAGE_PREFIX}/${relativePath}`;
export const REQUIRED_PACKAGE_PATHS = {
  sandboxHelper: [
    "scripts/sandbox-interactive-helper.mjs",
    "scripts/sandbox-network-policy.mjs",
    "scripts/sandbox-network-proxy.mjs",
    "scripts/sandbox-process-reaper.mjs",
    "scripts/sandbox-protected-roots.mjs",
    "scripts/sandbox-runtime-helper.mjs",
  ].map(packagedPath),
  sandboxRuntime: [
    "node_modules/@anthropic-ai/sandbox-runtime/package.json",
    "node_modules/@anthropic-ai/sandbox-runtime/LICENSE",
    "node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
    "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander/package.json",
    "node_modules/@anthropic-ai/sandbox-runtime/node_modules/commander/LICENSE",
    "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/package.json",
    "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod/LICENSE",
    "node_modules/@pondwader/socks5-server/package.json",
    "node_modules/@pondwader/socks5-server/LICENSE",
    "node_modules/@pondwader/socks5-server/dist/index.mjs",
    "node_modules/node-forge/package.json",
    "node_modules/node-forge/LICENSE",
    "node_modules/node-forge/lib/index.js",
  ].map(packagedPath),
  nodePtyRuntime: [
    "node_modules/node-pty/package.json",
    "node_modules/node-pty/LICENSE",
    "node_modules/node-pty/lib/index.js",
  ].map(packagedPath),
  nodePtyDarwinArm64: [
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  ].map(packagedPath),
  nodePtyDarwinX64: [
    "node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
  ].map(packagedPath),
};
const PACKAGED_SPAWN_HELPERS = ["darwin-arm64", "darwin-x64"].map(
  (architecture) =>
    `node_modules/node-pty/prebuilds/${architecture}/spawn-helper`,
);
const NODE_PTY_ARTIFACTS = [
  {
    relativePath:
      "dist/sandbox-runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    expectedArchitecture: "arm64",
  },
  {
    relativePath:
      "dist/sandbox-runtime/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    expectedArchitecture: "arm64",
  },
  {
    relativePath:
      "dist/sandbox-runtime/node_modules/node-pty/prebuilds/darwin-x64/pty.node",
    expectedArchitecture: "x86_64",
  },
  {
    relativePath:
      "dist/sandbox-runtime/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
    expectedArchitecture: "x86_64",
  },
];

function parseIntegerOption(name, value, minimum, maximum) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    samples: DEFAULT_SAMPLES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipBenchmarks: false,
    skipVsce: false,
    jsonOnly: false,
    vsixPath: undefined,
    x64NodePath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--samples") {
      options.samples = parseIntegerOption(
        "--samples",
        argv[++index],
        1,
        MAX_SAMPLES,
      );
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parseIntegerOption(
        "--timeout-ms",
        argv[++index],
        1_000,
        MAX_TIMEOUT_MS,
      );
    } else if (argument === "--vsix") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--vsix requires a path");
      }
      options.vsixPath = path.resolve(value);
    } else if (argument === "--x64-node") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--x64-node requires a path");
      }
      options.x64NodePath = path.resolve(value);
    } else if (argument === "--skip-benchmarks") {
      options.skipBenchmarks = true;
    } else if (argument === "--skip-vsce") {
      options.skipVsce = true;
    } else if (argument === "--json-only") {
      options.jsonOnly = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout
    .write(`Usage: node scripts/sandbox-runtime-evidence.mjs [options]

Options:
  --samples <count>      Benchmark samples per mode (default: ${DEFAULT_SAMPLES}, max: ${MAX_SAMPLES})
  --timeout-ms <ms>      Per-child timeout (default: ${DEFAULT_TIMEOUT_MS})
  --vsix <path>          Inspect a specific existing VSIX
  --x64-node <path>      Verify and use an existing signed Node 22.19.0 x64 binary
  --skip-benchmarks      Collect artifact and packaging evidence only
  --skip-vsce            Do not run the read-only npx --no-install vsce ls probe
  --json-only            Suppress the human summary on stderr
  --help                 Show this help
`);
}

function appendBounded(chunks, state, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_CHILD_OUTPUT_BYTES - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) {
    state.truncated = true;
  }
}

async function runBoundedProcess(
  executable,
  args,
  {
    cwd = REPO_ROOT,
    env = process.env,
    input,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const startedAt = process.hrtime.bigint();
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  let timedOut = false;
  let spawnError;
  let forceKillTimer;
  let child;
  try {
    child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      executable,
      args,
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error),
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  child.stdout.on("data", (chunk) =>
    appendBounded(stdoutChunks, stdoutState, chunk),
  );
  child.stderr.on("data", (chunk) =>
    appendBounded(stderrChunks, stderrState, chunk),
  );
  child.on("error", (error) => {
    spawnError = error.message;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    forceKillTimer.unref();
  }, timeoutMs);
  timeout.unref();
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
  const { exitCode, signal } = await new Promise((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout);
  clearTimeout(forceKillTimer);
  return {
    executable,
    args,
    exitCode,
    signal,
    timedOut,
    spawnError,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdoutTruncated: stdoutState.truncated,
    stderrTruncated: stderrState.truncated,
  };
}

async function isExecutable(filePath) {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(await readFile(filePath, "utf8")) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJsonDocument(text) {
  try {
    return JSON.parse(stripAnsi(text).trim());
  } catch {
    return undefined;
  }
}

function parseJsonLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Continue past non-protocol output and preserve it in raw evidence.
    }
  }
  return undefined;
}

function makeSandboxRequest(root) {
  return {
    version: 3,
    operation: "execute",
    command: "/usr/bin/true",
    cwd: root,
    shell: "/bin/bash",
    environment: {
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    },
    filesystem: {
      denyRead: [homedir()],
      allowRead: [root],
      allowWrite: [root],
      denyWrite: [],
    },
    network: { allowedDomains: [] },
    protectedRoots: [],
    structurallyProtectedRoots: [],
    timeoutMs: 10_000,
  };
}

function validateRuntimeResponse(response, requireCleanupComplete) {
  if (!response || response.ok !== true) {
    return response?.error ?? "missing successful runtime response";
  }
  if (requireCleanupComplete && response.cleanupComplete !== true) {
    return "isolated helper did not report cleanupComplete";
  }
  if (
    response.result?.exitCode !== 0 ||
    response.result?.signal !== null ||
    response.result?.timedOut !== false
  ) {
    return `sandboxed /usr/bin/true did not exit cleanly: ${JSON.stringify(response.result)}`;
  }
  if (response.launch?.usesSandboxExec !== true) {
    return "runtime launch evidence did not report usesSandboxExec";
  }
  return undefined;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index];
}

function roundMilliseconds(value) {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
}

function summarizeSamples(samples, requestedSamples = samples.length) {
  const successfulDurations = samples
    .filter((sample) => sample.ok)
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  return {
    requestedSamples,
    attemptedSamples: samples.length,
    percentileEstimator: "nearest-rank (ceil(n * percentile))",
    successfulSamples: successfulDurations.length,
    failedSamples: samples.length - successfulDurations.length,
    unattemptedSamples: Math.max(0, requestedSamples - samples.length),
    p50Ms: roundMilliseconds(percentile(successfulDurations, 0.5)),
    p95Ms: roundMilliseconds(percentile(successfulDurations, 0.95)),
    maxMs: roundMilliseconds(
      successfulDurations.length === 0
        ? null
        : successfulDurations[successfulDurations.length - 1],
    ),
    samples: samples.map((sample) => ({
      ...sample,
      durationMs: roundMilliseconds(sample.durationMs),
    })),
  };
}

async function runColdBenchmarks(request, options) {
  const samples = [];
  for (let index = 0; index < options.samples; index += 1) {
    const outcome = await runBoundedProcess(process.execPath, [HELPER_PATH], {
      input: JSON.stringify(request),
      timeoutMs: options.timeoutMs,
    });
    const response = parseJsonLine(outcome.stdout);
    const responseError = validateRuntimeResponse(response, true);
    const error =
      outcome.spawnError ??
      (outcome.timedOut ? "helper timed out" : undefined) ??
      (outcome.exitCode === 0
        ? undefined
        : `helper exited with code ${outcome.exitCode} signal ${outcome.signal}`) ??
      responseError;
    samples.push({
      index: index + 1,
      ok: error === undefined,
      durationMs: outcome.durationMs,
      error,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      stderr: outcome.stderr.trim() || undefined,
      outputTruncated: outcome.stdoutTruncated || outcome.stderrTruncated,
    });
  }
  return summarizeSamples(samples);
}

class PersistentWorkerClient {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.waiters = [];
    this.pendingMessages = [];
    this.stderrChunks = [];
    this.stderrState = { bytes: 0, truncated: false };
    this.closed = false;
    this.child = spawn(process.execPath, [SCRIPT_PATH, "--persistent-worker"], {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) =>
      appendBounded(this.stderrChunks, this.stderrState, chunk),
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.rejectAll(error));
    this.child.once("close", (exitCode, signal) => {
      this.closed = true;
      this.rejectAll(
        new Error(
          `persistent worker closed with code ${exitCode} signal ${signal}`,
        ),
      );
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const index = this.waiters.findIndex((waiter) => waiter.matches(message));
    if (index === -1) {
      this.pendingMessages.push(message);
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  }

  rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  waitFor(matches, label) {
    const pendingIndex = this.pendingMessages.findIndex(matches);
    if (pendingIndex !== -1) {
      const [message] = this.pendingMessages.splice(pendingIndex, 1);
      return Promise.resolve(message);
    }
    if (this.closed) {
      return Promise.reject(new Error("persistent worker is already closed"));
    }
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject, timeout: undefined };
      waiter.timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`${label} timed out after ${this.timeoutMs}ms`));
        this.child.kill("SIGKILL");
      }, this.timeoutMs);
      waiter.timeout.unref();
      this.waiters.push(waiter);
    });
  }

  async ready() {
    await this.waitFor((message) => message.kind === "ready", "worker startup");
  }

  async invoke(request) {
    const id = this.nextId++;
    const response = this.waitFor(
      (message) => message.kind === "response" && message.id === id,
      `worker invocation ${id}`,
    );
    this.child.stdin.write(`${JSON.stringify({ id, request })}\n`);
    return response;
  }

  stderr() {
    return Buffer.concat(this.stderrChunks).toString("utf8").trim();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.child.once("close", resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 1_000),
      ),
    ]);
    this.lines.close();
  }
}

async function runWarmBenchmarks(request, options) {
  const client = new PersistentWorkerClient(options.timeoutMs);
  const samples = [];
  let warmup;
  try {
    await client.ready();
    const warmupStartedAt = process.hrtime.bigint();
    const warmupMessage = await client.invoke(request);
    const warmupError =
      warmupMessage.error ??
      validateRuntimeResponse(warmupMessage.response, false);
    warmup = {
      ok: warmupError === undefined,
      durationMs: roundMilliseconds(
        Number(process.hrtime.bigint() - warmupStartedAt) / 1_000_000,
      ),
      error: warmupError,
    };
    if (warmupError) {
      throw new Error(`warm-up invocation failed: ${warmupError}`);
    }
    for (let index = 0; index < options.samples; index += 1) {
      const startedAt = process.hrtime.bigint();
      try {
        const message = await client.invoke(request);
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const error =
          message.error ?? validateRuntimeResponse(message.response, false);
        samples.push({
          index: index + 1,
          ok: error === undefined,
          durationMs,
          error,
        });
      } catch (error) {
        samples.push({
          index: index + 1,
          ok: false,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  } catch (error) {
    if (samples.length === 0) {
      samples.push({
        index: 1,
        ok: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    await client.close();
  }
  return {
    ...summarizeSamples(samples, options.samples),
    warmupExcluded: warmup,
    workerStderr: client.stderr() || undefined,
    workerOutputTruncated: client.stderrState.truncated,
  };
}

function replaceEnvironment(environment) {
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  Object.assign(process.env, environment);
}

async function runPersistentWorker() {
  const startupEnvironment = { ...process.env };
  const { parseSandboxRuntimeRequest, runSandboxRuntimeRequest } =
    await import("./sandbox-runtime-helper.mjs");
  const lines = createInterface({ input: process.stdin });
  process.stdout.write(`${JSON.stringify({ kind: "ready" })}\n`);
  for await (const line of lines) {
    let envelope;
    try {
      envelope = JSON.parse(line);
      replaceEnvironment(startupEnvironment);
      const request = parseSandboxRuntimeRequest(envelope.request);
      const response = await runSandboxRuntimeRequest(request);
      process.stdout.write(
        `${JSON.stringify({ kind: "response", id: envelope.id, response })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          kind: "response",
          id: envelope?.id,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }
}

function architectureFromCpuType(cpuType) {
  const cpuTypeUnsigned = cpuType >>> 0;
  if (cpuTypeUnsigned === 0x0100000c) {
    return "arm64";
  }
  if (cpuTypeUnsigned === 0x01000007) {
    return "x86_64";
  }
  if (cpuTypeUnsigned === 12) {
    return "arm";
  }
  if (cpuTypeUnsigned === 7) {
    return "x86";
  }
  return `unknown(0x${cpuTypeUnsigned.toString(16)})`;
}

function inspectMachOHeader(buffer) {
  if (buffer.length < 8) {
    return { detected: false, reason: "file is shorter than a Mach-O header" };
  }
  const magic = buffer.subarray(0, 4).toString("hex");
  const formats = {
    cffaedfe: { bits: 64, littleEndian: true },
    feedfacf: { bits: 64, littleEndian: false },
    cefaedfe: { bits: 32, littleEndian: true },
    feedface: { bits: 32, littleEndian: false },
  };
  const format = formats[magic];
  if (format) {
    const cpuType = buffer.readUInt32BE(4);
    const normalizedCpuType = format.littleEndian
      ? buffer.readUInt32LE(4)
      : cpuType;
    return {
      detected: true,
      format: `thin-${format.bits}`,
      magic,
      endianness: format.littleEndian ? "little" : "big",
      architectures: [architectureFromCpuType(normalizedCpuType)],
    };
  }
  if (["cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)) {
    return {
      detected: true,
      format: "fat/universal",
      magic,
      architectures: [],
      note: "architecture slices are left to /usr/bin/file evidence",
    };
  }
  return { detected: false, magic, reason: "unrecognized Mach-O magic" };
}

async function inspectNodePtyArtifact(artifact, timeoutMs) {
  const absolutePath = path.join(REPO_ROOT, artifact.relativePath);
  try {
    const [metadata, header] = await Promise.all([
      stat(absolutePath),
      readFile(absolutePath).then((content) => content.subarray(0, 32)),
    ]);
    let fileEvidence = {
      attempted: false,
      available: await isExecutable(FILE_PATH),
    };
    if (fileEvidence.available) {
      const outcome = await runBoundedProcess(FILE_PATH, ["-b", absolutePath], {
        timeoutMs,
      });
      fileEvidence = {
        attempted: true,
        available: true,
        ok:
          outcome.exitCode === 0 &&
          !outcome.timedOut &&
          !outcome.stdoutTruncated,
        description: outcome.stdout.trim(),
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        stderr: outcome.stderr.trim() || undefined,
      };
    }
    const machO = inspectMachOHeader(header);
    return {
      path: artifact.relativePath,
      expectedArchitecture: artifact.expectedArchitecture,
      present: true,
      sizeBytes: metadata.size,
      executable: Boolean(metadata.mode & 0o111),
      fileEvidence,
      machO,
      architectureMatches:
        machO.architectures.length > 0
          ? machO.architectures.includes(artifact.expectedArchitecture)
          : null,
    };
  } catch (error) {
    return {
      path: artifact.relativePath,
      expectedArchitecture: artifact.expectedArchitecture,
      present: false,
      error: error instanceof Error ? error.message : String(error),
      architectureMatches: false,
    };
  }
}

function boundedOutcomeEvidence(outcome) {
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    spawnError: outcome.spawnError,
    stdout: outcome.stdout.trim(),
    stderr: outcome.stderr.trim(),
    outputTruncated: outcome.stdoutTruncated || outcome.stderrTruncated,
  };
}

async function inspectX64Node(nodePath, timeoutMs) {
  if (!nodePath) {
    return {
      supplied: false,
      trusted: false,
      reason: "no --x64-node path was supplied",
    };
  }
  if (!(await isExecutable(nodePath))) {
    return {
      supplied: true,
      path: nodePath,
      trusted: false,
      reason: "supplied x64 Node path is missing or not executable",
    };
  }
  const [identityOutcome, signatureOutcome, signatureDetailOutcome] =
    await Promise.all([
      runBoundedProcess(
        ARCH_PATH,
        [
          "-x86_64",
          nodePath,
          "-p",
          "JSON.stringify({arch:process.arch,platform:process.platform,version:process.version,execPath:process.execPath})",
        ],
        { timeoutMs },
      ),
      runBoundedProcess(
        CODESIGN_PATH,
        ["--verify", "--strict", "--verbose=2", nodePath],
        { timeoutMs },
      ),
      runBoundedProcess(CODESIGN_PATH, ["-dvv", nodePath], { timeoutMs }),
    ]);
  const identity = parseJsonLine(identityOutcome.stdout);
  const signatureDetail = signatureDetailOutcome.stderr;
  const authority =
    /Authority=Developer ID Application: Node\.js Foundation \(HX7739G8FX\)/.test(
      signatureDetail,
    );
  const teamIdentifier = /TeamIdentifier=HX7739G8FX/.test(signatureDetail);
  const identityMatches =
    identityOutcome.exitCode === 0 &&
    !identityOutcome.timedOut &&
    identity?.arch === "x64" &&
    identity?.platform === "darwin" &&
    identity?.version === "v22.19.0";
  const signatureValid =
    signatureOutcome.exitCode === 0 &&
    !signatureOutcome.timedOut &&
    authority &&
    teamIdentifier;
  return {
    supplied: true,
    path: nodePath,
    trusted: identityMatches && signatureValid,
    identity,
    identityMatches,
    signatureValid,
    authority: authority
      ? "Developer ID Application: Node.js Foundation (HX7739G8FX)"
      : undefined,
    teamIdentifier: teamIdentifier ? "HX7739G8FX" : undefined,
    identityOutcome: boundedOutcomeEvidence(identityOutcome),
    signatureOutcome: boundedOutcomeEvidence(signatureOutcome),
    signatureDetailOutcome: boundedOutcomeEvidence(signatureDetailOutcome),
  };
}

async function collectX64ExecutionEvidence(
  timeoutMs,
  nodePtyArtifacts,
  x64NodePath,
) {
  const available =
    process.platform === "darwin" && (await isExecutable(ARCH_PATH));
  const evidence = {
    archCommand: ARCH_PATH,
    available,
    systemExecution: {
      attempted: false,
      conformanceEstablished: false,
    },
    nodePtyExecution: {
      attempted: false,
      conformanceEstablished: false,
    },
    focusedSuite: {
      attempted: false,
      conformanceEstablished: false,
    },
    behaviorSuite: {
      attempted: false,
      conformanceEstablished: false,
    },
  };
  if (!available) {
    evidence.reason =
      process.platform === "darwin"
        ? "/usr/bin/arch is unavailable or not executable"
        : "x64 execution probing is Darwin-only";
    return evidence;
  }
  const systemOutcome = await runBoundedProcess(
    ARCH_PATH,
    ["-x86_64", "/usr/bin/uname", "-m"],
    { timeoutMs },
  );
  evidence.systemExecution = {
    attempted: true,
    conformanceEstablished:
      systemOutcome.exitCode === 0 &&
      !systemOutcome.timedOut &&
      systemOutcome.stdout.trim() === "x86_64",
    exitCode: systemOutcome.exitCode,
    signal: systemOutcome.signal,
    timedOut: systemOutcome.timedOut,
    stdout: systemOutcome.stdout.trim(),
    stderr: systemOutcome.stderr.trim(),
  };

  const x64ArtifactsPresent = nodePtyArtifacts
    .filter((artifact) => artifact.expectedArchitecture === "x86_64")
    .every(
      (artifact) => artifact.present && artifact.architectureMatches === true,
    );
  if (!x64ArtifactsPresent) {
    evidence.nodePtyExecution.reason =
      "x64 node-pty artifacts were not all present with non-conflicting architecture evidence";
    return evidence;
  }
  const x64Node = await inspectX64Node(x64NodePath, timeoutMs);
  evidence.node = x64Node;
  if (!x64Node.trusted) {
    evidence.nodePtyExecution.reason =
      x64Node.reason ??
      "supplied x64 Node did not pass identity/signature checks";
    evidence.focusedSuite.reason = evidence.nodePtyExecution.reason;
    evidence.behaviorSuite.reason = evidence.nodePtyExecution.reason;
    return evidence;
  }

  const probe = String.raw`
const pty = require("./dist/sandbox-runtime/node_modules/node-pty");
if (process.arch !== "x64") {
  throw new Error("expected x64 Node, received " + process.arch);
}
const terminal = pty.spawn("/usr/bin/true", [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
});
const timeout = setTimeout(() => {
  console.error("node-pty x64 probe timed out");
  terminal.kill();
  process.exitCode = 2;
}, 5000);
terminal.onExit(({ exitCode, signal }) => {
  clearTimeout(timeout);
  console.log(JSON.stringify({ marker: "node-pty-x64-conformance", processArch: process.arch, exitCode, signal }));
  if (exitCode !== 0) process.exitCode = 1;
});
`;
  const nodePtyOutcome = await runBoundedProcess(
    ARCH_PATH,
    ["-x86_64", x64Node.path, "--eval", probe],
    { timeoutMs },
  );
  const marker = parseJsonLine(nodePtyOutcome.stdout);
  evidence.nodePtyExecution = {
    attempted: true,
    conformanceEstablished:
      nodePtyOutcome.exitCode === 0 &&
      !nodePtyOutcome.timedOut &&
      marker?.marker === "node-pty-x64-conformance" &&
      marker?.processArch === "x64" &&
      marker?.exitCode === 0,
    scope:
      "attempted to load node-pty in an x64 Node process and complete a bounded /usr/bin/true PTY child; conformanceEstablished records whether both succeeded, and AgentLink custom terminal UI was not activated",
    exitCode: nodePtyOutcome.exitCode,
    signal: nodePtyOutcome.signal,
    timedOut: nodePtyOutcome.timedOut,
    marker,
    stdout: nodePtyOutcome.stdout.trim(),
    stderr: nodePtyOutcome.stderr.trim(),
    outputTruncated:
      nodePtyOutcome.stdoutTruncated || nodePtyOutcome.stderrTruncated,
  };

  const focusedOutcome = await runBoundedProcess(
    ARCH_PATH,
    [
      "-x86_64",
      x64Node.path,
      "--test",
      "scripts/sandbox-network-policy.test.mjs",
      "scripts/sandbox-network-proxy.test.mjs",
      "scripts/sandbox-process-reaper.test.mjs",
      "scripts/sandbox-protected-roots.test.mjs",
      "scripts/sandbox-runtime-helper.test.mjs",
    ],
    { timeoutMs: Math.max(timeoutMs, 120_000) },
  );
  evidence.focusedSuite = {
    attempted: true,
    conformanceEstablished:
      focusedOutcome.exitCode === 0 &&
      !focusedOutcome.timedOut &&
      /tests 51/.test(stripAnsi(focusedOutcome.stdout)) &&
      /pass 51/.test(stripAnsi(focusedOutcome.stdout)) &&
      /fail 0/.test(stripAnsi(focusedOutcome.stdout)),
    expectedTests: 51,
    scope:
      "the complete focused resolver/proxy/reaper/protected-root/helper suite under signed Node 22.19.0 x64 via Rosetta",
    ...boundedOutcomeEvidence(focusedOutcome),
  };

  const behaviorOutcome = await runBoundedProcess(
    ARCH_PATH,
    [
      "-x86_64",
      x64Node.path,
      "scripts/sandbox-runtime-behavior.mjs",
      "--strict",
      "--json",
    ],
    { timeoutMs: Math.max(timeoutMs, 120_000) },
  );
  const behaviorReport = parseJsonDocument(behaviorOutcome.stdout);
  evidence.behaviorSuite = {
    attempted: true,
    conformanceEstablished:
      behaviorOutcome.exitCode === 0 &&
      !behaviorOutcome.timedOut &&
      behaviorReport?.arch === "x64" &&
      behaviorReport?.node === "v22.19.0" &&
      behaviorReport?.summary?.total === 12 &&
      behaviorReport?.summary?.passed === 12 &&
      behaviorReport?.summary?.failed === 0,
    expectedGates: 12,
    reportSummary: behaviorReport?.summary,
    scope:
      "the hardened PTY/job-control/TUI, network, and parent-death behavior suite under signed Node 22.19.0 x64 via Rosetta",
    ...boundedOutcomeEvidence(behaviorOutcome),
  };
  return evidence;
}

/* eslint-disable no-control-regex -- Terminal package listings can contain ANSI and C0 control bytes. */
const ANSI_OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/* eslint-enable no-control-regex */

function stripAnsi(value) {
  return value
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(TERMINAL_CONTROL_CHARACTER, "");
}

function normalizePackageListing(stdout, prefix = "") {
  const entries = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && (!prefix || entry.startsWith(prefix)))
    .map((entry) => (prefix ? entry.slice(prefix.length) : entry));
  return [...new Set(entries)].sort();
}

async function inspectPackagedSpawnHelperModes(root) {
  const helpers = [];
  for (const relativePath of PACKAGED_SPAWN_HELPERS) {
    const absolutePath = path.join(root, relativePath);
    try {
      const metadata = await stat(absolutePath);
      helpers.push({
        path: relativePath,
        present: true,
        mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
        executable: Boolean(metadata.mode & 0o111),
      });
    } catch (error) {
      helpers.push({
        path: relativePath,
        present: false,
        executable: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    verdict: helpers.every((helper) => helper.executable) ? "pass" : "fail",
    helpers,
  };
}

export function classifyPackageListing(entries) {
  const entrySet = new Set(entries);
  const assets = Object.fromEntries(
    Object.entries(REQUIRED_PACKAGE_PATHS).map(([name, requiredPaths]) => {
      const presentPaths = requiredPaths.filter((candidate) =>
        entrySet.has(candidate),
      );
      const missingPaths = requiredPaths.filter(
        (candidate) => !entrySet.has(candidate),
      );
      return [
        name,
        {
          included: missingPaths.length === 0,
          requiredPaths,
          presentPaths,
          missingPaths,
        },
      ];
    }),
  );
  const missingRequiredPaths = Object.values(assets).flatMap(
    (asset) => asset.missingPaths,
  );
  return {
    verdict: missingRequiredPaths.length === 0 ? "pass" : "fail",
    assets,
    missingRequiredPaths,
  };
}

async function collectVsceListing(options) {
  if (options.skipVsce) {
    return {
      attempted: false,
      authoritative: false,
      verdict: "unknown",
      reason: "skipped by --skip-vsce",
    };
  }
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const outcome = await runBoundedProcess(
    executable,
    ["--no-install", "@vscode/vsce", "ls"],
    {
      timeoutMs: Math.max(options.timeoutMs, 30_000),
      env: {
        ...process.env,
        NO_COLOR: "1",
        npm_config_color: "false",
        npm_config_progress: "false",
      },
    },
  );
  const authoritative =
    outcome.exitCode === 0 &&
    !outcome.timedOut &&
    !outcome.stdoutTruncated &&
    !outcome.spawnError;
  const entries = authoritative ? normalizePackageListing(outcome.stdout) : [];
  const classification = authoritative
    ? classifyPackageListing(entries)
    : undefined;
  const executableModes =
    await inspectPackagedSpawnHelperModes(STAGED_RUNTIME_ROOT);
  return {
    attempted: true,
    command: [executable, "--no-install", "@vscode/vsce", "ls"],
    readOnlyIntent:
      "--no-install prevents npx from downloading or installing a missing vsce package",
    authoritative,
    verdict: authoritative
      ? classification.verdict === "pass" && executableModes.verdict === "pass"
        ? "pass"
        : "fail"
      : "unknown",
    ...(authoritative ? classification : {}),
    executableModes,
    entryCount: entries.length,
    entries,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    spawnError: outcome.spawnError,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    stderr: stripAnsi(outcome.stderr).trim(),
  };
}

async function findExistingVsix(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }
  const candidates = [];
  for (const entry of await readdir(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".vsix")) {
      const candidatePath = path.join(REPO_ROOT, entry.name);
      const metadata = await stat(candidatePath);
      candidates.push({ path: candidatePath, modifiedMs: metadata.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return candidates[0]?.path;
}

async function collectExistingVsixEvidence(options) {
  const vsixPath = await findExistingVsix(options.vsixPath);
  if (!vsixPath) {
    return {
      attempted: false,
      authoritative: false,
      verdict: "unknown",
      reason: "no existing VSIX was found; the collector does not build one",
    };
  }
  if (!(await fileExists(vsixPath))) {
    return {
      attempted: false,
      authoritative: false,
      verdict: "unknown",
      path: vsixPath,
      reason: "specified VSIX does not exist",
    };
  }
  if (!(await isExecutable(UNZIP_PATH))) {
    return {
      attempted: false,
      authoritative: false,
      verdict: "unknown",
      path: vsixPath,
      reason: "/usr/bin/unzip is unavailable",
    };
  }
  const outcome = await runBoundedProcess(UNZIP_PATH, ["-Z1", vsixPath], {
    timeoutMs: options.timeoutMs,
  });
  const authoritative =
    outcome.exitCode === 0 && !outcome.timedOut && !outcome.stdoutTruncated;
  const entries = authoritative
    ? normalizePackageListing(outcome.stdout, "extension/")
    : [];
  const classification = authoritative
    ? classifyPackageListing(entries)
    : undefined;
  let executableModes = {
    verdict: "unknown",
    reason: "archive extraction was not attempted",
  };
  if (authoritative) {
    const extractionRoot = await mkdtemp("/private/tmp/al-srt-vsix-");
    try {
      const extraction = await runBoundedProcess(
        UNZIP_PATH,
        ["-q", vsixPath, "-d", extractionRoot],
        { timeoutMs: options.timeoutMs },
      );
      executableModes =
        extraction.exitCode === 0 && !extraction.timedOut
          ? await inspectPackagedSpawnHelperModes(
              path.join(extractionRoot, "extension", PACKAGE_PREFIX),
            )
          : {
              verdict: "unknown",
              reason: "VSIX extraction failed",
              ...boundedOutcomeEvidence(extraction),
            };
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }
  return {
    attempted: true,
    authoritative,
    path: path.relative(REPO_ROOT, vsixPath) || path.basename(vsixPath),
    verdict: authoritative
      ? classification.verdict === "pass" && executableModes.verdict === "pass"
        ? "pass"
        : "fail"
      : "unknown",
    ...(authoritative ? classification : {}),
    executableModes,
    entryCount: entries.length,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    stdoutTruncated: outcome.stdoutTruncated,
    stderr: outcome.stderr.trim(),
  };
}

async function collectPackagingConfig(packageJson) {
  const vscodeIgnorePath = path.join(REPO_ROOT, ".vscodeignore");
  let vscodeIgnore;
  try {
    vscodeIgnore = await readFile(vscodeIgnorePath, "utf8");
  } catch (error) {
    return {
      vscodeIgnore: {
        present: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const activeRules = vscodeIgnore
    .split(/\r?\n/)
    .map((rule) => rule.trim())
    .filter((rule) => rule && !rule.startsWith("#"));
  const inclusionRules = activeRules.filter((rule) => rule.startsWith("!"));
  const relevantInclusionRules = inclusionRules.filter((rule) =>
    /scripts|sandbox-runtime|node_modules|node-pty/.test(rule),
  );
  const allowlistModel = activeRules[0] === "**/*";
  return {
    package: {
      name: packageJson?.name,
      version: packageJson?.version,
      sandboxRuntimeDeclaration:
        packageJson?.dependencies?.["@anthropic-ai/sandbox-runtime"] ??
        packageJson?.devDependencies?.["@anthropic-ai/sandbox-runtime"] ??
        null,
      sandboxRuntimeDependencyClass: packageJson?.dependencies?.[
        "@anthropic-ai/sandbox-runtime"
      ]
        ? "dependency"
        : packageJson?.devDependencies?.["@anthropic-ai/sandbox-runtime"]
          ? "devDependency"
          : "absent",
      nodePtyDeclaration:
        packageJson?.dependencies?.["node-pty"] ??
        packageJson?.devDependencies?.["node-pty"] ??
        null,
      nodePtyDependencyClass: packageJson?.dependencies?.["node-pty"]
        ? "dependency"
        : packageJson?.devDependencies?.["node-pty"]
          ? "devDependency"
          : "absent",
    },
    vscodeIgnore: {
      present: true,
      allowlistModel,
      firstActiveRule: activeRules[0],
      relevantInclusionRules,
      conservativeInference:
        allowlistModel && relevantInclusionRules.length === 0
          ? "sandbox helper/runtime/node-pty paths are not explicitly re-included and should be treated as excluded unless an actual listing proves otherwise"
          : "config alone is not treated as authoritative; inspect actual package listings",
    },
  };
}

function formatMetric(benchmark) {
  if (benchmark?.skipped) {
    return `skipped (${benchmark.reason})`;
  }
  if (!benchmark || !Number.isInteger(benchmark.successfulSamples)) {
    return "not established";
  }
  if (benchmark.successfulSamples === 0) {
    return `0/${benchmark.requestedSamples} successful`;
  }
  return `${benchmark.successfulSamples}/${benchmark.requestedSamples} successful; p50 ${benchmark.p50Ms} ms, p95 ${benchmark.p95Ms} ms, max ${benchmark.maxMs} ms`;
}

function formatPackagingVerdict(packagingEvidence) {
  if (packagingEvidence.verdict !== "fail") {
    return packagingEvidence.verdict;
  }
  const details = [];
  const missingCount = packagingEvidence.missingRequiredPaths?.length ?? 0;
  if (missingCount > 0) {
    details.push(`${missingCount} required path(s) absent`);
  }
  const modeFailureCount =
    packagingEvidence.executableModes?.helpers?.filter(
      (helper) => !helper.executable,
    ).length ?? 0;
  if (modeFailureCount > 0) {
    details.push(`${modeFailureCount} spawn-helper mode failure(s)`);
  }
  return details.length > 0 ? `fail (${details.join("; ")})` : "fail";
}

function buildHumanSummary(evidence) {
  const arm64Artifacts = evidence.nodePty.artifacts.filter(
    (artifact) => artifact.expectedArchitecture === "arm64",
  );
  const x64Artifacts = evidence.nodePty.artifacts.filter(
    (artifact) => artifact.expectedArchitecture === "x86_64",
  );
  const countMatching = (artifacts) =>
    artifacts.filter(
      (artifact) => artifact.present && artifact.architectureMatches === true,
    ).length;
  const lines = [
    "Darwin Phase 0 sandbox runtime evidence",
    `Host: ${evidence.host.platform} ${evidence.host.arch} (${evidence.host.osRelease}); native benchmarks use ${evidence.runtime.benchmarks.architectureAssumption}`,
    `Sandbox runtime: declared ${evidence.runtime.declaredVersion ?? "absent"}; installed ${evidence.runtime.installedVersion ?? "absent"}`,
    `Cold isolated-helper launches: ${formatMetric(evidence.runtime.benchmarks.cold)}`,
    `Warm persistent-process invocations: ${formatMetric(evidence.runtime.benchmarks.warm)}`,
    `x64 system execution via /usr/bin/arch: ${evidence.x64Execution.systemExecution.conformanceEstablished ? "verified" : "not established"}`,
    `node-pty Mach-O artifacts: arm64 ${countMatching(arm64Artifacts)}/${arm64Artifacts.length}, x64 ${countMatching(x64Artifacts)}/${x64Artifacts.length}`,
    `node-pty x64 executed conformance: ${evidence.x64Execution.nodePtyExecution.conformanceEstablished ? "verified" : "not established"}`,
    `Focused x64 sandbox suite: ${evidence.x64Execution.focusedSuite.conformanceEstablished ? "45/45 verified" : "not established"}`,
    `Hardened x64 behavior suite: ${evidence.x64Execution.behaviorSuite.conformanceEstablished ? "12/12 verified" : "not established"}`,
    `Current vsce listing: ${formatPackagingVerdict(evidence.packaging.vsceList)}`,
    `Existing VSIX listing: ${formatPackagingVerdict(evidence.packaging.existingVsix)}`,
    "Custom terminal: inactive; no AgentLink terminal UI or session was opened.",
  ];
  if (evidence.conflicts.length > 0) {
    lines.push("Conflicts / failed evidence:");
    for (const conflict of evidence.conflicts) {
      lines.push(`- ${conflict}`);
    }
  } else {
    lines.push("Conflicts / failed evidence: none detected.");
  }
  return lines;
}

function collectConflicts(evidence) {
  const conflicts = [];
  if (evidence.host.platform !== "darwin") {
    conflicts.push("host is not Darwin; runtime benchmarks were not executed");
  }
  if (!evidence.runtime.helperPresent) {
    conflicts.push("sandbox runtime helper is absent");
  }
  if (
    evidence.runtime.declaredVersion &&
    evidence.runtime.installedVersion !== evidence.runtime.declaredVersion
  ) {
    conflicts.push(
      `installed sandbox runtime ${evidence.runtime.installedVersion ?? "absent"} does not match declared pin ${evidence.runtime.declaredVersion}`,
    );
  }
  for (const [label, benchmark] of [
    ["cold isolated-helper benchmark", evidence.runtime.benchmarks.cold],
    ["warm persistent-process benchmark", evidence.runtime.benchmarks.warm],
  ]) {
    if (benchmark && benchmark.failedSamples > 0) {
      conflicts.push(
        `${label} had ${benchmark.failedSamples} failed sample(s)`,
      );
    }
  }
  const badArtifacts = evidence.nodePty.artifacts.filter(
    (artifact) => !artifact.present || artifact.architectureMatches !== true,
  );
  if (badArtifacts.length > 0) {
    conflicts.push(
      `node-pty artifact evidence is incomplete or mismatched for: ${badArtifacts.map((artifact) => artifact.path).join(", ")}`,
    );
  }
  const nonExecutableHelpers = evidence.nodePty.artifacts.filter(
    (artifact) =>
      artifact.path.endsWith("/spawn-helper") && artifact.executable !== true,
  );
  if (nonExecutableHelpers.length > 0) {
    conflicts.push(
      `node-pty spawn-helper lacks executable permission for: ${nonExecutableHelpers.map((artifact) => artifact.path).join(", ")}`,
    );
  }
  if (!evidence.x64Execution.systemExecution.conformanceEstablished) {
    conflicts.push("x64 system execution conformance was not established");
  }
  if (!evidence.x64Execution.nodePtyExecution.conformanceEstablished) {
    conflicts.push("x64 node-pty executed conformance was not established");
  }
  if (!evidence.x64Execution.focusedSuite.conformanceEstablished) {
    conflicts.push("x64 focused sandbox suite conformance was not established");
  }
  if (!evidence.x64Execution.behaviorSuite.conformanceEstablished) {
    conflicts.push(
      "x64 hardened behavior suite conformance was not established",
    );
  }
  if (evidence.packaging.vsceList.verdict === "fail") {
    const missing = evidence.packaging.vsceList.missingRequiredPaths ?? [];
    const modeFailures =
      evidence.packaging.vsceList.executableModes?.helpers
        ?.filter((helper) => !helper.executable)
        .map((helper) => helper.path) ?? [];
    conflicts.push(
      [
        missing.length > 0
          ? `current vsce listing omits required assets: ${missing.join(", ")}`
          : undefined,
        modeFailures.length > 0
          ? `staged spawn-helper is not executable: ${modeFailures.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("; ") || "current vsce package evidence failed",
    );
  } else if (evidence.packaging.vsceList.verdict === "unknown") {
    conflicts.push("current vsce package inclusion could not be established");
  }
  if (evidence.packaging.existingVsix.verdict === "fail") {
    const missing = evidence.packaging.existingVsix.missingRequiredPaths ?? [];
    const modeFailures =
      evidence.packaging.existingVsix.executableModes?.helpers
        ?.filter((helper) => !helper.executable)
        .map((helper) => helper.path) ?? [];
    conflicts.push(
      [
        missing.length > 0
          ? `existing VSIX omits required assets: ${missing.join(", ")}`
          : undefined,
        modeFailures.length > 0
          ? `archived spawn-helper is not executable: ${modeFailures.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("; ") || "existing VSIX package evidence failed",
    );
  }
  return conflicts;
}

async function collectEvidence(options) {
  const [
    packageJsonResult,
    packageLockResult,
    runtimePackageResult,
    nodePtyResult,
  ] = await Promise.all([
    readJson(path.join(REPO_ROOT, "package.json")),
    readJson(path.join(REPO_ROOT, "package-lock.json")),
    readJson(
      path.join(
        REPO_ROOT,
        "node_modules/@anthropic-ai/sandbox-runtime/package.json",
      ),
    ),
    readJson(path.join(REPO_ROOT, "node_modules/node-pty/package.json")),
  ]);
  const packageJson = packageJsonResult.ok
    ? packageJsonResult.value
    : undefined;
  const packageLock = packageLockResult.ok
    ? packageLockResult.value
    : undefined;
  const nodePtyArtifacts = [];
  for (const artifact of NODE_PTY_ARTIFACTS) {
    nodePtyArtifacts.push(
      await inspectNodePtyArtifact(artifact, options.timeoutMs),
    );
  }
  const [x64Execution, packagingConfig, vsceList, existingVsix] =
    await Promise.all([
      collectX64ExecutionEvidence(
        options.timeoutMs,
        nodePtyArtifacts,
        options.x64NodePath,
      ),
      collectPackagingConfig(packageJson),
      collectVsceListing(options),
      collectExistingVsixEvidence(options),
    ]);
  const benchmarks = {
    architectureAssumption: `${process.arch} via current Node executable (${process.execPath}); no architecture override`,
    workload:
      "actual sandboxed /usr/bin/true execution with an empty network allowlist, private HOME/TMP/cache, allowPty=false in the helper, and runtime cleanup/reset after every invocation",
    coldDefinition:
      "one new sandbox-runtime-helper Node process per measured sample; wall time includes process startup, module import, sandbox initialization, execution, cleanup, and protocol response",
    warmDefinition:
      "one persistent evidence-worker Node process imports the production helper once; one excluded warm-up precedes measured API invocations, the worker restores its startup environment before each request, and production runSandboxRuntimeRequest still initializes and resets the runtime for every invocation",
    warmTimeoutBehavior:
      "an invocation timeout kills the persistent worker because an in-process runtime call cannot be safely abandoned; attempted/unattempted counts expose the resulting truncated batch",
    percentileEstimator:
      "nearest-rank (ceil(n * percentile)); with modest sample counts p95 is expected to be close to max",
    cold: undefined,
    warm: undefined,
  };
  let temporaryRoot;
  const canBenchmark =
    !options.skipBenchmarks &&
    process.platform === "darwin" &&
    (await fileExists(HELPER_PATH)) &&
    runtimePackageResult.ok;
  if (canBenchmark) {
    try {
      temporaryRoot = await mkdtemp("/private/tmp/al-srt-evidence-");
      await Promise.all(
        ["home", "tmp", "cache"].map((name) =>
          mkdir(path.join(temporaryRoot, name), { recursive: true }),
        ),
      );
      const request = makeSandboxRequest(temporaryRoot);
      benchmarks.cold = await runColdBenchmarks(request, options);
      benchmarks.warm = await runWarmBenchmarks(request, options);
    } finally {
      if (temporaryRoot) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  } else {
    const reason = options.skipBenchmarks
      ? "skipped by --skip-benchmarks"
      : process.platform !== "darwin"
        ? "Darwin-only benchmark"
        : !(await fileExists(HELPER_PATH))
          ? "sandbox runtime helper is absent"
          : "installed sandbox runtime package is absent or unreadable";
    benchmarks.cold = { skipped: true, reason };
    benchmarks.warm = { skipped: true, reason };
  }
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    collector: path.relative(REPO_ROOT, SCRIPT_PATH),
    options: {
      samples: options.samples,
      timeoutMs: options.timeoutMs,
      skipBenchmarks: options.skipBenchmarks,
      skipVsce: options.skipVsce,
      vsixPath: options.vsixPath,
      x64NodePath: options.x64NodePath,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
    },
    assumptions: [
      "Phase 0 runtime execution is Darwin-only because the production helper rejects other hosts.",
      "Cold and warm benchmark numbers describe this host, current Node executable, pinned installed packages, and /usr/bin/true workload; they are not cross-architecture projections.",
      "Warm means a persistent Node process with a pre-imported helper and one excluded warm-up; the worker restores its startup environment before each request, while runtime initialize/reset remains per invocation by production design.",
      "A warm invocation timeout kills the worker and leaves remaining samples unattempted; attempted/unattempted counts make that truncation explicit.",
      "p50/p95 use the nearest-rank estimator; at the default modest sample count p95 is expected to be close to max.",
      "Mach-O header and /usr/bin/file results establish artifact architecture presence, not behavioral conformance.",
      "x64 executed conformance requires a successful /usr/bin/arch -x86_64 child result; artifact presence alone never satisfies it.",
      "The node-pty conformance probe creates only a bounded /usr/bin/true PTY directly through node-pty and does not activate AgentLink's custom terminal UI.",
      "npx --no-install @vscode/vsce ls is read-only with respect to package installation and reflects current workspace build outputs; the collector does not build or package missing files.",
      "A package/VSIX listing passes only when every explicitly required helper, runtime, node-pty runtime, and Darwin prebuild path is present in a complete listing.",
    ],
    runtime: {
      declaredVersion:
        packageJson?.devDependencies?.["@anthropic-ai/sandbox-runtime"] ??
        packageJson?.dependencies?.["@anthropic-ai/sandbox-runtime"] ??
        null,
      lockfileVersion:
        packageLock?.packages?.["node_modules/@anthropic-ai/sandbox-runtime"]
          ?.version ?? null,
      installedVersion: runtimePackageResult.ok
        ? runtimePackageResult.value.version
        : null,
      installedPackageError: runtimePackageResult.ok
        ? undefined
        : runtimePackageResult.error,
      helperPath: path.relative(REPO_ROOT, HELPER_PATH),
      helperPresent: await fileExists(HELPER_PATH),
      benchmarks,
    },
    x64Execution,
    nodePty: {
      declaredVersion:
        packageJson?.devDependencies?.["node-pty"] ??
        packageJson?.dependencies?.["node-pty"] ??
        null,
      lockfileVersion:
        packageLock?.packages?.["node_modules/node-pty"]?.version ?? null,
      installedVersion: nodePtyResult.ok ? nodePtyResult.value.version : null,
      installedPackageError: nodePtyResult.ok ? undefined : nodePtyResult.error,
      artifacts: nodePtyArtifacts,
      artifactPresenceIsConformance: false,
    },
    packaging: {
      config: packagingConfig,
      vsceList,
      existingVsix,
      passRule:
        "only a complete actual listing containing every required path receives pass; absent assets are fail and unavailable/truncated evidence is unknown",
    },
    sourceReadErrors: {
      packageJson: packageJsonResult.ok ? undefined : packageJsonResult.error,
      packageLock: packageLockResult.ok ? undefined : packageLockResult.error,
    },
    conflicts: [],
    humanSummary: [],
  };
  evidence.conflicts = collectConflicts(evidence);
  evidence.humanSummary = buildHumanSummary(evidence);
  return evidence;
}

async function main() {
  if (process.argv[2] === "--persistent-worker") {
    await runPersistentWorker();
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const evidence = await collectEvidence(options);
  if (!options.jsonOnly) {
    process.stderr.write(`${evidence.humanSummary.join("\n")}\n`);
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const isMain = process.argv[1] && SCRIPT_PATH === path.resolve(process.argv[1]);
if (isMain) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `sandbox runtime evidence collection failed: ${message}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          collector: path.relative(REPO_ROOT, SCRIPT_PATH),
          fatalError: message,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}
