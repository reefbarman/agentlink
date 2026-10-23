import os from "node:os";

import {
  DEFAULT_SANDBOX_PRIVATE_DIRECTORY_PREFIX,
  prepareWorkspaceSandboxLaunch,
} from "@agentlink/sandbox";
import {
  validateCheckpointBSandboxCapabilityRequest,
  type ApprovedSandboxCapabilityGrant,
  type SandboxLaunchAuthorization,
} from "../../core/sandboxPolicy.js";
import type { SandboxExecutionMetadata } from "@agentlink/protocol/terminal-security";
import { SandboxCapabilityLaunchError } from "../../core/capabilities/SandboxCapabilityLaunchError.js";
import type { TerminalExecuteOptions } from "../../core/capabilities/terminal.js";
import { buildAgentExecutionEnv } from "../../process/agentExecutionPolicy.js";
import { SandboxCapabilityAuthority } from "./SandboxCapabilityAuthority.js";
import type {
  ActiveSandboxLaunch,
  PreparedSandboxLaunch,
  SandboxLaunchAuthorizer,
} from "./SandboxTerminalCoordinator.js";
import {
  SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES,
  type SandboxShellEnvironmentPolicy,
} from "./sandboxEnvironmentPolicy.js";
import { compileSandboxHelperLaunchRequest } from "./sandboxPolicyCompiler.js";
import { verifyTerminalInlineFiles } from "../inlineFileIntegrity.js";
import {
  sandboxCapabilityKind,
  sandboxCapabilityPreparationAgeBucket,
  type SandboxCapabilityGrantTiming,
  type SandboxCapabilityGrantTimingEvent,
} from "./sandboxCapabilityGrantTiming.js";

const DEFAULT_CAPABILITY_GRANT_TTL_MS = 10 * 60_000;

export interface BaselineSandboxLaunchAuthorizerOptions {
  workspaceRoots: readonly string[];
  shell?: string;
  privateDirectoryPrefix?: string;
  homeDirectory?: string;
  /** Host per-user temporary directory exposed for normal toolchain compatibility. */
  hostTemporaryDirectory?: string;
  /** Host environment used as the source for the configured shell environment policy. */
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  environmentPolicy?: SandboxShellEnvironmentPolicy;
  /** Conservative argv/environment budget used before the helper composes final argv. */
  environmentBudgetBytes?: number;
  /** Canonical validated runtime directories required by sandboxed commands. */
  trustedRuntimeRoots?: readonly string[];
  capabilityAuthority?: SandboxCapabilityAuthority;
  capabilityGrantTtlMs?: number;
  capabilityGrantTiming?: SandboxCapabilityGrantTiming;
  onCapabilityGrantTimingEvent?: (
    event: SandboxCapabilityGrantTimingEvent,
  ) => void;
  now?: () => number;
}

async function verifyInlineFiles(
  files: TerminalExecuteOptions["sandboxInlineFiles"],
) {
  // Inline file directories stay readable through the host-visible read
  // policy, so only the verified binding feeds the launch.
  return (await verifyTerminalInlineFiles(files)).binding;
}

export class BaselineSandboxLaunchAuthorizer implements SandboxLaunchAuthorizer {
  private readonly workspaceRoots: readonly string[];
  private readonly shell: string;
  private readonly privateDirectoryPrefix: string;
  private readonly homeDirectory: string;
  private readonly hostTemporaryDirectory: string;
  private readonly hostEnvironment: Readonly<
    Record<string, string | undefined>
  >;
  private readonly trustedRuntimeRoots: readonly string[];
  private readonly environmentPolicy: SandboxShellEnvironmentPolicy | undefined;
  private readonly environmentBudgetBytes: number;
  private readonly capabilityAuthority: SandboxCapabilityAuthority;
  private readonly capabilityGrantTtlMs: number;
  private readonly capabilityGrantTiming: SandboxCapabilityGrantTiming;
  private readonly onCapabilityGrantTimingEvent?: (
    event: SandboxCapabilityGrantTimingEvent,
  ) => void;
  private readonly now: () => number;

  constructor(options: BaselineSandboxLaunchAuthorizerOptions) {
    if (options.workspaceRoots.length === 0) {
      throw new Error(
        "Sandbox terminal requires at least one local workspace root",
      );
    }
    this.workspaceRoots = [...options.workspaceRoots];
    this.shell = options.shell ?? "/bin/zsh";
    this.privateDirectoryPrefix =
      options.privateDirectoryPrefix ??
      DEFAULT_SANDBOX_PRIVATE_DIRECTORY_PREFIX;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.hostTemporaryDirectory = options.hostTemporaryDirectory ?? os.tmpdir();
    this.hostEnvironment = { ...(options.hostEnvironment ?? process.env) };
    this.environmentPolicy = options.environmentPolicy
      ? {
          ...options.environmentPolicy,
          exclude: [...(options.environmentPolicy.exclude ?? [])],
          set: { ...options.environmentPolicy.set },
          includeOnly: [...(options.environmentPolicy.includeOnly ?? [])],
        }
      : undefined;
    this.environmentBudgetBytes =
      options.environmentBudgetBytes ?? SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES;
    if (
      !Number.isSafeInteger(this.environmentBudgetBytes) ||
      this.environmentBudgetBytes <= 0
    ) {
      throw new Error("Sandbox environment budget must be a positive integer");
    }
    this.trustedRuntimeRoots = [...(options.trustedRuntimeRoots ?? [])];
    this.capabilityAuthority =
      options.capabilityAuthority ?? new SandboxCapabilityAuthority();
    this.capabilityGrantTtlMs =
      options.capabilityGrantTtlMs ?? DEFAULT_CAPABILITY_GRANT_TTL_MS;
    if (
      !Number.isFinite(this.capabilityGrantTtlMs) ||
      this.capabilityGrantTtlMs <= 0
    ) {
      throw new Error("Sandbox capability grant TTL must be positive");
    }
    this.capabilityGrantTiming = options.capabilityGrantTiming ?? "launch";
    this.onCapabilityGrantTimingEvent = options.onCapabilityGrantTimingEvent;
    this.now = options.now ?? Date.now;
  }

  async authorize({
    options,
    channelId,
    commandId,
    generation,
    dimensions,
  }: Parameters<
    SandboxLaunchAuthorizer["authorize"]
  >[0]): Promise<PreparedSandboxLaunch> {
    const preparedAt = this.now();
    if (!options.sandboxSessionId) {
      throw new Error("Sandbox launch requires an owning AgentLink session ID");
    }
    const capability = validateCheckpointBSandboxCapabilityRequest(
      options.sandboxCapabilityRequest,
    );
    if (!capability.ok) {
      throw new Error(
        `Unsupported sandbox capabilities: ${capability.fields.join(", ")}`,
      );
    }

    const prepared = await prepareWorkspaceSandboxLaunch({
      workspaceRoots: this.workspaceRoots,
      cwd: options.cwd,
      command: options.command,
      sessionId: options.sandboxSessionId,
      capability: {
        publicNetwork: capability.publicNetwork,
        localBinding: capability.localBinding,
      },
      explicitEnvironment: options.env,
      hostEnvironment: this.hostEnvironment,
      agentEnvironment: buildAgentExecutionEnv(),
      environmentPolicy: this.environmentPolicy,
      environmentBudgetBytes: this.environmentBudgetBytes,
      homeDirectory: this.homeDirectory,
      hostTemporaryDirectory: this.hostTemporaryDirectory,
      privateDirectoryPrefix: this.privateDirectoryPrefix,
      trustedRuntimeRoots: this.trustedRuntimeRoots,
      temporaryHome: options.temporaryHome === true,
      verifyInlineFiles: () => verifyInlineFiles(options.sandboxInlineFiles),
    });
    const {
      cwd,
      directories,
      binding,
      bindingDigest,
      hasCapability,
      authorization,
      metadata,
    } = prepared;
    try {
      const identity = Object.freeze({ channelId, commandId, generation });
      const compile = (activeAuthorization: SandboxLaunchAuthorization) =>
        compileSandboxHelperLaunchRequest({
          channelId,
          commandId,
          generation,
          command: options.command,
          cwd,
          shell: this.shell,
          dimensions: { ...dimensions },
          authorization: activeAuthorization,
        });
      let activeGrantId: string | undefined;
      let finalized = false;
      let activated = false;
      const timingEvent = (
        type: SandboxCapabilityGrantTimingEvent["type"],
        reason?: SandboxCapabilityGrantTimingEvent["reason"],
      ) => {
        if (!hasCapability) return;
        const ageMs = Math.max(0, this.now() - preparedAt);
        this.onCapabilityGrantTimingEvent?.({
          type,
          timing: this.capabilityGrantTiming,
          capability: sandboxCapabilityKind(capability),
          preparationAgeBucket: sandboxCapabilityPreparationAgeBucket(ageMs),
          exceededLegacyTtl: ageMs >= this.capabilityGrantTtlMs,
          ...(reason ? { reason } : {}),
        });
      };
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        if (activeGrantId && this.capabilityAuthority.revoke(activeGrantId)) {
          timingEvent("revoked");
        }
        directories.cleanup();
      };
      const activeMetadata = (
        grant: ApprovedSandboxCapabilityGrant | undefined,
      ): SandboxExecutionMetadata => ({
        ...metadata,
        capabilities: {
          ...metadata.capabilities,
          warnings: [...metadata.capabilities.warnings],
        },
        ...(metadata.environmentPolicy
          ? {
              environmentPolicy: {
                ...metadata.environmentPolicy,
                exclude: [...metadata.environmentPolicy.exclude],
                includeOnly: [...metadata.environmentPolicy.includeOnly],
                setKeys: [...metadata.environmentPolicy.setKeys],
              },
            }
          : {}),
        ...(metadata.environmentBudget
          ? {
              environmentBudget: {
                ...metadata.environmentBudget,
                dropped: metadata.environmentBudget.dropped.map((entry) => ({
                  ...entry,
                })),
              },
            }
          : {}),
        ...(metadata.capabilityRequest
          ? { capabilityRequest: { ...metadata.capabilityRequest } }
          : {}),
        ...(grant
          ? {
              grantTiming: this.capabilityGrantTiming,
              grant: { grantId: grant.grantId, auditId: grant.auditId },
            }
          : {}),
      });
      const activateGrant = () => {
        let grant: ApprovedSandboxCapabilityGrant;
        try {
          const issued = this.capabilityAuthority.issueCapabilityGrant({
            binding,
            expiresAt: this.now() + this.capabilityGrantTtlMs,
          });
          activeGrantId = issued.grant.grantId;
          const consumed = this.capabilityAuthority.consume(
            issued.handle,
            binding,
          );
          if (!consumed.ok) {
            throw new SandboxCapabilityLaunchError(consumed.reason);
          }
          grant = consumed.grant;
        } catch (error) {
          const failure =
            error instanceof SandboxCapabilityLaunchError
              ? error
              : new SandboxCapabilityLaunchError("issue_failed", {
                  cause: error,
                });
          timingEvent("activation_failed", failure.reason);
          finalize();
          throw failure;
        }
        const activeAuthorization = { ...authorization, grant };
        try {
          const helperRequest = compile(activeAuthorization);
          const assertLaunchValid = () => {
            const validation = this.capabilityAuthority.validateConsumed(
              grant.grantId,
              binding,
            );
            if (!validation.ok) {
              throw new SandboxCapabilityLaunchError(validation.reason);
            }
          };
          assertLaunchValid();
          timingEvent("activated");
          return {
            helperRequest,
            metadata: activeMetadata(grant),
            assertLaunchValid,
          };
        } catch (error) {
          const failure =
            error instanceof SandboxCapabilityLaunchError
              ? error
              : new SandboxCapabilityLaunchError("compile_failed", {
                  cause: error,
                });
          timingEvent("activation_failed", failure.reason);
          finalize();
          throw failure;
        }
      };
      let cachedActive: ActiveSandboxLaunch | undefined = !hasCapability
        ? {
            helperRequest: compile(authorization),
            metadata: activeMetadata(undefined),
          }
        : this.capabilityGrantTiming === "preparation"
          ? activateGrant()
          : undefined;
      const preparedMetadata = cachedActive?.metadata ?? metadata;
      return {
        identity,
        policy: {
          ...authorization.policy,
          readableRoots: [...authorization.policy.readableRoots],
          writableRoots: [...authorization.policy.writableRoots],
          deniedRoots: [...authorization.policy.deniedRoots],
          deniedWriteRoots: [...(authorization.policy.deniedWriteRoots ?? [])],
          protectedReadOnlyRoots: [
            ...authorization.policy.protectedReadOnlyRoots,
          ],
          structurallyProtectedRoots: [
            ...(authorization.policy.structurallyProtectedRoots ?? []),
          ],
          network: { ...authorization.policy.network },
          environment: {
            inheritHost: false,
            values: { ...authorization.policy.environment.values },
            ...(authorization.policy.environment.summary
              ? {
                  summary: {
                    ...authorization.policy.environment.summary,
                    exclude: [
                      ...authorization.policy.environment.summary.exclude,
                    ],
                    includeOnly: [
                      ...authorization.policy.environment.summary.includeOnly,
                    ],
                    setKeys: [
                      ...authorization.policy.environment.summary.setKeys,
                    ],
                  },
                }
              : {}),
          },
          allowedUnixSockets: [...authorization.policy.allowedUnixSockets],
        },
        bindingDigest,
        metadata: preparedMetadata,
        activate: () => {
          if (activated || finalized) {
            throw new Error("Prepared sandbox launch is no longer available");
          }
          activated = true;
          if (!cachedActive) cachedActive = activateGrant();
          if (cachedActive.assertLaunchValid) {
            try {
              cachedActive.assertLaunchValid();
            } catch (error) {
              const failure =
                error instanceof SandboxCapabilityLaunchError
                  ? error
                  : new SandboxCapabilityLaunchError("issue_failed", {
                      cause: error,
                    });
              timingEvent("activation_failed", failure.reason);
              finalize();
              throw failure;
            }
          }
          return cachedActive;
        },
        finalize,
      };
    } catch (error) {
      directories.cleanup();
      throw error;
    }
  }
}
