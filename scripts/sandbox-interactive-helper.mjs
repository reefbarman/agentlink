import {
  bindProxyCredentialsToRuntimeDescriptor,
  buildSandboxEnvironment,
  isSandboxRuntimeDescriptor,
  parseSandboxRuntimeRequest,
} from "./sandbox-runtime-helper.mjs";
import {
  prepareProtectedRoots,
  revalidateProtectedRoots,
  validateStructurallyProtectedRoots,
} from "./sandbox-protected-roots.mjs";

import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { startTrustedNetworkProxies } from "./sandbox-network-proxy.mjs";

const PROTOCOL_VERSION = 2;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_DATA_BYTES = 256 * 1024;
const FORCE_KILL_DELAY_MS = 500;
const PUBLIC_NETWORK_ALLOWED_DOMAINS = Object.freeze(["*"]);
const IDENTITY_KEYS = ["type", "channelId", "commandId", "generation"];
const CONTROL_KEYS = {
  input: [...IDENTITY_KEYS, "data"],
  resize: [...IDENTITY_KEYS, "dimensions"],
  interrupt: IDENTITY_KEYS,
  terminate: IDENTITY_KEYS,
  "network-decision": [...IDENTITY_KEYS, "requestId", "decision"],
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isBoundedString(value, maxBytes = MAX_DATA_BYTES) {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isIdentity(value) {
  return (
    isPlainObject(value) &&
    isNonEmptyString(value.channelId) &&
    isNonEmptyString(value.commandId) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function isDimensions(value) {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["columns", "rows"]) &&
    Number.isSafeInteger(value.columns) &&
    value.columns > 0 &&
    Number.isSafeInteger(value.rows) &&
    value.rows > 0
  );
}

function isAbsolutePath(value) {
  return isNonEmptyString(value) && path.isAbsolute(value);
}

function isPathArray(value) {
  return Array.isArray(value) && value.every(isAbsolutePath);
}

function isEnvironment(value) {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && isBoundedString(entry),
    )
  );
}

function isFilesystem(value) {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["denyRead", "allowRead", "allowWrite", "denyWrite"]) &&
    isPathArray(value.denyRead) &&
    isPathArray(value.allowRead) &&
    isPathArray(value.allowWrite) &&
    isPathArray(value.denyWrite)
  );
}

function isNetwork(value) {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["mode"]) &&
    (value.mode === "blocked" || value.mode === "public-proxy")
  );
}

export function parseSandboxInteractiveControl(
  value,
  { requireLaunch = false } = {},
) {
  if (
    !isPlainObject(value) ||
    !isIdentity(value) ||
    typeof value.type !== "string"
  ) {
    throw new Error("invalid sandbox helper control frame");
  }
  if (value.type === "launch") {
    if (
      !hasExactKeys(value, [
        ...IDENTITY_KEYS,
        "version",
        "command",
        "cwd",
        "shell",
        "environment",
        "filesystem",
        "network",
        "protectedRoots",
        "structurallyProtectedRoots",
        "dimensions",
      ]) ||
      value.version !== PROTOCOL_VERSION ||
      !isBoundedString(value.command) ||
      value.command.length === 0 ||
      !isAbsolutePath(value.cwd) ||
      !isAbsolutePath(value.shell) ||
      !isEnvironment(value.environment) ||
      !isFilesystem(value.filesystem) ||
      !isNetwork(value.network) ||
      !isPathArray(value.protectedRoots) ||
      !isPathArray(value.structurallyProtectedRoots) ||
      !isDimensions(value.dimensions)
    ) {
      throw new Error("invalid sandbox helper launch frame");
    }
    return value;
  }
  if (requireLaunch) {
    throw new Error("first sandbox helper control frame must be launch");
  }
  if (
    !Object.hasOwn(CONTROL_KEYS, value.type) ||
    !hasExactKeys(value, CONTROL_KEYS[value.type])
  ) {
    throw new Error("invalid sandbox helper control frame");
  }
  if (value.type === "input" && !isBoundedString(value.data)) {
    throw new Error("invalid sandbox helper input frame");
  }
  if (value.type === "resize" && !isDimensions(value.dimensions)) {
    throw new Error("invalid sandbox helper resize frame");
  }
  if (
    value.type === "network-decision" &&
    (!isNonEmptyString(value.requestId) ||
      (value.decision !== "allow-once" && value.decision !== "reject"))
  ) {
    throw new Error("invalid sandbox helper network decision frame");
  }
  return value;
}

function identityOf(frame) {
  return {
    channelId: frame.channelId,
    commandId: frame.commandId,
    generation: frame.generation,
  };
}

function sameIdentity(left, right) {
  return (
    left.channelId === right.channelId &&
    left.commandId === right.commandId &&
    left.generation === right.generation
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function classifyViolation(line) {
  const operation = /network|socket|connect/i.test(line)
    ? "network-connect"
    : /file-write|file-write-create|file-write-data|file-write-unlink/i.test(
          line,
        )
      ? "file-write"
      : /file-read|file-map-executable/i.test(line)
        ? "file-read"
        : "process-control";
  return {
    operation,
    reason: "operation denied by the macOS sandbox policy",
    occurredAt: Date.now(),
  };
}

function splitData(data) {
  if (Buffer.byteLength(data, "utf8") <= MAX_DATA_BYTES) return [data];
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of data) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_DATA_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function signalProcessGroup(kill, pgid, signal, terminal) {
  try {
    kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        terminal.kill(signal);
      } catch {
        throw error;
      }
    }
  }
}

function replaceProcessEnvironment(environment) {
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  Object.assign(process.env, environment);
}

function managedNetworkProtocol(protocol) {
  if (protocol === "http:") return "http";
  if (protocol === "https:") return "https";
  if (protocol === "connect:" || protocol === "socks5:") return "tcp";
  throw new Error("unsupported managed network protocol");
}

function defaultDependencies() {
  return {
    platform: process.platform,
    realpath,
    prepareProtectedRoots,
    revalidateProtectedRoots,
    validateStructurallyProtectedRoots,
    startTrustedNetworkProxies,
    replaceProcessEnvironment,
    createNetworkRequestId: () => randomBytes(16).toString("hex"),
    kill: process.kill.bind(process),
    setTimeout,
    clearTimeout,
    async loadRuntime() {
      const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
      return SandboxManager;
    },
    async loadNodePty() {
      return import("node-pty");
    },
  };
}

export function createSandboxInteractiveHelper(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  let active;
  let inputBuffer = Buffer.alloc(0);
  let stopped = false;
  let processing = Promise.resolve();

  const writeFrame = (identity, frame) => {
    output.write(`${JSON.stringify({ ...identity, ...frame })}\n`);
  };

  const cancelPendingNetworkRequests = (session) => {
    for (const [requestId, pending] of session.pendingNetworkRequests) {
      session.pendingNetworkRequests.delete(requestId);
      pending.reject(new Error("managed network request was cancelled"));
    }
  };

  const cleanup = async (session) => {
    if (!session || session.cleanupStarted) return;
    session.cleanupStarted = true;
    if (session.forceKillTimer)
      dependencies.clearTimeout(session.forceKillTimer);
    cancelPendingNetworkRequests(session);
    let disposalError;
    for (const dispose of [
      () => session.dataSubscription?.dispose?.(),
      () => session.exitSubscription?.dispose?.(),
      () => session.violationSubscription?.(),
    ]) {
      try {
        dispose();
      } catch (error) {
        disposalError ??= error;
      }
    }
    try {
      try {
        session.runtime.cleanupAfterCommand();
      } finally {
        await session.runtime.reset();
      }
    } finally {
      await session.networkProxies?.close();
    }
    if (disposalError) throw disposalError;
  };

  const terminate = (session, signal = "SIGTERM") => {
    if (!session?.terminal || session.exited) return;
    signalProcessGroup(
      dependencies.kill,
      session.pgid,
      signal,
      session.terminal,
    );
    if (signal !== "SIGKILL" && !session.forceKillTimer) {
      session.forceKillTimer = dependencies.setTimeout(
        () =>
          signalProcessGroup(
            dependencies.kill,
            session.pgid,
            "SIGKILL",
            session.terminal,
          ),
        FORCE_KILL_DELAY_MS,
      );
      session.forceKillTimer.unref?.();
    }
  };

  const failActive = async (message) => {
    if (!active || active.failed || active.exited) return;
    active.failed = true;
    cancelPendingNetworkRequests(active);
    writeFrame(active.identity, { type: "error", message });
    terminate(active);
  };

  const launch = async (frame) => {
    if (active)
      throw new Error("sandbox helper accepts exactly one launch frame");
    if (dependencies.platform !== "darwin") {
      throw new Error(
        "the interactive sandbox helper supports local macOS only",
      );
    }
    const allowedDomains =
      frame.network.mode === "public-proxy"
        ? PUBLIC_NETWORK_ALLOWED_DOMAINS
        : [];
    const request = parseSandboxRuntimeRequest({
      version: frame.version,
      operation: "execute",
      command: frame.command,
      cwd: frame.cwd,
      shell: frame.shell,
      environment: frame.environment,
      filesystem: frame.filesystem,
      network: { allowedDomains },
      protectedRoots: frame.protectedRoots,
      structurallyProtectedRoots: frame.structurallyProtectedRoots,
    });
    const identity = identityOf(frame);
    const cwd = await dependencies.realpath(request.cwd);
    const environment = buildSandboxEnvironment(request.environment);
    dependencies.replaceProcessEnvironment(environment);
    const runtime = await dependencies.loadRuntime();
    let networkProxies;
    const session = {
      identity,
      runtime,
      networkProxies: undefined,
      pendingNetworkRequests: new Map(),
      terminal: undefined,
      pgid: undefined,
      ready: false,
      pendingData: [],
      pendingExit: undefined,
      interruptRequested: false,
      exited: false,
      failed: false,
      cleanupStarted: false,
      forceKillTimer: undefined,
    };
    networkProxies = await dependencies.startTrustedNetworkProxies(
      request.network.allowedDomains,
      {},
      {
        authorizeDestination: (destination, signal) => {
          if (frame.network.mode !== "public-proxy") {
            return Promise.resolve("reject");
          }
          return new Promise((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("managed network request was cancelled"));
              return;
            }
            let protocol;
            try {
              protocol = managedNetworkProtocol(destination?.protocol);
            } catch (error) {
              reject(error);
              return;
            }
            if (
              !isPlainObject(destination) ||
              !isNonEmptyString(destination.host) ||
              !Number.isSafeInteger(destination.port) ||
              destination.port < 1 ||
              destination.port > 65_535 ||
              !isNonEmptyString(destination.address) ||
              (destination.family !== 4 && destination.family !== 6) ||
              !Array.isArray(destination.answers) ||
              destination.answers.length === 0 ||
              !destination.answers.every(
                (answer) =>
                  isPlainObject(answer) &&
                  isNonEmptyString(answer.address) &&
                  (answer.family === 4 || answer.family === 6),
              )
            ) {
              reject(new Error("invalid managed network request"));
              return;
            }
            const requestId = dependencies.createNetworkRequestId();
            if (
              !isNonEmptyString(requestId) ||
              session.pendingNetworkRequests.has(requestId)
            ) {
              reject(
                new Error("invalid or duplicate managed network request ID"),
              );
              return;
            }
            const abort = () => {
              const pending = session.pendingNetworkRequests.get(requestId);
              if (!pending) return;
              session.pendingNetworkRequests.delete(requestId);
              pending.reject(
                new Error("managed network request was cancelled"),
              );
            };
            signal?.addEventListener("abort", abort, { once: true });
            session.pendingNetworkRequests.set(requestId, {
              resolve: (decision) => {
                signal?.removeEventListener("abort", abort);
                resolve(decision === "allow-once" ? "allow" : "reject");
              },
              reject: (error) => {
                signal?.removeEventListener("abort", abort);
                reject(error);
              },
            });
            writeFrame(identity, {
              type: "network-request",
              request: {
                requestId,
                host: destination.host,
                protocol,
                port: destination.port,
                address: destination.address,
                family: destination.family,
                dnsAnswers: destination.answers.map((answer) => ({
                  ...answer,
                })),
                destinationClass: "public",
              },
            });
          });
        },
      },
    );
    session.networkProxies = networkProxies;
    active = session;

    try {
      await runtime.initialize({
        network: {
          allowedDomains: request.network.allowedDomains,
          deniedDomains: [],
          strictAllowlist: true,
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
          allowMachLookup: [],
          httpProxyPort: networkProxies.httpPort,
          socksProxyPort: networkProxies.socksPort,
        },
        filesystem: {
          ...request.filesystem,
          denyWrite: [
            ...new Set([
              ...request.filesystem.denyWrite,
              ...request.protectedRoots,
              ...request.structurallyProtectedRoots,
            ]),
          ],
        },
        allowPty: true,
        allowAppleEvents: false,
        enableWeakerNetworkIsolation: false,
      });
      const descriptor = await runtime.wrapWithSandboxArgv(
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
      const authenticatedArgv = bindProxyCredentialsToRuntimeDescriptor(
        descriptor.argv,
        request,
        networkProxies,
      );
      const nodePty = await dependencies.loadNodePty();
      const protectedRoots = await dependencies.prepareProtectedRoots(
        request.protectedRoots,
      );
      await dependencies.revalidateProtectedRoots(protectedRoots);
      await dependencies.validateStructurallyProtectedRoots(
        request.structurallyProtectedRoots,
      );
      const terminal = nodePty.spawn(
        authenticatedArgv[0],
        authenticatedArgv.slice(1),
        {
          name: environment.TERM ?? "xterm-256color",
          cols: frame.dimensions.columns,
          rows: frame.dimensions.rows,
          cwd,
          env: environment,
          encoding: "utf8",
        },
      );
      if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 0) {
        throw new Error("node-pty returned an invalid process group leader");
      }
      session.terminal = terminal;
      session.pgid = terminal.pid;
      session.dataSubscription = terminal.onData((data) => {
        if (session.exited || session.failed) return;
        if (!session.ready) {
          session.pendingData.push(data);
          return;
        }
        for (const chunk of splitData(data)) {
          writeFrame(identity, { type: "data", data: chunk });
        }
      });
      const violationStore = runtime.getSandboxViolationStore?.();
      let violationCount = violationStore?.getCount?.() ?? 0;
      session.violationSubscription = violationStore?.subscribe?.(
        (violations) => {
          if (!session.ready || session.exited || session.failed) {
            violationCount = violations.length;
            return;
          }
          for (const violation of violations.slice(violationCount)) {
            writeFrame(identity, {
              type: "violation",
              violation: classifyViolation(String(violation.line ?? "")),
            });
          }
          violationCount = violations.length;
        },
      );
      const handleExit = (event) => {
        void (async () => {
          if (session.exited || session.failed) return;
          if (!session.ready) {
            session.pendingExit ??= event;
            return;
          }
          session.exited = true;
          if (session.forceKillTimer)
            dependencies.clearTimeout(session.forceKillTimer);
          const normalizedInterrupt =
            session.interruptRequested &&
            event.exitCode === 0 &&
            (event.signal === undefined ||
              event.signal === 0 ||
              event.signal === 2);
          writeFrame(identity, {
            type: "exit",
            ...(normalizedInterrupt
              ? { exitCode: 130 }
              : Number.isInteger(event.exitCode)
                ? { exitCode: event.exitCode }
                : {}),
            ...(normalizedInterrupt
              ? { signal: 2 }
              : Number.isInteger(event.signal)
                ? { signal: event.signal }
                : {}),
            timedOut: false,
          });
          await cleanup(session);
        })().catch((error) => errorOutput.write(`${errorMessage(error)}\n`));
      };
      session.exitSubscription = terminal.onExit(handleExit);
      writeFrame(identity, {
        type: "ready",
        pid: terminal.pid,
        pgid: terminal.pid,
        backend: "seatbelt",
      });
      session.ready = true;
      for (const data of session.pendingData.splice(0)) {
        for (const chunk of splitData(data)) {
          writeFrame(identity, { type: "data", data: chunk });
        }
      }
      if (session.pendingExit) handleExit(session.pendingExit);
    } catch (error) {
      writeFrame(identity, { type: "error", message: errorMessage(error) });
      await cleanup(session);
      active = undefined;
    }
  };

  const handleControl = async (value) => {
    let frame;
    try {
      frame = parseSandboxInteractiveControl(value, {
        requireLaunch: !active,
      });
    } catch (error) {
      if (!active && isIdentity(value)) {
        writeFrame(identityOf(value), {
          type: "error",
          message: errorMessage(error),
        });
        return;
      }
      throw error;
    }
    if (frame.type === "launch") {
      if (active) {
        await failActive("sandbox helper accepts exactly one launch frame");
        return;
      }
      try {
        await launch(frame);
      } catch (error) {
        writeFrame(identityOf(frame), {
          type: "error",
          message: errorMessage(error),
        });
      }
      return;
    }
    if (!sameIdentity(frame, active.identity)) {
      await failActive("sandbox helper rejected a stale command identity");
      return;
    }
    if (active.exited || active.failed) return;
    if (frame.type === "network-decision") {
      const pending = active.pendingNetworkRequests.get(frame.requestId);
      if (!pending) {
        await failActive(
          "sandbox helper rejected an unknown network request decision",
        );
        return;
      }
      active.pendingNetworkRequests.delete(frame.requestId);
      pending.resolve(frame.decision);
      return;
    }
    if (frame.type === "input") active.terminal.write(frame.data);
    else if (frame.type === "resize") {
      active.terminal.resize(frame.dimensions.columns, frame.dimensions.rows);
    } else if (frame.type === "interrupt") {
      signalProcessGroup(
        dependencies.kill,
        active.pgid,
        "SIGINT",
        active.terminal,
      );
      active.interruptRequested = true;
    } else if (frame.type === "terminate") terminate(active);
  };

  const protocolFailure = async (error) => {
    if (active) {
      await failActive(errorMessage(error));
    } else {
      errorOutput.write(`${errorMessage(error)}\n`);
      stopped = true;
      input.destroy?.();
    }
  };

  const consume = async (chunk) => {
    if (stopped) return;
    inputBuffer = Buffer.concat([
      inputBuffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    for (;;) {
      const newline = inputBuffer.indexOf(0x0a);
      if (newline === -1) {
        if (inputBuffer.length > MAX_FRAME_BYTES) {
          throw new Error("sandbox helper control frame exceeds maximum size");
        }
        return;
      }
      const line = inputBuffer.subarray(0, newline);
      inputBuffer = inputBuffer.subarray(newline + 1);
      if (line.length > MAX_FRAME_BYTES) {
        throw new Error("sandbox helper control frame exceeds maximum size");
      }
      let value;
      try {
        value = JSON.parse(new StringDecoder("utf8").end(line));
      } catch {
        throw new Error("sandbox helper received malformed JSON");
      }
      await handleControl(value);
    }
  };

  const onData = (chunk) => {
    processing = processing.then(() => consume(chunk)).catch(protocolFailure);
  };
  const onEnd = () => {
    processing = processing.then(async () => {
      if (inputBuffer.length > 0) {
        await protocolFailure(
          new Error("sandbox helper input closed with an incomplete frame"),
        );
      }
      if (active && !active.exited) terminate(active);
    });
  };
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onEnd);

  return {
    async close() {
      stopped = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      if (active && !active.exited) terminate(active, "SIGKILL");
      await cleanup(active);
      await processing;
    },
    get activeIdentity() {
      return active?.identity;
    },
  };
}

async function main() {
  const helper = createSandboxInteractiveHelper();
  const shutdown = () => void helper.close().finally(() => process.exit());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
