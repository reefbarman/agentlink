import { randomUUID } from "node:crypto";

export const SANDBOX_BEHAVIOR_ATTESTATION_VERSION = "sandbox-behavior-v1";
export const DEFAULT_SANDBOX_BEHAVIOR_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_SANDBOX_BEHAVIOR_PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

const MAX_PROBE_TIMEOUT_MS = 60_000;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

export type SandboxBehaviorAttestationFailureCode =
  | "runtime_unavailable"
  | "helper_protocol_failed"
  | "filesystem_confinement_failed"
  | "protected_metadata_failed"
  | "process_inheritance_failed"
  | "private_environment_failed"
  | "network_block_failed"
  | "denial_evidence_failed"
  | "cleanup_failed"
  | "probe_timeout"
  | "probe_output_limit"
  | "probe_cancelled"
  | "service_disposed";

export interface SandboxBehaviorHelperLifecycleCheckResult {
  productionHelperLaunched: boolean;
  protocolIdentityMatched: boolean;
  readyObserved: boolean;
  outputObserved: boolean;
  exitObserved: boolean;
  interruptCompleted: boolean;
  helperCleanupCompleted: boolean;
}

export interface SandboxBehaviorWorkspaceConfinementCheckResult {
  workspaceCreateAllowed: boolean;
  workspaceModifyAllowed: boolean;
  outsideReadDenied: boolean;
  outsideWriteDenied: boolean;
}

export interface SandboxBehaviorProtectedMetadataCheckResult {
  gitWriteDenied: boolean;
  policyWriteDenied: boolean;
  symlinkWriteDenied: boolean;
  nonexistentDescendantWriteDenied: boolean;
}

export interface SandboxBehaviorProcessInheritanceCheckResult {
  childOutsideAccessDenied: boolean;
  grandchildProtectedAccessDenied: boolean;
  ownedProcessGroupCleaned: boolean;
}

export interface SandboxBehaviorPrivateEnvironmentCheckResult {
  homeIsPrivate: boolean;
  tmpIsPrivate: boolean;
  cacheIsPrivate: boolean;
  hostSentinelAbsent: boolean;
  realHomeCredentialUnreadable: boolean;
}

export interface SandboxBehaviorBlockedNetworkCheckResult {
  loopbackConnectDenied: boolean;
  privateConnectDenied: boolean;
  publicConnectDenied: boolean;
  loopbackFixtureUntouched: boolean;
  proxyEndpointsLoopbackOnly: boolean;
}

export interface SandboxBehaviorDenialEvidenceCheckResult {
  expectedDenialsObserved: boolean;
  evidenceBounded: boolean;
  evidenceNormalized: boolean;
  successIndependentOfExitCode: boolean;
}

export interface SandboxBehaviorSyntheticCheckResult {
  helperLifecycle: SandboxBehaviorHelperLifecycleCheckResult;
  workspaceConfinement: SandboxBehaviorWorkspaceConfinementCheckResult;
  protectedMetadata: SandboxBehaviorProtectedMetadataCheckResult;
  processInheritance: SandboxBehaviorProcessInheritanceCheckResult;
  privateEnvironment: SandboxBehaviorPrivateEnvironmentCheckResult;
  blockedNetwork: SandboxBehaviorBlockedNetworkCheckResult;
  denialEvidence: SandboxBehaviorDenialEvidenceCheckResult;
}

export interface SandboxBehaviorFingerprintMetadata {
  extensionVersion: string;
  policyVersion: string;
  profileId: string;
  helperProtocolVersion: number;
  backend: "seatbelt";
  platform: "darwin";
  architecture: "arm64" | "x64";
}

export interface SandboxBehaviorRuntimeFingerprint {
  readonly digest: string;
  readonly metadata: SandboxBehaviorFingerprintMetadata;
}

export interface SandboxBehaviorProbeRequest {
  readonly fingerprint: SandboxBehaviorRuntimeFingerprint;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  recordOutput(output: string | Uint8Array): void;
  registerCleanup(cleanup: SandboxBehaviorProbeCleanup): void;
}

export type SandboxBehaviorProbeCleanup = () => void | Promise<void>;

export type SandboxBehaviorProbeResult =
  | {
      outcome: "checks";
      checks: SandboxBehaviorSyntheticCheckResult;
    }
  | {
      outcome: "failed";
      failureCode: SandboxBehaviorAttestationFailureCode;
    };

export interface SandboxBehaviorProbeAdapter {
  run(
    request: SandboxBehaviorProbeRequest,
  ): Promise<SandboxBehaviorProbeResult>;
}

export interface SandboxBehaviorAttestationSummary {
  readonly attestationId: string;
  readonly attestationVersion: string;
  readonly runtimeFingerprint: string;
  readonly verifiedAt: number;
  readonly metadata: Readonly<SandboxBehaviorFingerprintMetadata>;
  readonly verifiedChecks: readonly [
    "helper_lifecycle",
    "workspace_confinement",
    "protected_metadata",
    "process_inheritance",
    "private_environment",
    "blocked_network",
    "denial_evidence",
  ];
}

export type SandboxBehaviorAttestationResult =
  | {
      readonly verified: true;
      readonly summary: SandboxBehaviorAttestationSummary;
    }
  | {
      readonly verified: false;
      readonly failureCode: SandboxBehaviorAttestationFailureCode;
    };

export interface SandboxBehaviorAttestationServiceOptions {
  probe: SandboxBehaviorProbeAdapter;
  attestationVersion?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
  createAttestationId?: () => string;
}

interface AttestationFlight {
  readonly promise: Promise<SandboxBehaviorAttestationResult>;
  cancel(): void;
}

const FAILURE_CODES = new Set<SandboxBehaviorAttestationFailureCode>([
  "runtime_unavailable",
  "helper_protocol_failed",
  "filesystem_confinement_failed",
  "protected_metadata_failed",
  "process_inheritance_failed",
  "private_environment_failed",
  "network_block_failed",
  "denial_evidence_failed",
  "cleanup_failed",
  "probe_timeout",
  "probe_output_limit",
  "probe_cancelled",
  "service_disposed",
]);

const VERIFIED_CHECKS = Object.freeze([
  "helper_lifecycle",
  "workspace_confinement",
  "protected_metadata",
  "process_inheritance",
  "private_environment",
  "blocked_network",
  "denial_evidence",
] as const);

class ProbeTimeoutError extends Error {}
class ProbeCancelledError extends Error {}

class ProbeResourceScope {
  private cleanups: SandboxBehaviorProbeCleanup[] = [];
  private closed = false;

  register(cleanup: SandboxBehaviorProbeCleanup): void {
    if (this.closed) {
      void Promise.resolve()
        .then(cleanup)
        .catch(() => {});
      return;
    }
    this.cleanups.push(cleanup);
  }

  async cleanup(): Promise<boolean> {
    if (this.closed) return true;
    this.closed = true;
    let succeeded = true;
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        succeeded = false;
      }
    }
    this.cleanups = [];
    return succeeded;
  }
}

function assertBoundedPositiveInteger(
  value: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
}

function assertSafeMetadataString(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
  ) {
    throw new Error(
      `${label} must contain only bounded fingerprint-safe metadata`,
    );
  }
}

function normalizeFingerprint(
  fingerprint: SandboxBehaviorRuntimeFingerprint,
): SandboxBehaviorRuntimeFingerprint {
  const digest = fingerprint.digest.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Sandbox runtime fingerprint must be a SHA-256 hex digest");
  }
  const metadata = fingerprint.metadata;
  assertSafeMetadataString(metadata.extensionVersion, "extensionVersion");
  assertSafeMetadataString(metadata.policyVersion, "policyVersion");
  assertSafeMetadataString(metadata.profileId, "profileId");
  if (
    !Number.isSafeInteger(metadata.helperProtocolVersion) ||
    metadata.helperProtocolVersion <= 0
  ) {
    throw new Error("helperProtocolVersion must be a positive integer");
  }
  if (
    metadata.backend !== "seatbelt" ||
    metadata.platform !== "darwin" ||
    (metadata.architecture !== "arm64" && metadata.architecture !== "x64")
  ) {
    throw new Error("Sandbox runtime fingerprint metadata is unsupported");
  }
  return Object.freeze({
    digest,
    metadata: Object.freeze({ ...metadata }),
  });
}

function fingerprintKey(
  fingerprint: SandboxBehaviorRuntimeFingerprint,
): string {
  const metadata = fingerprint.metadata;
  return [
    fingerprint.digest,
    metadata.extensionVersion,
    metadata.policyVersion,
    metadata.profileId,
    metadata.helperProtocolVersion,
    metadata.backend,
    metadata.platform,
    metadata.architecture,
  ].join("\u0000");
}

function failed(
  failureCode: SandboxBehaviorAttestationFailureCode,
): SandboxBehaviorAttestationResult {
  return Object.freeze({ verified: false, failureCode });
}

function hasExplicitTrueFields(
  value: unknown,
  fields: readonly string[],
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return fields.every((field) => record[field] === true);
}

function checkFailureCode(
  checks: SandboxBehaviorSyntheticCheckResult,
): SandboxBehaviorAttestationFailureCode | undefined {
  const helper = checks?.helperLifecycle;
  if (
    !hasExplicitTrueFields(helper, [
      "productionHelperLaunched",
      "protocolIdentityMatched",
      "readyObserved",
      "outputObserved",
      "exitObserved",
      "interruptCompleted",
      "helperCleanupCompleted",
    ])
  ) {
    if (helper?.helperCleanupCompleted === false) return "cleanup_failed";
    return "helper_protocol_failed";
  }
  if (
    !hasExplicitTrueFields(checks.workspaceConfinement, [
      "workspaceCreateAllowed",
      "workspaceModifyAllowed",
      "outsideReadDenied",
      "outsideWriteDenied",
    ])
  ) {
    return "filesystem_confinement_failed";
  }
  if (
    !hasExplicitTrueFields(checks.protectedMetadata, [
      "gitWriteDenied",
      "policyWriteDenied",
      "symlinkWriteDenied",
      "nonexistentDescendantWriteDenied",
    ])
  ) {
    return "protected_metadata_failed";
  }
  if (
    !hasExplicitTrueFields(checks.processInheritance, [
      "childOutsideAccessDenied",
      "grandchildProtectedAccessDenied",
      "ownedProcessGroupCleaned",
    ])
  ) {
    if (checks.processInheritance?.ownedProcessGroupCleaned === false) {
      return "cleanup_failed";
    }
    return "process_inheritance_failed";
  }
  if (
    !hasExplicitTrueFields(checks.privateEnvironment, [
      "homeIsPrivate",
      "tmpIsPrivate",
      "cacheIsPrivate",
      "hostSentinelAbsent",
      "realHomeCredentialUnreadable",
    ])
  ) {
    return "private_environment_failed";
  }
  if (
    !hasExplicitTrueFields(checks.blockedNetwork, [
      "loopbackConnectDenied",
      "privateConnectDenied",
      "publicConnectDenied",
      "loopbackFixtureUntouched",
      "proxyEndpointsLoopbackOnly",
    ])
  ) {
    return "network_block_failed";
  }
  if (
    !hasExplicitTrueFields(checks.denialEvidence, [
      "expectedDenialsObserved",
      "evidenceBounded",
      "evidenceNormalized",
      "successIndependentOfExitCode",
    ])
  ) {
    return "denial_evidence_failed";
  }
  return undefined;
}

function isFailureCode(
  value: unknown,
): value is SandboxBehaviorAttestationFailureCode {
  return (
    typeof value === "string" &&
    FAILURE_CODES.has(value as SandboxBehaviorAttestationFailureCode)
  );
}

export class SandboxBehaviorAttestationService {
  private readonly verifiedCache = new Map<
    string,
    SandboxBehaviorAttestationResult
  >();
  private readonly failures = new Map<
    string,
    SandboxBehaviorAttestationResult
  >();
  private readonly flights = new Map<string, AttestationFlight>();
  private activeFlight: { readonly flight: AttestationFlight } | undefined;
  private readonly attestationVersion: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private readonly createAttestationId: () => string;
  private disposed = false;

  constructor(
    private readonly options: SandboxBehaviorAttestationServiceOptions,
  ) {
    this.attestationVersion =
      options.attestationVersion ?? SANDBOX_BEHAVIOR_ATTESTATION_VERSION;
    assertSafeMetadataString(this.attestationVersion, "attestationVersion");
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_SANDBOX_BEHAVIOR_PROBE_TIMEOUT_MS;
    this.maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_SANDBOX_BEHAVIOR_PROBE_MAX_OUTPUT_BYTES;
    assertBoundedPositiveInteger(
      this.timeoutMs,
      MAX_PROBE_TIMEOUT_MS,
      "timeoutMs",
    );
    assertBoundedPositiveInteger(
      this.maxOutputBytes,
      MAX_PROBE_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.now = options.now ?? Date.now;
    this.createAttestationId = options.createAttestationId ?? randomUUID;
  }

  attest(
    requestedFingerprint: SandboxBehaviorRuntimeFingerprint,
  ): Promise<SandboxBehaviorAttestationResult> {
    if (this.disposed) return Promise.resolve(failed("service_disposed"));
    const fingerprint = normalizeFingerprint(requestedFingerprint);
    const key = fingerprintKey(fingerprint);
    const verified = this.verifiedCache.get(key);
    if (verified) return Promise.resolve(verified);
    const failure = this.failures.get(key);
    if (failure) return Promise.resolve(failure);
    const active = this.flights.get(key);
    if (active) return active.promise;
    return this.startFlight(key, fingerprint, this.activeFlight?.flight)
      .promise;
  }

  retry(
    requestedFingerprint: SandboxBehaviorRuntimeFingerprint,
  ): Promise<SandboxBehaviorAttestationResult> {
    if (this.disposed) return Promise.resolve(failed("service_disposed"));
    const fingerprint = normalizeFingerprint(requestedFingerprint);
    const key = fingerprintKey(fingerprint);
    const verified = this.verifiedCache.get(key);
    if (verified) return Promise.resolve(verified);
    this.failures.delete(key);
    return this.startFlight(key, fingerprint, this.activeFlight?.flight)
      .promise;
  }

  invalidate(requestedFingerprint?: SandboxBehaviorRuntimeFingerprint): void {
    if (requestedFingerprint) {
      const fingerprint = normalizeFingerprint(requestedFingerprint);
      const key = fingerprintKey(fingerprint);
      this.verifiedCache.delete(key);
      this.failures.delete(key);
      const flight = this.flights.get(key);
      flight?.cancel();
      this.flights.delete(key);
      if (this.activeFlight?.flight === flight) this.activeFlight = undefined;
      return;
    }
    this.verifiedCache.clear();
    this.failures.clear();
    for (const flight of this.flights.values()) flight.cancel();
    this.flights.clear();
    this.activeFlight = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.verifiedCache.clear();
    this.failures.clear();
    for (const flight of this.flights.values()) flight.cancel();
    this.flights.clear();
    this.activeFlight = undefined;
  }

  private startFlight(
    key: string,
    fingerprint: SandboxBehaviorRuntimeFingerprint,
    previous?: AttestationFlight,
  ): AttestationFlight {
    let cancelled = false;
    let controller: AbortController | undefined;
    let flight!: AttestationFlight;
    const promise = (async (): Promise<SandboxBehaviorAttestationResult> => {
      if (previous) {
        previous.cancel();
        await previous.promise;
      }
      if (this.disposed) return failed("service_disposed");
      if (cancelled) return failed("probe_cancelled");
      controller = new AbortController();
      const result = await this.runAttempt(fingerprint, controller);
      if (this.disposed) return failed("service_disposed");
      if (cancelled) return failed("probe_cancelled");
      if (this.flights.get(key) === flight) {
        if (result.verified) this.verifiedCache.set(key, result);
        else if (
          result.failureCode !== "probe_cancelled" &&
          result.failureCode !== "service_disposed"
        ) {
          this.failures.set(key, result);
        }
      }
      return result;
    })().finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
      if (this.activeFlight?.flight === flight) this.activeFlight = undefined;
    });
    flight = {
      promise,
      cancel() {
        cancelled = true;
        controller?.abort();
      },
    };
    this.flights.set(key, flight);
    this.activeFlight = { flight };
    return flight;
  }

  private async runAttempt(
    fingerprint: SandboxBehaviorRuntimeFingerprint,
    controller: AbortController,
  ): Promise<SandboxBehaviorAttestationResult> {
    const resources = new ProbeResourceScope();
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let result: SandboxBehaviorAttestationResult;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    try {
      const boundedProbe = new Promise<SandboxBehaviorProbeResult>(
        (resolve, reject) => {
          let settled = false;
          const settle = (action: () => void): void => {
            if (settled) return;
            settled = true;
            action();
          };
          timeout = setTimeout(() => {
            settle(() => reject(new ProbeTimeoutError()));
            controller.abort();
          }, this.timeoutMs);
          abortListener = () => settle(() => reject(new ProbeCancelledError()));
          controller.signal.addEventListener("abort", abortListener, {
            once: true,
          });

          void this.options.probe
            .run({
              fingerprint,
              signal: controller.signal,
              timeoutMs: this.timeoutMs,
              maxOutputBytes: this.maxOutputBytes,
              recordOutput: (output) => {
                if (outputLimitExceeded) return;
                const bytes =
                  typeof output === "string"
                    ? Buffer.byteLength(output, "utf8")
                    : output.byteLength;
                outputBytes += bytes;
                if (outputBytes > this.maxOutputBytes) {
                  outputLimitExceeded = true;
                  controller.abort();
                }
              },
              registerCleanup: (cleanup) => resources.register(cleanup),
            })
            .then(
              (probeResult) => settle(() => resolve(probeResult)),
              (error) => settle(() => reject(error)),
            );
        },
      );

      const probeResult = await boundedProbe;
      if (outputLimitExceeded) {
        result = failed("probe_output_limit");
      } else if (probeResult.outcome === "failed") {
        result = failed(
          isFailureCode(probeResult.failureCode)
            ? probeResult.failureCode
            : "helper_protocol_failed",
        );
      } else {
        const failureCode = checkFailureCode(probeResult.checks);
        result = failureCode
          ? failed(failureCode)
          : this.verifiedResult(fingerprint);
      }
    } catch (error) {
      if (outputLimitExceeded) {
        result = failed("probe_output_limit");
      } else if (error instanceof ProbeTimeoutError) {
        result = failed("probe_timeout");
      } else if (
        error instanceof ProbeCancelledError ||
        controller.signal.aborted
      ) {
        result = failed("probe_cancelled");
      } else {
        result = failed("helper_protocol_failed");
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener)
        controller.signal.removeEventListener("abort", abortListener);
    }

    if (!(await resources.cleanup())) return failed("cleanup_failed");
    return result;
  }

  private verifiedResult(
    fingerprint: SandboxBehaviorRuntimeFingerprint,
  ): SandboxBehaviorAttestationResult {
    const summary: SandboxBehaviorAttestationSummary = Object.freeze({
      attestationId: this.createAttestationId(),
      attestationVersion: this.attestationVersion,
      runtimeFingerprint: fingerprint.digest,
      verifiedAt: this.now(),
      metadata: fingerprint.metadata,
      verifiedChecks: VERIFIED_CHECKS,
    });
    return Object.freeze({ verified: true, summary });
  }
}
