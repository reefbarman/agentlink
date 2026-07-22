import {
  CURRENT_SANDBOX_POLICY_VERSION,
  type SandboxExecutionMetadata,
} from "../../core/sandboxPolicy.js";
import { describe, expect, it, vi } from "vitest";

import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
  SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";
import {
  SandboxTerminalCoordinator,
  type AuthorizedSandboxLaunch,
  type SandboxLaunchAuthorizer,
} from "./SandboxTerminalCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeProcess implements SandboxCommandProcess {
  readonly readyDeferred = deferred<SandboxCommandReady>();
  readonly completionDeferred = deferred<SandboxCommandExit>();
  readonly ready = this.readyDeferred.promise;
  readonly completion = this.completionDeferred.promise;
  readonly write = vi.fn(() => true);
  readonly resize = vi.fn(() => true);
  readonly interrupt = vi.fn(() => true);
  readonly respondToNetworkRequest = vi.fn(() => true);
  readonly terminate = vi.fn(() => true);
  readonly dispose = vi.fn();
  private readonly listeners = new Set<(event: SandboxCommandEvent) => void>();

  constructor(
    readonly identity: {
      channelId: string;
      commandId: string;
      generation: number;
    },
  ) {}

  onEvent(
    listener: (event: SandboxCommandEvent) => void,
  ): SandboxCommandDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(event: SandboxCommandEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const managedDestination = {
  requestId: "network-1",
  host: "registry.npmjs.org",
  protocol: "https" as const,
  port: 443,
  address: "104.16.24.34",
  family: 4 as const,
  dnsAnswers: [
    { address: "104.16.24.34", family: 4 as const },
    { address: "104.16.25.34", family: 4 as const },
  ],
  destinationClass: "public" as const,
};

const metadata: SandboxExecutionMetadata = {
  policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
  profileId: "workspace-write",
  backend: "seatbelt",
  capabilities: {
    backend: "seatbelt",
    processTree: true,
    filesystemRead: "policy-denied",
    filesystemWrite: "strict",
    network: "blocked",
    privateHome: true,
    privateTmp: false,
    hostIpcBlocked: false,
    resourceLimits: "partial",
    warnings: [],
  },
};

function harness() {
  const processes: FakeProcess[] = [];
  const authorizedFinalizer = vi.fn();
  const runtime: SandboxRuntimeProvider = {
    launch: vi.fn((request) => {
      const process = new FakeProcess({
        channelId: request.channelId,
        commandId: request.commandId,
        generation: request.generation,
      });
      processes.push(process);
      return process;
    }),
    dispose: vi.fn(),
  };
  const authorizer: SandboxLaunchAuthorizer = {
    authorize: vi.fn(
      async ({
        options,
        channelId,
        commandId,
        generation,
        dimensions,
      }): Promise<AuthorizedSandboxLaunch> => ({
        authorization: {
          bindingDigest: "binding",
          policy: {
            version: CURRENT_SANDBOX_POLICY_VERSION,
            profileId: "workspace-write",
            readableRoots: ["/workspace"],
            writableRoots: ["/workspace"],
            deniedRoots: [],
            protectedReadOnlyRoots: [],
            network: { mode: "blocked" },
            environment: { inheritHost: false, values: {} },
            allowedUnixSockets: [],
          },
        },
        helperRequest: {
          version: 2,
          type: "launch",
          channelId,
          commandId,
          generation,
          command: options.command,
          cwd: options.cwd,
          shell: "/bin/zsh",
          environment: {},
          filesystem: {
            denyRead: [],
            allowRead: ["/workspace"],
            allowWrite: ["/workspace"],
            denyWrite: [],
          },
          network: { mode: "blocked" },
          protectedRoots: [],
          structurallyProtectedRoots: [],
          dimensions,
        },
        metadata,
        finalize: authorizedFinalizer,
      }),
    ),
  };
  let channel = 1;
  let command = 1;
  let now = 100;
  const coordinator = new SandboxTerminalCoordinator({
    runtime,
    authorizer,
    initialCwd: "/workspace",
    createChannelId: () => `sandbox-${channel++}`,
    createCommandId: () => `command-${command++}`,
    now: () => now,
    isAllowedCwd: (cwd) => cwd.startsWith("/workspace"),
  });
  return {
    authorizer,
    authorizedFinalizer,
    coordinator,
    processes,
    runtime,
    setNow(value: number) {
      now = value;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function finish(process: FakeProcess, output = "ok\r\n", exitCode = 0) {
  process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
  await flush();
  process.emit({ type: "data", data: output });
  process.completionDeferred.resolve({ exitCode, timedOut: false });
  await flush();
}

function enableManagedNetworking(test: ReturnType<typeof harness>): void {
  const authorize = vi
    .mocked(test.authorizer.authorize)
    .getMockImplementation();
  if (!authorize) throw new Error("expected authorizer implementation");
  vi.mocked(test.authorizer.authorize).mockImplementation(async (input) => {
    const authorized = await authorize(input);
    return {
      ...authorized,
      helperRequest: {
        ...authorized.helperRequest,
        network: { mode: "public-proxy" },
      },
      metadata: {
        ...authorized.metadata,
        grant: { grantId: "grant-network", auditId: "audit-network" },
      },
    };
  });
}

describe("SandboxTerminalCoordinator", () => {
  it("preauthorizes without launching and transfers cleanup on consume", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "session-1",
      },
      {
        auditId: "audit-1",
        route: "sandbox",
        confinement: "verified-baseline",
        routeReason: "verified-local-macos",
        executionSurface: "verified-sandbox",
        requiredAuthority: "sandbox",
        permissionIntent: "default",
        approvalRequirement: "policy",
        authorityReason: "approval-policy",
        approvalPolicySnapshot: "on-request" as const,
        approvalReviewerSnapshot: "auto-review" as const,
        executionPresetSnapshot: "workspace-write" as const,
        commandApprovalPolicySnapshot: "approve-for-me",
        executionPolicy: "sandbox-baseline-v2",
        preparedAt: 100,
        sandbox: {
          attestationId: "attestation-1",
          attestationVersion: "v1",
          policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
          profileId: "workspace-write",
          backend: "seatbelt",
          architecture: "arm64",
          capabilities: metadata.capabilities,
        },
      },
    );

    expect(test.authorizer.authorize).toHaveBeenCalledTimes(1);
    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).not.toHaveBeenCalled();

    const resultPromise = prepared.execute();
    expect(test.runtime.launch).toHaveBeenCalledTimes(1);
    await finish(test.processes[0] as FakeProcess);
    await expect(resultPromise).resolves.toMatchObject({
      security: { auditId: "audit-1", route: "sandbox" },
    });
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
    await expect(prepared.execute()).rejects.toThrow("no longer available");
  });

  it("reserves separate terminals for parallel prepared executions", async () => {
    const test = harness();
    const routeSecurity: Parameters<
      SandboxTerminalCoordinator["prepareConfinementExecution"]
    >[1] = {
      auditId: "audit-parallel",
      route: "sandbox",
      confinement: "verified-baseline",
      routeReason: "verified-local-macos",
      executionSurface: "verified-sandbox",
      requiredAuthority: "sandbox",
      permissionIntent: "default",
      approvalRequirement: "policy",
      authorityReason: "approval-policy",
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me",
      executionPolicy: "sandbox-baseline-v2",
      preparedAt: 100,
    };
    const firstPrepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "printf first",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      },
      routeSecurity,
    );
    const secondPrepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "printf second",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      },
      routeSecurity,
    );

    const first = firstPrepared.execute();
    const second = secondPrepared.execute();
    expect(test.processes.map((process) => process.identity.channelId)).toEqual(
      ["sandbox-1", "sandbox-2"],
    );

    await finish(test.processes[0], "first\r\n");
    await finish(test.processes[1], "second\r\n");
    await expect(first).resolves.toMatchObject({
      terminal_id: "sandbox-1",
      output: "first",
    });
    await expect(second).resolves.toMatchObject({
      terminal_id: "sandbox-2",
      output: "second",
    });
  });

  it("reserves separate terminals while parallel direct executions authorize", async () => {
    const test = harness();
    const firstAuthorization = deferred<AuthorizedSandboxLaunch>();
    const defaultAuthorize = vi
      .mocked(test.authorizer.authorize)
      .getMockImplementation();
    if (!defaultAuthorize)
      throw new Error("expected authorizer implementation");
    vi.mocked(test.authorizer.authorize)
      .mockImplementationOnce(() => firstAuthorization.promise)
      .mockImplementationOnce(defaultAuthorize);

    const first = test.coordinator.executeCommand({
      command: "printf first",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    const second = test.coordinator.executeCommand({
      command: "printf second",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();

    const firstRequest = vi.mocked(test.authorizer.authorize).mock.calls[0][0];
    const secondRequest = vi.mocked(test.authorizer.authorize).mock.calls[1][0];
    expect([firstRequest.channelId, secondRequest.channelId]).toEqual([
      "sandbox-1",
      "sandbox-2",
    ]);
    firstAuthorization.resolve(await defaultAuthorize(firstRequest));
    await flush();

    await finish(test.processes[0], "second\r\n");
    await finish(test.processes[1], "first\r\n");
    await expect(first).resolves.toMatchObject({ terminal_id: "sandbox-1" });
    await expect(second).resolves.toMatchObject({ terminal_id: "sandbox-2" });
  });

  it("attributes prepared managed-network requests and resumes the exact helper", async () => {
    const test = harness();
    const review = deferred<"allow-once" | "reject">();
    const onManagedNetworkRequest = vi.fn(() => review.promise);
    const prepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "npm view example version",
        cwd: "/workspace",
        sandboxSessionId: "session-network",
        sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        onManagedNetworkRequest,
      },
      {
        auditId: "audit-network",
        route: "sandbox",
        confinement: "verified-baseline",
        routeReason: "verified-local-macos",
        executionSurface: "verified-sandbox",
        requiredAuthority: "sandbox",
        permissionIntent: "additional-permissions",
        approvalRequirement: "explicit-permissions",
        authorityReason: "additional-permissions",
        approvalPolicySnapshot: "on-request",
        approvalReviewerSnapshot: "auto-review",
        executionPresetSnapshot: "workspace-write",
        commandApprovalPolicySnapshot: "approve-for-me",
        executionPolicy: "sandbox-baseline-v2",
        preparedAt: 100,
      },
    );

    const result = prepared.execute();
    const process = test.processes[0];
    process.emit({ type: "network-request", request: managedDestination });
    await flush();

    expect(onManagedNetworkRequest).toHaveBeenCalledWith(
      {
        sessionId: "session-network",
        auditId: "audit-network",
        terminalId: "sandbox-1",
        commandId: "command-1",
        generation: 1,
        command: "npm view example version",
        cwd: "/workspace",
        reason: "Managed public network requested",
        ...managedDestination,
        dnsAnswers: managedDestination.dnsAnswers,
      },
      expect.any(AbortSignal),
    );
    expect(process.respondToNetworkRequest).not.toHaveBeenCalled();

    review.resolve("allow-once");
    await flush();
    expect(process.respondToNetworkRequest).toHaveBeenCalledWith(
      "network-1",
      "allow-once",
    );
    await finish(process);
    await expect(result).resolves.toMatchObject({ exit_code: 0 });
  });

  it("fails closed before launch when managed networking lacks audit attribution", async () => {
    const test = harness();
    const authorize = vi
      .mocked(test.authorizer.authorize)
      .getMockImplementation();
    if (!authorize) throw new Error("expected authorizer implementation");
    vi.mocked(test.authorizer.authorize).mockImplementationOnce(
      async (input) => {
        const authorized = await authorize(input);
        return {
          ...authorized,
          helperRequest: {
            ...authorized.helperRequest,
            network: { mode: "public-proxy" },
          },
        };
      },
    );

    await expect(
      test.coordinator.executeCommand({
        command: "curl https://example.com",
        cwd: "/workspace",
        sandboxSessionId: "session-network",
        sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        onManagedNetworkRequest: vi.fn(),
      }),
    ).rejects.toThrow("requires command audit attribution");
    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
  });

  it("rejects managed-network requests when no reviewer is available", async () => {
    const test = harness();
    const result = test.coordinator.executeCommand({
      command: "curl https://example.com",
      cwd: "/workspace",
      sandboxSessionId: "session-network",
    });
    await flush();
    const process = test.processes[0];

    process.emit({ type: "network-request", request: managedDestination });
    await flush();
    expect(process.respondToNetworkRequest).toHaveBeenCalledWith(
      "network-1",
      "reject",
    );

    await finish(process, "blocked\r\n", 1);
    await expect(result).resolves.toMatchObject({ exit_code: 1 });
  });

  it("aborts pending network review on timeout and rejects the live helper request", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      enableManagedNetworking(test);
      const onManagedNetworkRequest = vi.fn(
        (_request, signal: AbortSignal) =>
          new Promise<"allow-once">((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("review aborted")),
              { once: true },
            );
          }),
      );
      const result = test.coordinator.executeCommand({
        command: "curl https://example.com",
        cwd: "/workspace",
        sandboxSessionId: "session-network",
        timeout: 100,
        onManagedNetworkRequest,
      });
      await flush();
      const process = test.processes[0];
      process.emit({ type: "network-request", request: managedDestination });
      await flush();

      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ timed_out: true });
      await flush();
      expect(process.respondToNetworkRequest).toHaveBeenCalledWith(
        "network-1",
        "reject",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates identical network request IDs across concurrent commands", async () => {
    const test = harness();
    enableManagedNetworking(test);
    const firstReview = deferred<"allow-once" | "reject">();
    const secondReview = deferred<"allow-once" | "reject">();
    const first = test.coordinator.executeCommand({
      command: "curl https://one.example",
      cwd: "/workspace",
      terminal_name: "One",
      sandboxSessionId: "session-network",
      background: true,
      onManagedNetworkRequest: () => firstReview.promise,
    });
    const second = test.coordinator.executeCommand({
      command: "curl https://two.example",
      cwd: "/workspace",
      terminal_name: "Two",
      sandboxSessionId: "session-network",
      background: true,
      onManagedNetworkRequest: () => secondReview.promise,
    });
    await flush();
    await Promise.all([first, second]);
    const [firstProcess, secondProcess] = test.processes;

    firstProcess.emit({ type: "network-request", request: managedDestination });
    secondProcess.emit({
      type: "network-request",
      request: managedDestination,
    });
    await flush();
    secondReview.resolve("reject");
    firstReview.resolve("allow-once");
    await flush();

    expect(firstProcess.respondToNetworkRequest).toHaveBeenCalledWith(
      "network-1",
      "allow-once",
    );
    expect(secondProcess.respondToNetworkRequest).toHaveBeenCalledWith(
      "network-1",
      "reject",
    );
  });

  it("rejects pending network review when its terminal closes", async () => {
    const test = harness();
    enableManagedNetworking(test);
    const reviewStarted = deferred<AbortSignal>();
    const onManagedNetworkRequest = vi.fn(
      (_request, signal: AbortSignal) =>
        new Promise<"allow-once">((_resolve, reject) => {
          reviewStarted.resolve(signal);
          signal.addEventListener(
            "abort",
            () => reject(new Error("review aborted")),
            { once: true },
          );
        }),
    );
    await test.coordinator.executeCommand({
      command: "curl https://example.com",
      cwd: "/workspace",
      sandboxSessionId: "session-network",
      background: true,
      onManagedNetworkRequest,
    });
    const process = test.processes[0];
    process.emit({ type: "network-request", request: managedDestination });
    await reviewStarted.promise;

    expect(test.coordinator.closeTerminals(["sandbox-1"])).toEqual({
      closed: 1,
    });
    await flush();
    expect(process.respondToNetworkRequest).toHaveBeenCalledWith(
      "network-1",
      "reject",
    );
  });

  it("invalidates a prepared execution when its terminal closes", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      },
      {
        auditId: "audit-close",
        route: "sandbox",
        confinement: "verified-baseline",
        routeReason: "verified-local-macos",
        executionSurface: "verified-sandbox",
        requiredAuthority: "sandbox",
        permissionIntent: "default",
        approvalRequirement: "policy",
        authorityReason: "approval-policy",
        approvalPolicySnapshot: "on-request" as const,
        approvalReviewerSnapshot: "auto-review" as const,
        executionPresetSnapshot: "workspace-write" as const,
        commandApprovalPolicySnapshot: "approve-for-me",
        executionPolicy: "sandbox-baseline-v2",
        preparedAt: 100,
      },
    );

    expect(test.coordinator.closeTerminals(["sandbox-1"])).toEqual({
      closed: 1,
    });
    await expect(prepared.execute()).rejects.toThrow("reservation is stale");
    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).toHaveBeenCalledOnce();
  });

  it("disposes rejected preauthorization without launching", async () => {
    const test = harness();
    const prepared = await test.coordinator.prepareConfinementExecution(
      {
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "session-1",
      },
      {
        auditId: "audit-1",
        route: "sandbox",
        confinement: "verified-baseline",
        routeReason: "verified-local-macos",
        executionSurface: "verified-sandbox",
        requiredAuthority: "sandbox",
        permissionIntent: "default",
        approvalRequirement: "policy",
        authorityReason: "approval-policy",
        approvalPolicySnapshot: "on-request" as const,
        approvalReviewerSnapshot: "auto-review" as const,
        executionPresetSnapshot: "workspace-write" as const,
        commandApprovalPolicySnapshot: "approve-for-me",
        executionPolicy: "sandbox-baseline-v2",
        preparedAt: 100,
      },
    );

    prepared.dispose();
    prepared.dispose();

    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
    await expect(prepared.execute()).rejects.toThrow("no longer available");
  });

  it("publishes disposal after synchronous channel closure", async () => {
    const test = harness();
    const order: string[] = [];
    test.coordinator.onChannelEvent(({ event }) => order.push(event.type));
    test.coordinator.onDispose(() => order.push("disposed"));
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
      background: true,
    });

    test.coordinator.dispose();

    expect(order).toEqual(["command-started", "closed", "disposed"]);
  });

  it("publishes identity-bound channel lifecycle snapshots", async () => {
    const test = harness();
    const updates: Array<{
      type: string;
      channelId: string;
      status: string;
      generation?: number;
    }> = [];
    const subscription = test.coordinator.onChannelEvent(
      ({ event, snapshot }) => {
        updates.push({
          type: event.type,
          channelId: snapshot.channelId,
          status: snapshot.status,
          ...(event.type === "data" ? { generation: event.generation } : {}),
        });
      },
    );

    const pending = test.coordinator.executeCommand({
      command: "printf hello",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    const process = test.processes[0];
    await finish(process, "hello");
    await pending;

    expect(updates).toEqual([
      { type: "command-started", channelId: "sandbox-1", status: "launching" },
      { type: "command-ready", channelId: "sandbox-1", status: "running" },
      {
        type: "data",
        channelId: "sandbox-1",
        status: "running",
        generation: 1,
      },
      { type: "command-exited", channelId: "sandbox-1", status: "idle" },
    ]);

    subscription.dispose();
    await test.coordinator.executeCommand({
      command: "true",
      cwd: "/workspace",
      terminal_id: "sandbox-1",
      sandboxSessionId: "agent-session",
      background: true,
    });
    expect(updates).toHaveLength(4);
  });
  it("executes in a fresh process and reuses idle channel history/cwd", async () => {
    const test = harness();
    const firstPromise = test.coordinator.executeCommand({
      command: "pwd",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    expect(test.processes).toHaveLength(1);
    await finish(test.processes[0], "/workspace\r\n");
    await expect(firstPromise).resolves.toMatchObject({
      exit_code: 0,
      output: "/workspace",
      terminal_id: "sandbox-1",
      terminal_name: "Agent command",
      execution_mode: "sandbox_pty",
      sandbox: metadata,
    });

    const secondPromise = test.coordinator.executeCommand({
      command: "echo next",
      cwd: "/workspace",
      sandboxSessionId: "agent-session",
    });
    await flush();
    expect(test.processes[1].identity).toEqual({
      channelId: "sandbox-1",
      commandId: "command-2",
      generation: 2,
    });
    await finish(test.processes[1], "next\r\n");
    await secondPromise;

    expect(test.coordinator.getChannelSnapshot("sandbox-1")).toMatchObject({
      title: "Agent command",
      status: "idle",
      commands: [
        { commandId: "command-1", command: "pwd" },
        { commandId: "command-2", command: "echo next" },
      ],
    });
  });

  it("supports named and split Sandbox channels without exposing foreign IDs", async () => {
    const test = harness();
    const named = test.coordinator.executeCommand({
      command: "sleep 1",
      cwd: "/workspace",
      terminal_name: "Server",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();
    await expect(named).resolves.toMatchObject({
      terminal_id: "sandbox-1",
      terminal_name: "Server",
      backgrounded: true,
    });

    const split = test.coordinator.executeCommand({
      command: "pwd",
      cwd: "/workspace",
      split_from: "sandbox-1",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();
    await expect(split).resolves.toMatchObject({
      terminal_id: "sandbox-2",
      terminal_name: "Agent command",
    });
    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        terminal_id: "host-terminal-1",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("Sandbox terminal not found");
  });

  it("keeps unnamed sandbox titles stable without exposing command text", async () => {
    const test = harness();
    const result = test.coordinator.executeCommand({
      command: "curl https://example.test?token=secret",
      cwd: "/workspace",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();

    await expect(result).resolves.toMatchObject({
      terminal_name: "Agent command",
    });
    expect(test.coordinator.listTerminals()).toContainEqual({
      id: "sandbox-1",
      name: "Agent command",
      busy: true,
    });
  });

  it("provides background output, UI input, resize, and Ctrl+C", async () => {
    const test = harness();
    const result = test.coordinator.executeCommand({
      command: "cat",
      cwd: "/workspace",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await flush();
    await result;
    const process = test.processes[0];
    process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
    await flush();
    process.emit({ type: "data", data: "waiting\r\n" });

    expect(test.coordinator.write("sandbox-1", "hello\r")).toBe(true);
    expect(
      test.coordinator.resize("sandbox-1", { columns: 120, rows: 40 }),
    ).toBe(true);
    expect(test.coordinator.interruptTerminal("sandbox-1")).toBe(true);
    expect(process.write).toHaveBeenCalledWith("hello\r");
    expect(process.interrupt).toHaveBeenCalledTimes(1);
    expect(test.coordinator.getBackgroundState("sandbox-1")).toMatchObject({
      is_running: true,
      state: "running",
      output: "waiting",
      output_captured: true,
    });

    process.completionDeferred.resolve({
      exitCode: 130,
      signal: 2,
      timedOut: false,
    });
    await flush();
    expect(test.coordinator.getBackgroundState("sandbox-1")).toMatchObject({
      is_running: false,
      state: "completed",
      exit_code: 130,
    });
  });

  it("detaches on timeout and finalizes inline files exactly once", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const deferred = vi.fn();
      const finalized = vi.fn();
      const resultPromise = test.coordinator.executeCommand({
        command: "sleep 10",
        cwd: "/workspace",
        timeout: 100,
        sandboxSessionId: "agent-session",
        onCommandFinalizationDeferred: deferred,
        onCommandFinalized: finalized,
      });
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      await expect(resultPromise).resolves.toMatchObject({
        timed_out: true,
        backgrounded: true,
        is_running: true,
      });
      expect(deferred).toHaveBeenCalledTimes(1);
      expect(finalized).not.toHaveBeenCalled();

      const process = test.processes[0];
      process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
      process.completionDeferred.resolve({ exitCode: 0, timedOut: false });
      await flush();
      expect(finalized).toHaveBeenCalledTimes(1);
      test.coordinator.closeTerminals();
      expect(finalized).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives repeated mixed lifecycle cycles across concurrent named channels", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();

      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const foreground = test.coordinator.executeCommand({
          command: `printf foreground-${iteration}`,
          cwd: "/workspace",
          sandboxSessionId: "agent-session",
        });
        await flush();
        await finish(
          test.processes.at(-1) as FakeProcess,
          `foreground-${iteration}\r\n`,
        );
        await expect(foreground).resolves.toMatchObject({
          terminal_id: "sandbox-1",
          exit_code: 0,
          output: `foreground-${iteration}`,
        });

        const interrupted = test.coordinator.executeCommand({
          command: `sleep interrupted-${iteration}`,
          cwd: "/workspace",
          terminal_name: "Interrupt lane",
          background: true,
          sandboxSessionId: "agent-session",
        });
        const completed = test.coordinator.executeCommand({
          command: `printf completed-${iteration}`,
          cwd: "/workspace",
          terminal_name: "Complete lane",
          background: true,
          sandboxSessionId: "agent-session",
        });
        await flush();
        await expect(interrupted).resolves.toMatchObject({
          terminal_id: "sandbox-2",
          backgrounded: true,
        });
        await expect(completed).resolves.toMatchObject({
          terminal_id: "sandbox-3",
          backgrounded: true,
        });
        const interruptedProcess = test.processes.at(-2) as FakeProcess;
        const completedProcess = test.processes.at(-1) as FakeProcess;
        interruptedProcess.readyDeferred.resolve({
          pid: iteration * 10 + 1,
          pgid: iteration * 10 + 1,
          backend: "seatbelt",
        });
        completedProcess.readyDeferred.resolve({
          pid: iteration * 10 + 2,
          pgid: iteration * 10 + 2,
          backend: "seatbelt",
        });
        await flush();
        expect(test.coordinator.interruptTerminal("sandbox-2")).toBe(true);
        interruptedProcess.completionDeferred.resolve({
          exitCode: 130,
          signal: 2,
          timedOut: false,
        });
        completedProcess.emit({
          type: "data",
          data: `completed-${iteration}\r\n`,
        });
        completedProcess.completionDeferred.resolve({
          exitCode: 0,
          timedOut: false,
        });
        await flush();

        const timedOut = test.coordinator.executeCommand({
          command: `sleep timeout-${iteration}`,
          cwd: "/workspace",
          terminal_name: "Timeout lane",
          timeout: 10,
          sandboxSessionId: "agent-session",
        });
        await flush();
        const timedOutProcess = test.processes.at(-1) as FakeProcess;
        timedOutProcess.readyDeferred.resolve({
          pid: iteration * 10 + 3,
          pgid: iteration * 10 + 3,
          backend: "seatbelt",
        });
        await flush();
        await vi.advanceTimersByTimeAsync(10);
        await expect(timedOut).resolves.toMatchObject({
          terminal_id: "sandbox-4",
          timed_out: true,
          backgrounded: true,
          is_running: true,
        });
        timedOutProcess.completionDeferred.resolve({
          exitCode: 0,
          timedOut: false,
        });
        await flush();
      }

      expect(test.runtime.launch).toHaveBeenCalledTimes(12);
      expect(test.coordinator.listTerminals()).toEqual([
        { id: "sandbox-1", name: "Agent command", busy: false },
        { id: "sandbox-2", name: "Interrupt lane", busy: false },
        { id: "sandbox-3", name: "Complete lane", busy: false },
        { id: "sandbox-4", name: "Timeout lane", busy: false },
      ]);
      expect(
        test.coordinator
          .getChannelSnapshot("sandbox-2")
          ?.commands.map(({ generation, exitCode }) => ({
            generation,
            exitCode,
          })),
      ).toEqual([
        { generation: 1, exitCode: 130 },
        { generation: 2, exitCode: 130 },
        { generation: 3, exitCode: 130 },
      ]);
      expect(
        test.coordinator
          .getChannelSnapshot("sandbox-4")
          ?.commands.map(({ generation, exitCode }) => ({
            generation,
            exitCode,
          })),
      ).toEqual([
        { generation: 1, exitCode: 0 },
        { generation: 2, exitCode: 0 },
        { generation: 3, exitCode: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unnamed timed-out high-volume command addressable by its returned ID", async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      const resultPromise = test.coordinator.executeCommand({
        command: "generate high-volume output",
        cwd: "/workspace",
        timeout: 100,
        sandboxSessionId: "agent-session",
      });
      await flush();
      const process = test.processes[0];
      process.readyDeferred.resolve({ pid: 1, pgid: 1, backend: "seatbelt" });
      await flush();
      process.emit({ type: "data", data: "1\n2\n3\n" });

      await vi.advanceTimersByTimeAsync(100);
      const timedOut = await resultPromise;
      expect(timedOut).toMatchObject({
        terminal_id: "sandbox-1",
        terminal_name: "Agent command",
        timed_out: true,
        backgrounded: true,
        is_running: true,
      });
      expect(
        test.coordinator.getBackgroundState(timedOut.terminal_id),
      ).toMatchObject({
        is_running: true,
        state: "running",
        output: "1\n2\n3",
      });

      const remainder = `${"line x\n".repeat(180_000)}final line\n`;
      process.emit({ type: "data", data: remainder });
      process.completionDeferred.resolve({ exitCode: 0, timedOut: false });
      await flush();

      expect(
        test.coordinator.getBackgroundState(timedOut.terminal_id),
      ).toMatchObject({
        is_running: false,
        state: "completed",
        exit_code: 0,
      });
      const retained = test.coordinator.getRetainedOutput(timedOut.terminal_id);
      expect(retained).toMatchObject({
        complete: true,
        finalized: true,
        dropped_bytes: 0,
      });
      expect(retained?.output).toBe(`1\n2\n3\n${remainder}`.trim());
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes only Sandbox channels and records recovery metadata", async () => {
    const test = harness();
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      terminal_name: "Server",
      background: true,
      sandboxSessionId: "agent-session",
    });
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      terminal_name: "Tests",
      background: true,
      sandboxSessionId: "agent-session",
    });
    test.setNow(500);

    expect(test.coordinator.closeTerminals(["Server", "Missing"])).toEqual({
      closed: 1,
      not_found: ["Missing"],
    });
    expect(test.processes[0].dispose).toHaveBeenCalledTimes(1);
    expect(test.coordinator.listTerminals()).toEqual([
      { id: "sandbox-2", name: "Tests", busy: true },
    ]);
    expect(test.coordinator.getRecentlyClosedTerminals()).toEqual([
      {
        id: "sandbox-1",
        name: "Server",
        closedAt: 500,
        is_running: false,
        state: "unknown_termination",
        exit_code: null,
        output: "",
        output_captured: true,
        output_complete: false,
        output_finalized: false,
        output_total_bytes: 0,
        output_retained_bytes: 0,
        output_dropped_bytes: 0,
        terminal_raw_output: "",
      },
    ]);
  });

  it("keeps exact multi-megabyte output retrievable after terminal close", async () => {
    const test = harness();
    await test.coordinator.executeCommand({
      command: "generate output",
      cwd: "/workspace",
      terminal_name: "Large output",
      background: true,
      sandboxSessionId: "agent-session",
    });
    const output = `${"line x\n".repeat(180_000)}final line\n`;
    await finish(test.processes[0], output);

    expect(
      test.coordinator.getBackgroundState("sandbox-1")?.output.length,
    ).toBeLessThan(output.length);
    expect(test.coordinator.closeTerminals(["sandbox-1"])).toEqual({
      closed: 1,
    });
    expect(test.coordinator.getBackgroundState("sandbox-1")).toBeUndefined();
    expect(test.coordinator.getRetainedOutput("sandbox-1")).toEqual({
      output: output.trim(),
      complete: true,
      finalized: true,
      total_bytes: Buffer.byteLength(output, "utf8"),
      retained_bytes: Buffer.byteLength(output, "utf8"),
      dropped_bytes: 0,
    });
  });

  it("fails before launch for missing sessions or mismatched authorization identity", async () => {
    const test = harness();
    await expect(
      test.coordinator.executeCommand({ command: "pwd", cwd: "/workspace" }),
    ).rejects.toThrow("owning AgentLink session ID");
    const authorize = vi
      .mocked(test.authorizer.authorize)
      .getMockImplementation()!;
    vi.mocked(test.authorizer.authorize).mockImplementationOnce(
      async (input) => {
        const authorized = await authorize(input);
        return {
          ...authorized,
          helperRequest: { ...authorized.helperRequest, commandId: "wrong" },
        };
      },
    );
    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("mismatched command identity");
    expect(test.runtime.launch).not.toHaveBeenCalled();
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
  });

  it("finalizes authorization when runtime launch fails synchronously", async () => {
    const test = harness();
    vi.mocked(test.runtime.launch).mockImplementationOnce(() => {
      throw new Error("helper unavailable");
    });

    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("helper unavailable");
    expect(test.authorizedFinalizer).toHaveBeenCalledTimes(1);
  });

  it("disposes runtime and active commands exactly once", async () => {
    const test = harness();
    await test.coordinator.executeCommand({
      command: "sleep 10",
      cwd: "/workspace",
      background: true,
      sandboxSessionId: "agent-session",
    });
    test.coordinator.dispose();
    test.coordinator.dispose();
    expect(test.processes[0].dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.dispose).toHaveBeenCalledTimes(1);
    await expect(
      test.coordinator.executeCommand({
        command: "pwd",
        cwd: "/workspace",
        sandboxSessionId: "agent-session",
      }),
    ).rejects.toThrow("coordinator is disposed");
  });
});
