import { createHash, randomBytes } from "node:crypto";
import {
  prepareProtectedRoots,
  revalidateProtectedRoots,
  validateStructurallyProtectedRoots,
} from "./sandbox-protected-roots.mjs";

import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { startTrustedNetworkProxies } from "./sandbox-network-proxy.mjs";

const PROTOCOL_VERSION = 3;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CAPTURED_BYTES = 512 * 1024;
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_MACOS_UNIX_SOCKET_PATH_BYTES = 103;
const REAPER_PATH = fileURLToPath(
  new URL("./sandbox-process-reaper.mjs", import.meta.url),
);
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "version",
  "operation",
  "command",
  "cwd",
  "shell",
  "environment",
  "filesystem",
  "network",
  "protectedRoots",
  "structurallyProtectedRoots",
  "timeoutMs",
]);
const ALLOWED_FILESYSTEM_KEYS = new Set([
  "denyRead",
  "allowRead",
  "allowWrite",
  "denyWrite",
]);
const ALLOWED_NETWORK_KEYS = new Set(["allowedDomains", "allowLocalBinding"]);
const LOCAL_BIND_RULE = '(allow network-bind (local ip "*:*"))';
const LOCAL_INBOUND_RULE = '(allow network-inbound (local ip "*:*"))';
const LOOPBACK_OUTBOUND_RULE =
  '(allow network-outbound (remote ip "localhost:*"))';
const FORBIDDEN_ENV_NAMES = new Set([
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_OPTIONS",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "VSCODE_IPC_HOOK",
  "VSCODE_IPC_HOOK_CLI",
]);
const FORBIDDEN_ENV_PREFIXES = ["DYLD_", "LD_"];

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field: ${key}`);
    }
  }
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain null bytes`);
  }
  return value;
}

function assertAbsolutePath(value, label) {
  const candidate = assertString(value, label);
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(candidate);
}

function assertPathArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) =>
    assertAbsolutePath(entry, `${label}[${index}]`),
  );
}

function assertDomainArray(value) {
  if (!Array.isArray(value)) {
    throw new Error("network.allowedDomains must be an array");
  }
  return value.map((entry, index) => {
    const domain = assertString(entry, `network.allowedDomains[${index}]`);
    if (
      domain.includes("://") ||
      domain.includes("/") ||
      domain.includes("@") ||
      /\s/.test(domain)
    ) {
      throw new Error(
        `network.allowedDomains[${index}] is not a bare domain pattern`,
      );
    }
    return domain.toLowerCase();
  });
}

function assertEnvironment(value) {
  const environment = assertPlainObject(value, "environment");
  const result = {};
  for (const [name, rawValue] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`environment contains an invalid variable name: ${name}`);
    }
    if (
      FORBIDDEN_ENV_NAMES.has(name) ||
      FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(
        `environment variable is reserved by the sandbox helper: ${name}`,
      );
    }
    result[name] = assertString(rawValue, `environment.${name}`, {
      allowEmpty: true,
    });
  }
  for (const name of ["HOME", "TMPDIR"]) {
    result[name] = assertAbsolutePath(result[name], `environment.${name}`);
  }
  if (result.XDG_CACHE_HOME !== undefined) {
    result.XDG_CACHE_HOME = assertAbsolutePath(
      result.XDG_CACHE_HOME,
      "environment.XDG_CACHE_HOME",
    );
  }
  const probeSocket = path.join(result.TMPDIR, "srt-mux-9999999999-zzzz.sock");
  if (Buffer.byteLength(probeSocket) > MAX_MACOS_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `environment.TMPDIR is too long for macOS Unix sockets (${Buffer.byteLength(probeSocket)} > ${MAX_MACOS_UNIX_SOCKET_PATH_BYTES} bytes)`,
    );
  }
  return result;
}

function isWithinAnyRoot(candidate, roots) {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
}

export function parseSandboxRuntimeRequest(value) {
  const request = assertPlainObject(value, "request");
  assertKnownKeys(request, ALLOWED_TOP_LEVEL_KEYS, "request");
  if (request.version !== PROTOCOL_VERSION) {
    throw new Error(`request.version must be ${PROTOCOL_VERSION}`);
  }
  if (request.operation !== "describe" && request.operation !== "execute") {
    throw new Error('request.operation must be "describe" or "execute"');
  }

  const filesystem = assertPlainObject(request.filesystem, "filesystem");
  assertKnownKeys(filesystem, ALLOWED_FILESYSTEM_KEYS, "filesystem");
  const network = assertPlainObject(request.network, "network");
  assertKnownKeys(network, ALLOWED_NETWORK_KEYS, "network");

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `request.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }

  const environment = assertEnvironment(request.environment);
  const allowRead = assertPathArray(
    filesystem.allowRead,
    "filesystem.allowRead",
  );
  const allowWrite = assertPathArray(
    filesystem.allowWrite,
    "filesystem.allowWrite",
  );
  const denyWrite = assertPathArray(
    filesystem.denyWrite,
    "filesystem.denyWrite",
  );
  const protectedRoots = assertPathArray(
    request.protectedRoots ?? [],
    "request.protectedRoots",
  );
  const structurallyProtectedRoots = assertPathArray(
    request.structurallyProtectedRoots,
    "request.structurallyProtectedRoots",
  );
  for (const [label, roots] of [
    ["protected", protectedRoots],
    ["structurally protected", structurallyProtectedRoots],
  ]) {
    for (const protectedRoot of roots) {
      if (!isWithinAnyRoot(protectedRoot, denyWrite)) {
        throw new Error(
          `${label} root must be covered by filesystem.denyWrite: ${protectedRoot}`,
        );
      }
    }
  }
  if (!isWithinAnyRoot(environment.HOME, allowRead)) {
    throw new Error("environment.HOME must be within filesystem.allowRead");
  }
  for (const name of ["TMPDIR", "XDG_CACHE_HOME"]) {
    const candidate = environment[name];
    if (candidate !== undefined && !isWithinAnyRoot(candidate, allowWrite)) {
      throw new Error(
        `environment.${name} must be within filesystem.allowWrite`,
      );
    }
  }

  return {
    version: PROTOCOL_VERSION,
    operation: request.operation,
    command: assertString(request.command, "request.command"),
    cwd: assertAbsolutePath(request.cwd, "request.cwd"),
    shell: assertAbsolutePath(request.shell ?? "/bin/bash", "request.shell"),
    environment,
    filesystem: {
      denyRead: assertPathArray(filesystem.denyRead, "filesystem.denyRead"),
      allowRead,
      allowWrite,
      denyWrite,
    },
    network: {
      allowedDomains: assertDomainArray(network.allowedDomains),
      allowLocalBinding: network.allowLocalBinding === true,
    },
    protectedRoots,
    structurallyProtectedRoots,
    timeoutMs,
  };
}

export function buildSandboxEnvironment(environment) {
  const result = { ...environment };
  result.PATH ??= DEFAULT_PATH;
  result.LANG ??= "en_US.UTF-8";
  if (result.TMPDIR) {
    result.CLAUDE_CODE_TMPDIR = result.TMPDIR;
  }
  return result;
}

function quoteShellArgument(value) {
  if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function replaceExactCount(source, search, replacement, expectedCount, label) {
  const parts = source.split(search);
  const actualCount = parts.length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(
      `sandbox runtime proxy contract drifted for ${label}: expected ${expectedCount}, found ${actualCount}`,
    );
  }
  return parts.join(replacement);
}

export function constrainLoopbackRuntimeDescriptor(argv, request) {
  if (!isSandboxRuntimeDescriptor(argv, request)) {
    throw new Error(
      "cannot constrain an unexpected sandbox runtime descriptor",
    );
  }
  let wrapper = argv[2];
  for (const [rule, label] of [
    [LOCAL_BIND_RULE, "local bind"],
    [LOCAL_INBOUND_RULE, "local inbound"],
    [LOOPBACK_OUTBOUND_RULE, "loopback outbound"],
  ]) {
    const count = wrapper.split(rule).length - 1;
    if (count !== 1) {
      throw new Error(
        `sandbox runtime loopback contract drifted for ${label}: expected 1, found ${count}`,
      );
    }
  }
  if (!request.network.allowLocalBinding) {
    // Removing the exact rule text leaves only blank profile lines, which SBPL
    // ignores while preserving the surrounding shell/profile quoting.
    wrapper = replaceExactCount(wrapper, LOCAL_BIND_RULE, "", 1, "local bind");
    wrapper = replaceExactCount(
      wrapper,
      LOCAL_INBOUND_RULE,
      "",
      1,
      "local inbound",
    );
  }
  const constrained = [argv[0], argv[1], wrapper];
  if (!isSandboxRuntimeDescriptor(constrained, request)) {
    throw new Error("constrained sandbox runtime descriptor failed validation");
  }
  return constrained;
}

export function bindProxyCredentialsToRuntimeDescriptor(
  argv,
  request,
  networkProxies,
) {
  if (!isSandboxRuntimeDescriptor(argv, request)) {
    throw new Error(
      "cannot authenticate an unexpected sandbox runtime descriptor",
    );
  }
  const httpUrl = `http://localhost:${networkProxies.httpPort}`;
  const socksUrl = `socks5h://localhost:${networkProxies.socksPort}`;
  const httpUrlCount = argv[2].split(httpUrl).length - 1;
  const socksUrlCount = argv[2].split(socksUrl).length - 1;
  if (httpUrlCount === 0 && socksUrlCount === 0) {
    if (
      argv[2].includes(`localhost:${networkProxies.httpPort}`) ||
      argv[2].includes(`localhost:${networkProxies.socksPort}`)
    ) {
      throw new Error(
        "sandbox runtime proxy contract contains unexpected proxy credentials or URL syntax",
      );
    }
    return argv;
  }
  const { username, password } = networkProxies.credentials;
  if (
    !/^[A-Za-z0-9_-]{1,32}$/.test(username) ||
    !/^[a-f0-9]{64}$/.test(password)
  ) {
    throw new Error("network proxy returned invalid session credentials");
  }
  const authenticatedHttpUrl = `http://${username}:${password}@localhost:${networkProxies.httpPort}`;
  const authenticatedSocksUrl = `socks5h://${username}:${password}@localhost:${networkProxies.socksPort}`;
  let wrapper = argv[2];
  wrapper = replaceExactCount(
    wrapper,
    httpUrl,
    authenticatedHttpUrl,
    8,
    "HTTP proxy URLs",
  );
  wrapper = replaceExactCount(
    wrapper,
    socksUrl,
    authenticatedSocksUrl,
    4,
    "SOCKS proxy URLs",
  );
  const authenticated = [argv[0], argv[1], wrapper];
  if (!isSandboxRuntimeDescriptor(authenticated, request)) {
    throw new Error(
      "authenticated sandbox runtime descriptor failed validation",
    );
  }
  return authenticated;
}

export function isSandboxRuntimeDescriptor(argv, request) {
  if (
    argv.length !== 3 ||
    argv[0] !== request.shell ||
    argv[1] !== "-c" ||
    argv[2] === request.command
  ) {
    return false;
  }
  const wrapper = argv[2];
  const sandboxMarker = "/usr/bin/sandbox-exec -p ";
  const sandboxMarkerIndex = wrapper.indexOf(sandboxMarker);
  const commandSuffix = `${quoteShellArgument(request.shell)} -c ${quoteShellArgument(request.command)}`;
  const environmentPrefix = wrapper.slice(0, sandboxMarkerIndex);
  return (
    sandboxMarkerIndex > 0 &&
    environmentPrefix.startsWith("env ") &&
    !/[;&|`\n\r]/.test(environmentPrefix) &&
    wrapper.indexOf(sandboxMarker, sandboxMarkerIndex + 1) === -1 &&
    wrapper.endsWith(commandSuffix)
  );
}

export function describeLaunch(argv, environment, cwd) {
  const wrapper = argv.slice(1).join("\0");
  return {
    executable: argv[0],
    argumentCount: Math.max(0, argv.length - 1),
    cwd,
    shell: false,
    environmentKeys: Object.keys(environment).sort(),
    wrapperSha256: createHash("sha256").update(wrapper).digest("hex"),
    usesSandboxExec: true,
  };
}

function replaceProcessEnvironment(environment) {
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  Object.assign(process.env, environment);
}

async function readRequestFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return parseSandboxRuntimeRequest(JSON.parse(source));
}

function captureStream(stream) {
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;
  stream.on("data", (chunk) => {
    if (capturedBytes >= MAX_CAPTURED_BYTES) {
      truncated = true;
      return;
    }
    const remaining = MAX_CAPTURED_BYTES - capturedBytes;
    const captured = chunk.subarray(0, remaining);
    chunks.push(captured);
    capturedBytes += captured.length;
    truncated ||= captured.length < chunk.length;
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}

function writeReaperControl(reaper, token, signal = "SIGTERM") {
  if (!reaper.stdin.destroyed) {
    reaper.stdin.write(
      `${JSON.stringify({ operation: "terminate", signal, token })}\n`,
    );
  }
}

function collectReaperStatus(stream, token) {
  let buffer = "";
  let launched;
  let closed;
  let failure;
  const launchedPromise = new Promise((resolve, reject) => {
    launched = { resolve, reject };
  });
  const closedPromise = new Promise((resolve, reject) => {
    closed = { resolve, reject };
  });
  stream.setEncoding("utf8");
  stream.once("close", () => {
    failure ??= new Error("reaper status pipe closed unexpectedly");
    launched.reject(failure);
    closed.reject(failure);
  });
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let status;
      try {
        status = JSON.parse(line);
      } catch {
        failure ??= new Error("reaper returned malformed status JSON");
        launched.reject(failure);
        closed.reject(failure);
        continue;
      }
      if (status.token !== token) {
        failure ??= new Error("reaper returned an invalid launch token");
        launched.reject(failure);
        closed.reject(failure);
        continue;
      }
      if (status.kind === "launched") {
        if (
          !Number.isInteger(status.pid) ||
          status.pid <= 0 ||
          status.pgid !== status.pid
        ) {
          failure ??= new Error("reaper returned an invalid process group");
          launched.reject(failure);
          closed.reject(failure);
        } else {
          launched.resolve({ pid: status.pid, pgid: status.pgid });
        }
      } else if (status.kind === "closed") {
        closed.resolve({ exitCode: status.exitCode, signal: status.signal });
      } else if (status.kind === "error") {
        failure ??= new Error(
          `reaper failed: ${status.error ?? "unknown error"}`,
        );
        launched.reject(failure);
        closed.reject(failure);
      }
    }
  });
  return { launched: launchedPromise, closed: closedPromise };
}

async function executeLaunch(argv, environment, cwd, timeoutMs, beforeSpawn) {
  const startedAt = Date.now();
  await beforeSpawn();
  const token = randomBytes(32).toString("hex");
  const reaper = spawn(process.execPath, [REAPER_PATH], {
    cwd,
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const stdout = captureStream(reaper.stdout);
  const stderr = captureStream(reaper.stderr);
  const status = collectReaperStatus(reaper.stdio[3], token);
  const reaperError = new Promise((_, reject) => reaper.once("error", reject));
  const reaperClose = new Promise((resolve) =>
    reaper.once("close", (exitCode, signal) => resolve({ exitCode, signal })),
  );
  const reaperClosedBeforeLaunch = reaperClose.then(({ exitCode, signal }) => {
    throw new Error(
      `reaper exited before reporting launch: code=${exitCode} signal=${signal}`,
    );
  });
  reaper.stdin.write(`${JSON.stringify({ argv, cwd, environment, token })}\n`);
  await Promise.race([status.launched, reaperError, reaperClosedBeforeLaunch]);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    writeReaperControl(reaper, token);
  }, timeoutMs);
  timeout.unref();
  const forwardSignal = (signal) => writeReaperControl(reaper, token, signal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  try {
    const outcome = await Promise.race([status.closed, reaperError]);
    reaper.stdin.end();
    const reaperOutcome = await reaperClose;
    if (reaperOutcome.exitCode !== 0 || reaperOutcome.signal !== null) {
      throw new Error(
        `reaper exited unexpectedly: code=${reaperOutcome.exitCode} signal=${reaperOutcome.signal}`,
      );
    }
    return {
      ...outcome,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
    };
  } finally {
    writeReaperControl(reaper, token, "SIGKILL");
    reaper.stdin.end();
    clearTimeout(timeout);
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

export async function runSandboxRuntimeRequest(request) {
  if (process.platform !== "darwin") {
    throw new Error(
      "the sandbox runtime spike helper supports local macOS only",
    );
  }

  const cwd = await realpath(request.cwd);
  const environment = buildSandboxEnvironment(request.environment);
  replaceProcessEnvironment(environment);
  const protectedRoots = await prepareProtectedRoots(request.protectedRoots);

  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const networkProxies = await startTrustedNetworkProxies(
    request.network.allowedDomains,
  );
  const runtimeConfig = {
    network: {
      allowedDomains: request.network.allowedDomains,
      deniedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      // SRT emits loopback client and listener clauses as one option. AgentLink
      // constrains the generated descriptor below before adding proxy secrets.
      allowLocalBinding: true,
      allowMachLookup: [],
      httpProxyPort: networkProxies.httpPort,
      socksProxyPort: networkProxies.socksPort,
    },
    filesystem: {
      ...request.filesystem,
      denyWrite: [
        ...new Set([
          ...request.filesystem.denyWrite,
          ...protectedRoots.roots,
          ...request.structurallyProtectedRoots,
        ]),
      ],
    },
    allowPty: false,
    allowAppleEvents: false,
    enableWeakerNetworkIsolation: false,
  };

  try {
    await SandboxManager.initialize(runtimeConfig);
    const descriptor = await SandboxManager.wrapWithSandboxArgv(
      request.command,
      request.shell,
      undefined,
      undefined,
      cwd,
    );
    if (!isSandboxRuntimeDescriptor(descriptor.argv, request)) {
      throw new Error(
        "sandbox runtime returned an unexpected launch descriptor",
      );
    }
    const constrainedArgv = constrainLoopbackRuntimeDescriptor(
      descriptor.argv,
      request,
    );
    const authenticatedArgv = bindProxyCredentialsToRuntimeDescriptor(
      constrainedArgv,
      request,
      networkProxies,
    );
    const launch = describeLaunch(authenticatedArgv, environment, cwd);
    if (request.operation === "describe") {
      await revalidateProtectedRoots(protectedRoots);
      await validateStructurallyProtectedRoots(
        request.structurallyProtectedRoots,
      );
      return { ok: true, launch };
    }
    const result = await executeLaunch(
      authenticatedArgv,
      environment,
      cwd,
      request.timeoutMs,
      async () => {
        await revalidateProtectedRoots(protectedRoots);
        await validateStructurallyProtectedRoots(
          request.structurallyProtectedRoots,
        );
      },
    );
    return { ok: true, launch, result };
  } finally {
    try {
      try {
        SandboxManager.cleanupAfterCommand();
      } finally {
        await SandboxManager.reset();
      }
    } finally {
      await networkProxies.close();
    }
  }
}

async function main() {
  try {
    const request = await readRequestFromStdin();
    const response = await runSandboxRuntimeRequest(request);
    process.stdout.write(
      `${JSON.stringify({ ...response, cleanupComplete: true })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  await main();
}
