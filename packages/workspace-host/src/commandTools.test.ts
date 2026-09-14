import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createWorkspaceCommandTools,
  type WorkspaceCommandApprovalDisplay,
} from "./commandTools.js";
import { WorkspaceCommandSupervisor } from "./commandSupervisor.js";
import { WorkspaceMutationCoordinator } from "./mutationCoordinator.js";

async function fixture(
  environment: NodeJS.ProcessEnv = { SECRET: "hidden" },
  options: {
    requiresApproval?: boolean;
    backgroundOwnerSessionId?: string;
  } = {},
) {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "workspace-command-tools-"),
  );
  const projectRoot = path.join(parent, "project");
  const stateDirectory = path.join(parent, "state");
  await fs.mkdir(projectRoot);
  const supervisor = await WorkspaceCommandSupervisor.create({
    stateDirectory,
    ownerId: "owner-a",
    terminationGraceMs: 50,
  });
  const tools = await createWorkspaceCommandTools({
    projectRoot,
    ownerId: "owner-a",
    supervisor,
    mutations: new WorkspaceMutationCoordinator(),
    stateDirectory,
    shellExecutable: "/bin/zsh",
    environmentDigestSecret: "test-environment-digest-secret",
    resolveEnvironment: () => environment,
    requiresApproval: () => options.requiresApproval === true,
    resolveBackgroundOwnerSessionId: () => options.backgroundOwnerSessionId,
  });
  const request = {
    principal: { tenantId: "local", subjectId: "project" },
    sessionId: "session-a",
    turnId: "turn-a",
    input: { text: "run it", attachments: undefined },
  } as const;
  return { parent, projectRoot, stateDirectory, supervisor, tools, request };
}

describe("workspace command tools", () => {
  it("prepares an exact private launch and a redacted approval display", async () => {
    const test = await fixture();
    try {
      const result = await test.tools.authorizeToolCall({
        ...test.request,
        model: {
          model: { providerId: "fixture", modelId: "fixture" },
          source: "turn",
        },
        toolCallId: "call-1",
        toolName: "execute_command",
        input: { command: "printf ok", cwd: "." },
        effect: "write",
      });
      expect(result).toMatchObject({
        decision: "require_user",
        displayContent: {
          kind: "command_launch",
          command: "printf ok",
          executable: "/bin/zsh",
          args: ["-c", "printf ok"],
          cwd: test.projectRoot,
          environmentKeys: ["PATH", "PWD", "SECRET"],
          unsandboxed: true,
        },
        preparedInput: {
          launch: {
            ownerId: "owner-a",
            sessionId: "session-a",
            turnId: "turn-a",
            environmentKeys: ["PATH", "PWD", "SECRET"],
            environmentDigest: expect.any(String),
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("hidden");
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("persists exact allow and forbidden rules with forbidden precedence", async () => {
    const test = await fixture();
    try {
      await test.tools.addRule({
        command: "printf ok",
        cwd: test.projectRoot,
        mode: "foreground",
        decision: "allow",
      });
      await test.tools.addRule({
        command: "printf blocked",
        cwd: test.projectRoot,
        mode: "foreground",
        decision: "forbidden",
      });
      const authorize = (command: string) =>
        test.tools.authorizeToolCall({
          ...test.request,
          model: {
            model: { providerId: "fixture", modelId: "fixture" },
            source: "turn",
          },
          toolCallId: `call-${command}`,
          toolName: "execute_command",
          input: { command },
          effect: "write",
        });
      await expect(authorize("printf ok")).resolves.toMatchObject({
        decision: "allow",
      });
      await expect(authorize("printf blocked")).resolves.toEqual({
        decision: "deny",
        reason: "Command forbidden by an explicit rule",
      });
      expect(test.tools.listRules()).toHaveLength(2);
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("forces child approval despite an allow rule and assigns child background processes to the parent", async () => {
    const test = await fixture(
      { SECRET: "hidden" },
      {
        requiresApproval: true,
        backgroundOwnerSessionId: "parent-session",
      },
    );
    try {
      await test.tools.addRule({
        command: "printf ok",
        cwd: test.projectRoot,
        mode: "foreground",
        decision: "allow",
      });
      await expect(
        test.tools.authorizeToolCall({
          ...test.request,
          model: {
            model: { providerId: "fixture", modelId: "fixture" },
            source: "turn",
          },
          toolCallId: "call-child-foreground",
          toolName: "execute_command",
          input: { command: "printf ok" },
          effect: "write",
        }),
      ).resolves.toMatchObject({ decision: "require_user" });

      const background = await test.tools.authorizeToolCall({
        ...test.request,
        model: {
          model: { providerId: "fixture", modelId: "fixture" },
          source: "turn",
        },
        toolCallId: "call-child-background",
        toolName: "execute_command",
        input: { command: "npm run dev", background: true },
        effect: "write",
      });
      expect(background).toMatchObject({
        decision: "require_user",
        preparedInput: {
          launch: { sessionId: "parent-session", mode: "background" },
        },
      });
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("always prompts for the background concurrent-editing exception", async () => {
    const test = await fixture();
    try {
      await test.tools.addRule({
        command: "npm run dev",
        cwd: test.projectRoot,
        mode: "background",
        decision: "allow",
      });
      const result = await test.tools.authorizeToolCall({
        ...test.request,
        model: {
          model: { providerId: "fixture", modelId: "fixture" },
          source: "turn",
        },
        toolCallId: "call-dev",
        toolName: "execute_command",
        input: { command: "npm run dev", background: true },
        effect: "write",
      });
      expect(result).toMatchObject({
        decision: "require_user",
        displayContent: {
          mode: "background",
          concurrentEditingWarning: true,
          ruleDecision: "allow",
        },
      });
      if (result.decision !== "require_user")
        throw new Error("Expected approval");
      const prepared = result.preparedInput?.launch as { commandId?: string };
      expect(
        test.tools.consumeBackgroundAcknowledgement(prepared.commandId!),
      ).toBe(false);
      test.tools.acknowledgeBackgroundLaunch(prepared.commandId!);
      expect(
        test.tools.consumeBackgroundAcknowledgement(prepared.commandId!),
      ).toBe(true);
      expect(
        test.tools.consumeBackgroundAcknowledgement(prepared.commandId!),
      ).toBe(false);
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });

  it("invalidates a prepared launch when policy changes", async () => {
    const test = await fixture();
    try {
      const authorization = await test.tools.authorizeToolCall({
        ...test.request,
        model: {
          model: { providerId: "fixture", modelId: "fixture" },
          source: "turn",
        },
        toolCallId: "call-1",
        toolName: "execute_command",
        input: { command: "printf ok" },
        effect: "write",
      });
      if (authorization.decision !== "require_user") {
        throw new Error("Expected approval");
      }
      await test.tools.addRule({
        command: "other",
        cwd: test.projectRoot,
        mode: "foreground",
        decision: "prompt",
      });
      await expect(
        test.tools.validatePendingLaunch({
          principal: test.request.principal,
          sessionId: test.request.sessionId,
          turnId: test.request.turnId,
          toolName: "execute_command",
          input: authorization.preparedInput!,
          displayContent:
            authorization.displayContent as WorkspaceCommandApprovalDisplay,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "Command rules or shell configuration changed",
      });
    } finally {
      await test.supervisor.close();
      await fs.rm(test.parent, { recursive: true, force: true });
    }
  });
});
