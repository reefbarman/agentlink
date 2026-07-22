import { describe, expect, it, vi } from "vitest";

import {
  SANDBOX_BEHAVIOR_ATTESTATION_VERSION,
  SandboxBehaviorAttestationService,
  type SandboxBehaviorAttestationFailureCode,
  type SandboxBehaviorProbeAdapter,
  type SandboxBehaviorProbeRequest,
  type SandboxBehaviorRuntimeFingerprint,
  type SandboxBehaviorSyntheticCheckResult,
} from "./SandboxBehaviorAttestationService.js";

function fingerprint(
  digestCharacter = "a",
  overrides: Partial<SandboxBehaviorRuntimeFingerprint["metadata"]> = {},
): SandboxBehaviorRuntimeFingerprint {
  return {
    digest: digestCharacter.repeat(64),
    metadata: {
      extensionVersion: "1.2.3",
      policyVersion: "policy-v1",
      profileId: "workspace-write",
      helperProtocolVersion: 1,
      backend: "seatbelt",
      platform: "darwin",
      architecture: "arm64",
      ...overrides,
    },
  };
}

function passingChecks(): SandboxBehaviorSyntheticCheckResult {
  return {
    helperLifecycle: {
      productionHelperLaunched: true,
      protocolIdentityMatched: true,
      readyObserved: true,
      outputObserved: true,
      exitObserved: true,
      interruptCompleted: true,
      helperCleanupCompleted: true,
    },
    workspaceConfinement: {
      workspaceCreateAllowed: true,
      workspaceModifyAllowed: true,
      outsideReadAllowed: true,
      outsideWriteDenied: true,
    },
    protectedMetadata: {
      gitWriteDenied: true,
      policyWriteDenied: true,
      symlinkWriteDenied: true,
      nonexistentDescendantWriteDenied: true,
    },
    processInheritance: {
      childOutsideReadAllowed: true,
      grandchildProtectedAccessDenied: true,
      ownedProcessGroupCleaned: true,
    },
    privateEnvironment: {
      homeMatchesHost: true,
      hostHomeReadAllowed: true,
      hostHomeWriteDenied: true,
      hostTmpEnvironmentMatched: true,
      hostTmpWriteAllowed: true,
      slashTmpWriteAllowed: true,
      cacheIsPrivate: true,
      credentialEnvironmentInherited: true,
    },
    blockedNetwork: {
      loopbackConnectDenied: true,
      privateConnectDenied: true,
      publicConnectDenied: true,
      loopbackFixtureUntouched: true,
      proxyEndpointsLoopbackOnly: true,
    },
    denialEvidence: {
      expectedDenialsObserved: true,
      evidenceBounded: true,
      evidenceNormalized: true,
      successIndependentOfExitCode: true,
    },
  };
}

function successfulAdapter(
  run: (
    request: SandboxBehaviorProbeRequest,
  ) => void | Promise<void> = () => {},
): SandboxBehaviorProbeAdapter {
  return {
    async run(request) {
      await run(request);
      return { outcome: "checks", checks: passingChecks() };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function expectFailure(
  result: Awaited<ReturnType<SandboxBehaviorAttestationService["attest"]>>,
  failureCode: SandboxBehaviorAttestationFailureCode,
): void {
  expect(result).toEqual({ verified: false, failureCode });
}

describe("SandboxBehaviorAttestationService", () => {
  it("returns a frozen, token-free summary only when every production check is true", async () => {
    const cleanup = vi.fn();
    const service = new SandboxBehaviorAttestationService({
      probe: successfulAdapter((request) => {
        expect(request.fingerprint).toEqual(fingerprint());
        expect(request.timeoutMs).toBe(12_000);
        expect(request.maxOutputBytes).toBe(4_096);
        request.recordOutput("bounded probe output");
        request.registerCleanup(cleanup);
      }),
      timeoutMs: 12_000,
      maxOutputBytes: 4_096,
      now: () => 123_456,
      createAttestationId: () => "00000000-0000-4000-8000-000000000001",
    });

    const result = await service.attest(fingerprint());

    expect(result).toEqual({
      verified: true,
      summary: {
        attestationId: "00000000-0000-4000-8000-000000000001",
        attestationVersion: SANDBOX_BEHAVIOR_ATTESTATION_VERSION,
        runtimeFingerprint: "a".repeat(64),
        verifiedAt: 123_456,
        metadata: fingerprint().metadata,
        verifiedChecks: [
          "helper_lifecycle",
          "workspace_confinement",
          "protected_metadata",
          "process_inheritance",
          "private_environment",
          "blocked_network",
          "denial_evidence",
        ],
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.verified) throw new Error("expected verified attestation");
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(Object.isFrozen(result.summary.metadata)).toBe(true);
    expect(Object.isFrozen(result.summary.verifiedChecks)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /secret-value|credential-value|\/Users\/example|\/private\/tmp\/probe|raw-output|bearer-token/i,
    );
  });

  it.each([
    ["helperLifecycle", "readyObserved", "helper_protocol_failed"],
    [
      "workspaceConfinement",
      "outsideReadAllowed",
      "filesystem_confinement_failed",
    ],
    ["protectedMetadata", "symlinkWriteDenied", "protected_metadata_failed"],
    [
      "processInheritance",
      "childOutsideReadAllowed",
      "process_inheritance_failed",
    ],
    [
      "privateEnvironment",
      "credentialEnvironmentInherited",
      "private_environment_failed",
    ],
    ["blockedNetwork", "loopbackFixtureUntouched", "network_block_failed"],
    [
      "denialEvidence",
      "successIndependentOfExitCode",
      "denial_evidence_failed",
    ],
  ] as const)(
    "maps a failed %s.%s check to %s",
    async (group, check, expectedCode) => {
      const checks = passingChecks();
      (checks[group] as unknown as Record<string, boolean>)[check] = false;
      const service = new SandboxBehaviorAttestationService({
        probe: {
          run: vi.fn(async () => ({ outcome: "checks" as const, checks })),
        },
      });

      expectFailure(await service.attest(fingerprint()), expectedCode);
    },
  );

  it("fails closed when a required field is omitted and maps cleanup evidence separately", async () => {
    const incomplete = passingChecks();
    delete (
      incomplete.blockedNetwork as Partial<
        SandboxBehaviorSyntheticCheckResult["blockedNetwork"]
      >
    ).publicConnectDenied;
    const incompleteService = new SandboxBehaviorAttestationService({
      probe: {
        run: vi.fn(async () => ({
          outcome: "checks" as const,
          checks: incomplete,
        })),
      },
    });
    const incompleteResult = await incompleteService.attest(fingerprint());
    expectFailure(incompleteResult, "network_block_failed");
    expect(Object.isFrozen(incompleteResult)).toBe(true);

    const unclean = passingChecks();
    unclean.processInheritance.ownedProcessGroupCleaned = false;
    const uncleanService = new SandboxBehaviorAttestationService({
      probe: {
        run: vi.fn(async () => ({
          outcome: "checks" as const,
          checks: unclean,
        })),
      },
    });
    expectFailure(await uncleanService.attest(fingerprint()), "cleanup_failed");
  });

  it("single-flights concurrent requests and caches success by complete runtime fingerprint", async () => {
    const pending = deferred<void>();
    const run = vi.fn(async () => {
      await pending.promise;
      return { outcome: "checks" as const, checks: passingChecks() };
    });
    const service = new SandboxBehaviorAttestationService({ probe: { run } });

    const first = service.attest(fingerprint());
    const concurrent = service.attest(fingerprint());
    expect(first).toBe(concurrent);
    expect(run).toHaveBeenCalledTimes(1);

    pending.resolve();
    const verified = await first;
    expect(verified.verified).toBe(true);
    expect(await service.attest(fingerprint())).toBe(verified);
    expect(run).toHaveBeenCalledTimes(1);

    await service.attest(fingerprint("b"));
    await service.attest(fingerprint("a", { policyVersion: "policy-v2" }));
    await service.attest(fingerprint("a", { helperProtocolVersion: 2 }));
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("serializes different fingerprints through one global production probe flight", async () => {
    const attempts: Array<{
      digest: string;
      gate: ReturnType<typeof deferred<void>>;
    }> = [];
    const run = vi.fn(async (request: SandboxBehaviorProbeRequest) => {
      const gate = deferred<void>();
      attempts.push({ digest: request.fingerprint.digest, gate });
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        ),
      ]);
      return { outcome: "checks" as const, checks: passingChecks() };
    });
    const service = new SandboxBehaviorAttestationService({ probe: { run } });

    const stale = service.attest(fingerprint("a"));
    const replacement = service.attest(fingerprint("b"));
    expectFailure(await stale, "probe_cancelled");
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts.map(({ digest }) => digest)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);

    attempts[1].gate.resolve();
    expect((await replacement).verified).toBe(true);
  });

  it("latches failures and retry clears only failed state", async () => {
    const run = vi
      .fn<SandboxBehaviorProbeAdapter["run"]>()
      .mockResolvedValueOnce({
        outcome: "failed",
        failureCode: "runtime_unavailable",
      })
      .mockResolvedValue({ outcome: "checks", checks: passingChecks() });
    const service = new SandboxBehaviorAttestationService({ probe: { run } });

    expectFailure(await service.attest(fingerprint()), "runtime_unavailable");
    expectFailure(await service.attest(fingerprint()), "runtime_unavailable");
    expect(run).toHaveBeenCalledTimes(1);

    const retried = await service.retry(fingerprint());
    expect(retried.verified).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await service.retry(fingerprint())).toBe(retried);
  });

  it("supersedes an active retry without letting stale cleanup remove it", async () => {
    const attempts: Array<ReturnType<typeof deferred<void>>> = [];
    const run = vi.fn(async (request: SandboxBehaviorProbeRequest) => {
      const attempt = deferred<void>();
      attempts.push(attempt);
      await Promise.race([
        attempt.promise,
        new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        ),
      ]);
      return { outcome: "checks" as const, checks: passingChecks() };
    });
    const service = new SandboxBehaviorAttestationService({ probe: { run } });

    const stale = service.attest(fingerprint());
    const replacement = service.retry(fingerprint());
    expectFailure(await stale, "probe_cancelled");
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(service.attest(fingerprint())).toBe(replacement);

    attempts[1].resolve();
    expect((await replacement).verified).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds aggregate output, aborts the adapter, and cleans resources", async () => {
    const cleanup = vi.fn();
    const observedAbort = vi.fn();
    const service = new SandboxBehaviorAttestationService({
      maxOutputBytes: 4,
      probe: successfulAdapter((request) => {
        request.registerCleanup(cleanup);
        request.signal.addEventListener("abort", observedAbort);
        request.recordOutput("123");
        request.recordOutput("45");
      }),
    });

    expectFailure(await service.attest(fingerprint()), "probe_output_limit");
    expect(observedAbort).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("times out a hung adapter and performs registered cleanup", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const observedAbort = vi.fn();
      const service = new SandboxBehaviorAttestationService({
        timeoutMs: 25,
        probe: {
          async run(request) {
            request.registerCleanup(cleanup);
            request.signal.addEventListener("abort", observedAbort);
            return new Promise(() => {});
          },
        },
      });

      const result = service.attest(fingerprint());
      await vi.advanceTimersByTimeAsync(25);

      expectFailure(await result, "probe_timeout");
      expect(observedAbort).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels stale work on invalidation and disposal without caching late completion", async () => {
    const attempts: Array<ReturnType<typeof deferred<void>>> = [];
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const service = new SandboxBehaviorAttestationService({
      probe: {
        async run(request) {
          const attempt = deferred<void>();
          const cleanup = vi.fn();
          attempts.push(attempt);
          cleanups.push(cleanup);
          request.registerCleanup(cleanup);
          await Promise.race([
            attempt.promise,
            new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            ),
          ]);
          return { outcome: "checks", checks: passingChecks() };
        },
      },
    });

    const stale = service.attest(fingerprint());
    service.invalidate(fingerprint());
    expectFailure(await stale, "probe_cancelled");
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    const fresh = service.attest(fingerprint());
    attempts[1].resolve();
    expect((await fresh).verified).toBe(true);

    const pending = service.attest(fingerprint("b"));
    service.dispose();
    expectFailure(await pending, "service_disposed");
    expect(cleanups[2]).toHaveBeenCalledTimes(1);
    expectFailure(await service.attest(fingerprint("c")), "service_disposed");
  });
});
