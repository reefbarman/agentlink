import type { CommandApprovalPolicy } from "../approvals/commandApprovalPolicy.js";

export type AgentWriteApprovalSelection =
  | "prompt"
  | "session"
  | "project"
  | "global";

export interface SessionApprovalPolicyHost {
  getCommandApprovalPolicy(
    sessionId: string,
    fallback: CommandApprovalPolicy,
  ): CommandApprovalPolicy;
  setCommandApprovalPolicy(
    sessionId: string,
    policy: CommandApprovalPolicy,
  ): void;
  getAgentWriteApprovalState(sessionId: string): AgentWriteApprovalSelection;
  setAgentWriteApprovalSelection(
    sessionId: string,
    selection: AgentWriteApprovalSelection,
    targetPath?: string,
  ): boolean;
  resetSessionAgentWriteApproval(sessionId: string): void;
}

export interface SessionApprovalPolicyTransitionResult {
  ok: boolean;
  commandApprovalPolicy: CommandApprovalPolicy;
  agentWriteApproval: AgentWriteApprovalSelection;
}

export class SessionApprovalPolicyCoordinator {
  constructor(private readonly host: SessionApprovalPolicyHost) {}

  setCommandApprovalPolicy(
    sessionId: string,
    policy: CommandApprovalPolicy,
    configuredFallback: Exclude<CommandApprovalPolicy, "approve-for-me">,
    targetPath?: string,
  ): SessionApprovalPolicyTransitionResult {
    const previousPolicy = this.host.getCommandApprovalPolicy(
      sessionId,
      configuredFallback,
    );
    const previousWriteApproval =
      this.host.getAgentWriteApprovalState(sessionId);

    if (policy === "approve-for-me" && previousWriteApproval === "prompt") {
      const writeUpdated = this.host.setAgentWriteApprovalSelection(
        sessionId,
        "session",
        targetPath,
      );
      if (!writeUpdated) {
        return this.snapshot(sessionId, configuredFallback, false);
      }
    }

    this.host.setCommandApprovalPolicy(sessionId, policy);

    if (
      previousPolicy === "approve-for-me" &&
      policy !== "approve-for-me" &&
      previousWriteApproval === "session"
    ) {
      this.host.resetSessionAgentWriteApproval(sessionId);
    }

    return this.snapshot(sessionId, configuredFallback, true);
  }

  setWriteApproval(
    sessionId: string,
    selection: AgentWriteApprovalSelection,
    configuredFallback: Exclude<CommandApprovalPolicy, "approve-for-me">,
    targetPath?: string,
  ): SessionApprovalPolicyTransitionResult {
    const writeUpdated = this.host.setAgentWriteApprovalSelection(
      sessionId,
      selection,
      targetPath,
    );

    if (
      selection === "prompt" &&
      this.host.getCommandApprovalPolicy(sessionId, configuredFallback) ===
        "approve-for-me"
    ) {
      this.host.setCommandApprovalPolicy(sessionId, configuredFallback);
    }

    return this.snapshot(sessionId, configuredFallback, writeUpdated);
  }

  reconcileAfterModeSwitch(
    sessionId: string,
    configuredFallback: Exclude<CommandApprovalPolicy, "approve-for-me">,
  ): SessionApprovalPolicyTransitionResult {
    if (
      this.host.getCommandApprovalPolicy(sessionId, configuredFallback) !==
      "approve-for-me"
    ) {
      this.host.resetSessionAgentWriteApproval(sessionId);
    }
    return this.snapshot(sessionId, configuredFallback, true);
  }

  reconcileRestoredSession(
    sessionId: string,
    configuredFallback: Exclude<CommandApprovalPolicy, "approve-for-me">,
    targetPath?: string,
  ): SessionApprovalPolicyTransitionResult {
    const policy = this.host.getCommandApprovalPolicy(
      sessionId,
      configuredFallback,
    );
    const writeApproval = this.host.getAgentWriteApprovalState(sessionId);
    if (policy !== "approve-for-me" || writeApproval !== "prompt") {
      return this.snapshot(sessionId, configuredFallback, true);
    }

    const writeUpdated = this.host.setAgentWriteApprovalSelection(
      sessionId,
      "session",
      targetPath,
    );
    if (!writeUpdated) {
      this.host.setCommandApprovalPolicy(sessionId, configuredFallback);
      return this.snapshot(sessionId, configuredFallback, false);
    }
    return this.snapshot(sessionId, configuredFallback, true);
  }

  private snapshot(
    sessionId: string,
    configuredFallback: Exclude<CommandApprovalPolicy, "approve-for-me">,
    ok: boolean,
  ): SessionApprovalPolicyTransitionResult {
    return {
      ok,
      commandApprovalPolicy: this.host.getCommandApprovalPolicy(
        sessionId,
        configuredFallback,
      ),
      agentWriteApproval: this.host.getAgentWriteApprovalState(sessionId),
    };
  }
}
