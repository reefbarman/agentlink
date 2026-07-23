import type {
  SandboxNetworkPolicy,
  SandboxViolation,
} from "../../core/sandboxPolicy.js";

import type { TerminalDimensions } from "../../core/terminalProtocol.js";

export const SANDBOX_HELPER_PROTOCOL_VERSION = 3;
export const MAX_SANDBOX_HELPER_FRAME_BYTES = 1024 * 1024;
export const MAX_SANDBOX_HELPER_DATA_BYTES = 256 * 1024;

export interface SandboxCommandIdentity {
  channelId: string;
  commandId: string;
  generation: number;
}

export type SandboxManagedNetworkProtocol = "http" | "https" | "tcp";

export interface SandboxManagedNetworkDestination {
  requestId: string;
  host: string;
  protocol: SandboxManagedNetworkProtocol;
  port: number;
  address: string;
  family: 4 | 6;
  dnsAnswers: Array<{ address: string; family: 4 | 6 }>;
  destinationClass: "public";
}

export interface SandboxHelperLaunchRequest extends SandboxCommandIdentity {
  version: typeof SANDBOX_HELPER_PROTOCOL_VERSION;
  type: "launch";
  command: string;
  cwd: string;
  shell: string;
  environment: Record<string, string>;
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: SandboxNetworkPolicy;
  protectedRoots: string[];
  structurallyProtectedRoots: string[];
  dimensions: TerminalDimensions;
}

export type SandboxHelperControlFrame =
  | SandboxHelperLaunchRequest
  | (SandboxCommandIdentity & { type: "input"; data: string })
  | (SandboxCommandIdentity & {
      type: "resize";
      dimensions: TerminalDimensions;
    })
  | (SandboxCommandIdentity & { type: "interrupt" })
  | (SandboxCommandIdentity & { type: "terminate" })
  | (SandboxCommandIdentity & {
      type: "network-decision";
      requestId: string;
      decision: "allow-once" | "reject";
    });

export type SandboxHelperEventFrame =
  | (SandboxCommandIdentity & {
      type: "ready";
      pid: number;
      pgid: number;
      backend: string;
      backendVersion?: string;
    })
  | (SandboxCommandIdentity & { type: "data"; data: string })
  | (SandboxCommandIdentity & {
      type: "cwd";
      cwd: string;
      nonce: string;
    })
  | (SandboxCommandIdentity & {
      type: "violation";
      violation: SandboxViolation;
    })
  | (SandboxCommandIdentity & {
      type: "network-request";
      request: SandboxManagedNetworkDestination;
    })
  | (SandboxCommandIdentity & {
      type: "exit";
      exitCode?: number;
      signal?: number;
      timedOut: boolean;
    })
  | (SandboxCommandIdentity & { type: "error"; message: string });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function isIdentity(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.channelId) &&
    isNonEmptyString(value.commandId) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0
  );
}

function isDimensions(value: unknown): value is TerminalDimensions {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["columns", "rows"]) &&
    Number.isSafeInteger(value.columns) &&
    (value.columns as number) > 0 &&
    Number.isSafeInteger(value.rows) &&
    (value.rows as number) > 0
  );
}

function isAbsolutePath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))
  );
}

function isStringArray(
  value: unknown,
  absolutePaths = false,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) =>
      absolutePaths ? isAbsolutePath(item) : isNonEmptyString(item),
    )
  );
}

function isEnvironment(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        isBoundedString(entry, MAX_SANDBOX_HELPER_DATA_BYTES),
    )
  );
}

function isFilesystem(
  value: unknown,
): value is SandboxHelperLaunchRequest["filesystem"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["denyRead", "allowRead", "allowWrite", "denyWrite"]) &&
    isStringArray(value.denyRead, true) &&
    isStringArray(value.allowRead, true) &&
    isStringArray(value.allowWrite, true) &&
    isStringArray(value.denyWrite, true)
  );
}

function isNetworkPolicy(value: unknown): value is SandboxNetworkPolicy {
  if (!isRecord(value) || typeof value.mode !== "string") return false;
  if (value.mode === "loopback" || value.mode === "public-proxy") {
    return (
      hasOnlyKeys(value, ["mode", "allowLocalBinding"]) &&
      (value.allowLocalBinding === undefined ||
        value.allowLocalBinding === true) &&
      value.allowedPrivateTargets === undefined
    );
  }
  return false;
}

function isManagedNetworkDestination(
  value: unknown,
): value is SandboxManagedNetworkDestination {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "host",
      "protocol",
      "port",
      "address",
      "family",
      "dnsAnswers",
      "destinationClass",
    ]) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.host) &&
    ["http", "https", "tcp"].includes(String(value.protocol)) &&
    Number.isSafeInteger(value.port) &&
    (value.port as number) >= 1 &&
    (value.port as number) <= 65_535 &&
    isNonEmptyString(value.address) &&
    (value.family === 4 || value.family === 6) &&
    Array.isArray(value.dnsAnswers) &&
    value.dnsAnswers.length > 0 &&
    value.dnsAnswers.every(
      (answer) =>
        isRecord(answer) &&
        hasOnlyKeys(answer, ["address", "family"]) &&
        isNonEmptyString(answer.address) &&
        (answer.family === 4 || answer.family === 6),
    ) &&
    value.destinationClass === "public"
  );
}

function isViolation(value: unknown): value is SandboxViolation {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["operation", "target", "reason", "occurredAt"]) &&
    [
      "file-read",
      "file-write",
      "network-connect",
      "ipc-connect",
      "process-control",
      "resource-limit",
    ].includes(String(value.operation)) &&
    (value.target === undefined || isNonEmptyString(value.target)) &&
    isNonEmptyString(value.reason) &&
    Number.isFinite(value.occurredAt)
  );
}

export function isSandboxHelperControlFrame(
  value: unknown,
): value is SandboxHelperControlFrame {
  if (
    !isRecord(value) ||
    !isIdentity(value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }

  const identityKeys = ["type", "channelId", "commandId", "generation"];
  if (value.type === "input") {
    return (
      hasOnlyKeys(value, [...identityKeys, "data"]) &&
      isBoundedString(value.data, MAX_SANDBOX_HELPER_DATA_BYTES)
    );
  }
  if (value.type === "resize") {
    return (
      hasOnlyKeys(value, [...identityKeys, "dimensions"]) &&
      isDimensions(value.dimensions)
    );
  }
  if (value.type === "interrupt" || value.type === "terminate") {
    return hasOnlyKeys(value, identityKeys);
  }
  if (value.type === "network-decision") {
    return (
      hasOnlyKeys(value, [...identityKeys, "requestId", "decision"]) &&
      isNonEmptyString(value.requestId) &&
      (value.decision === "allow-once" || value.decision === "reject")
    );
  }
  if (value.type !== "launch") return false;

  return (
    hasOnlyKeys(value, [
      ...identityKeys,
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
    ]) &&
    value.version === SANDBOX_HELPER_PROTOCOL_VERSION &&
    isBoundedString(value.command, MAX_SANDBOX_HELPER_DATA_BYTES) &&
    value.command.length > 0 &&
    isAbsolutePath(value.cwd) &&
    isAbsolutePath(value.shell) &&
    isEnvironment(value.environment) &&
    isFilesystem(value.filesystem) &&
    isNetworkPolicy(value.network) &&
    isStringArray(value.protectedRoots, true) &&
    isStringArray(value.structurallyProtectedRoots, true) &&
    isDimensions(value.dimensions)
  );
}

export function isSandboxHelperEventFrame(
  value: unknown,
): value is SandboxHelperEventFrame {
  if (
    !isRecord(value) ||
    !isIdentity(value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }

  const identityKeys = ["type", "channelId", "commandId", "generation"];
  if (value.type === "data") {
    return (
      hasOnlyKeys(value, [...identityKeys, "data"]) &&
      isBoundedString(value.data, MAX_SANDBOX_HELPER_DATA_BYTES)
    );
  }
  if (value.type === "cwd") {
    return (
      hasOnlyKeys(value, [...identityKeys, "cwd", "nonce"]) &&
      isAbsolutePath(value.cwd) &&
      isNonEmptyString(value.nonce)
    );
  }
  if (value.type === "violation") {
    return (
      hasOnlyKeys(value, [...identityKeys, "violation"]) &&
      isViolation(value.violation)
    );
  }
  if (value.type === "network-request") {
    return (
      hasOnlyKeys(value, [...identityKeys, "request"]) &&
      isManagedNetworkDestination(value.request)
    );
  }
  if (value.type === "error") {
    return (
      hasOnlyKeys(value, [...identityKeys, "message"]) &&
      isNonEmptyString(value.message)
    );
  }
  if (value.type === "ready") {
    return (
      hasOnlyKeys(value, [
        ...identityKeys,
        "pid",
        "pgid",
        "backend",
        "backendVersion",
      ]) &&
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      value.pgid === value.pid &&
      isNonEmptyString(value.backend) &&
      (value.backendVersion === undefined ||
        isNonEmptyString(value.backendVersion))
    );
  }
  if (value.type === "exit") {
    return (
      hasOnlyKeys(value, [...identityKeys, "exitCode", "signal", "timedOut"]) &&
      (value.exitCode === undefined || Number.isInteger(value.exitCode)) &&
      (value.signal === undefined || Number.isInteger(value.signal)) &&
      typeof value.timedOut === "boolean"
    );
  }
  return false;
}

export function encodeSandboxHelperFrame(
  frame: SandboxHelperControlFrame | SandboxHelperEventFrame,
): string {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (
    new TextEncoder().encode(encoded).byteLength >
    MAX_SANDBOX_HELPER_FRAME_BYTES
  ) {
    throw new Error("Sandbox helper frame exceeds maximum size");
  }
  return encoded;
}

export function parseSandboxHelperEventLine(
  line: string,
): SandboxHelperEventFrame {
  if (
    new TextEncoder().encode(line).byteLength > MAX_SANDBOX_HELPER_FRAME_BYTES
  ) {
    throw new Error("Sandbox helper event frame exceeds maximum size");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Sandbox helper emitted malformed JSON");
  }
  if (!isSandboxHelperEventFrame(value)) {
    throw new Error("Sandbox helper emitted an invalid event frame");
  }
  return value;
}
