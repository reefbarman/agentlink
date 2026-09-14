import { describe, expect, it, vi } from "vitest";

import type { AgentTurnResult } from "@agentlink/core";
import { WorkspaceBackgroundSupervisor } from "./backgroundSupervisor.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function completed(sessionId: string, text: string): AgentTurnResult {
  return {
    status: "completed",
    sessionId,
    turnId: `turn-${sessionId}`,
    sessionRevision: "revision-1",
    execution: {
      limits: {
        maxModelCalls: 0,
        maxToolCalls: 0,
        maxElapsedMs: 0,
        maxToolResultBytes: 0,
      },
      modelCalls: 1,
      toolCalls: 0,
      elapsedMs: 1,
      toolResultBytes: 0,
    },
    provenance: { requestedModel: undefined, resolvedModel: null },
    text,
    stopReason: "end_turn",
    usage: undefined,
  };
}

function suspended(sessionId: string): AgentTurnResult {
  return {
    status: "suspended",
    sessionId,
    turnId: `turn-${sessionId}`,
    sessionRevision: "revision-1",
    execution: {
      limits: {
        maxModelCalls: 0,
        maxToolCalls: 0,
        maxElapsedMs: 0,
        maxToolResultBytes: 0,
      },
      modelCalls: 1,
      toolCalls: 1,
      elapsedMs: 1,
      toolResultBytes: 0,
    },
    provenance: { requestedModel: undefined, resolvedModel: null },
    interaction: {
      interactionId: `approval-${sessionId}`,
      kind: "tool_authorization",
      summary: "Approve child write",
      toolCallId: "call-1",
      toolName: "write_file",
      effect: "write",
      displayContent: { kind: "file_write", path: "src/a.ts" },
    },
  };
}

async function fixture(
  options: {
    runTurn?: (
      sessionId: string,
      message: string,
      signal: AbortSignal,
    ) => Promise<AgentTurnResult>;
    resumeInteraction?: (
      sessionId: string,
      decision: "allow" | "deny",
    ) => Promise<AgentTurnResult>;
  } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "background-supervisor-"),
  );
  const projectRoot = path.join(root, "project");
  const stateDirectory = path.join(root, "state");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  let next = 0;
  const cancelSession = vi.fn(async () => undefined);
  const supervisor = await WorkspaceBackgroundSupervisor.create({
    stateDirectory,
    projectRoot,
    projectId: "project-a",
    createChildSession: async () => ({ sessionId: `child-${++next}` }),
    runTurn: async (sessionId, message, runOptions) =>
      options.runTurn
        ? await options.runTurn(sessionId, message, runOptions.signal)
        : completed(sessionId, message),
    resumeInteraction: async (sessionId, decision) =>
      options.resumeInteraction
        ? await options.resumeInteraction(sessionId, decision)
        : completed(sessionId, decision),
    cancelSession,
  });
  return { root, projectRoot, stateDirectory, supervisor, cancelSession };
}

function spawnRequest(pathValue: string) {
  return {
    callerSessionId: "parent-a",
    callerTurnId: "parent-turn-a",
    task: `Edit ${pathValue}`,
    message: `Work on ${pathValue}`,
    readScopes: [{ path: ".", kind: "directory" as const }],
    writeScopes: [{ path: pathValue, kind: "file" as const }],
  };
}

describe("WorkspaceBackgroundSupervisor", () => {
  it("admits two disjoint writers and rejects overlaps, capacity overflow, and grandchildren", async () => {
    const blockers = new Map<string, (result: AgentTurnResult) => void>();
    const test = await fixture({
      runTurn: (sessionId) =>
        new Promise((resolve) => {
          blockers.set(sessionId, resolve);
        }),
    });
    try {
      const first = await test.supervisor.spawn(spawnRequest("src/a.ts"));
      const second = await test.supervisor.spawn(spawnRequest("src/b.ts"));
      await expect(
        test.supervisor.spawn(spawnRequest("src/a.ts")),
      ).rejects.toThrow("background_child_capacity_reached");
      expect(test.supervisor.assertWriteAllowed("parent-a", "src/a.ts")).toBe(
        false,
      );
      expect(
        test.supervisor.assertWriteAllowed(first.childSessionId, "src/a.ts"),
      ).toBe(true);
      expect(
        test.supervisor.assertWriteAllowed(second.childSessionId, "src/a.ts"),
      ).toBe(false);
      await expect(
        test.supervisor.spawn({
          ...spawnRequest("src/c.ts"),
          callerSessionId: first.childSessionId,
        }),
      ).rejects.toThrow("background_grandchildren_not_supported");
      blockers.get(first.childSessionId)?.(
        completed(first.childSessionId, "first done"),
      );
      await expect(
        test.supervisor.wait({
          callerSessionId: "parent-a",
          childSessionId: first.childSessionId,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        test.supervisor.spawn(spawnRequest("src/b.ts")),
      ).rejects.toThrow("background_write_scope_overlap");
      blockers.get(second.childSessionId)?.(
        completed(second.childSessionId, "second done"),
      );
    } finally {
      await test.supervisor.close();
      await fs.rm(test.root, { recursive: true, force: true });
    }
  });

  it("keeps bounded waits non-cancelling, queues steering, and stops idempotently", async () => {
    let resolveRun: ((result: AgentTurnResult) => void) | undefined;
    const test = await fixture({
      runTurn: () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    });
    try {
      const child = await test.supervisor.spawn(spawnRequest("src/a.ts"));
      await expect(
        test.supervisor.wait({
          callerSessionId: "parent-a",
          childSessionId: child.childSessionId,
          timeoutMs: 5,
        }),
      ).resolves.toMatchObject({ status: "still_running" });
      expect(test.cancelSession).not.toHaveBeenCalled();
      await expect(
        test.supervisor.steer({
          callerSessionId: "parent-a",
          childSessionId: child.childSessionId,
          message: "Finish with tests",
        }),
      ).resolves.toEqual({ status: "queued" });
      const stopped = await test.supervisor.stop({
        callerSessionId: "parent-a",
        childSessionId: child.childSessionId,
        reason: "stop now",
      });
      expect(stopped).toMatchObject({
        lifecycle: "cancelled",
        resultState: "cancelled",
        terminalReason: "stop now",
      });
      await expect(
        test.supervisor.stop({
          callerSessionId: "parent-a",
          childSessionId: child.childSessionId,
        }),
      ).resolves.toMatchObject({ lifecycle: "cancelled" });
      expect(test.cancelSession).toHaveBeenCalledOnce();
      expect(
        test.supervisor.assertWriteAllowed(child.childSessionId, "src/a.ts"),
      ).toBe(false);
      resolveRun?.(completed(child.childSessionId, "late completion"));
    } finally {
      await test.supervisor.close();
      await fs.rm(test.root, { recursive: true, force: true });
    }
  });

  it("exposes one foreground approval and resumes only the exact child interaction", async () => {
    const test = await fixture({
      runTurn: async (sessionId) => suspended(sessionId),
      resumeInteraction: async (sessionId, decision) =>
        completed(sessionId, `resumed:${decision}`),
    });
    try {
      const child = await test.supervisor.spawn(spawnRequest("src/a.ts"));
      await vi.waitFor(() => {
        expect(test.supervisor.listPendingApprovals("parent-a")).toHaveLength(
          1,
        );
      });
      expect(test.supervisor.listPendingApprovals("parent-a")[0]).toMatchObject(
        {
          childSessionId: child.childSessionId,
          lifecycle: "awaiting_approval",
          approval: {
            interactionId: `approval-${child.childSessionId}`,
            toolName: "write_file",
          },
        },
      );
      await expect(
        test.supervisor.respondToApproval({
          callerSessionId: "parent-a",
          childSessionId: child.childSessionId,
          interactionId: "wrong",
          decision: "allow",
        }),
      ).rejects.toThrow("background_approval_not_current");
      await test.supervisor.respondToApproval({
        callerSessionId: "parent-a",
        childSessionId: child.childSessionId,
        interactionId: `approval-${child.childSessionId}`,
        decision: "allow",
      });
      await expect(
        test.supervisor.wait({
          callerSessionId: "parent-a",
          childSessionId: child.childSessionId,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        status: "completed",
        record: { resultText: "resumed:allow" },
      });
      expect(
        test.supervisor.result({
          callerSessionId: "parent-a",
          childSessionId: child.childSessionId,
        }),
      ).toMatchObject({ status: "completed" });
    } finally {
      await test.supervisor.close();
      await fs.rm(test.root, { recursive: true, force: true });
    }
  });

  it("marks persisted active children interrupted without replaying them", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "background-restart-"),
    );
    const projectRoot = path.join(root, "project");
    const stateDirectory = path.join(root, "state");
    await fs.mkdir(projectRoot);
    await fs.mkdir(stateDirectory);
    const record = {
      schemaVersion: 1,
      childSessionId: "child-old",
      parentSessionId: "parent-a",
      parentTurnId: "parent-turn-a",
      rootSessionId: "parent-a",
      projectId: "project-a",
      depth: 1,
      task: "Old task",
      scopes: [{ path: "src/a.ts", kind: "file", access: "read_write" }],
      lifecycle: "running",
      phase: "executing_tool",
      resultState: "running",
      createdAt: 1,
      updatedAt: 2,
      startedAt: 2,
      partialOutput: "partial evidence",
      currentTool: "write_file",
      steeringQueued: 1,
    };
    await fs.writeFile(
      path.join(stateDirectory, "background-agents.json"),
      `${JSON.stringify({
        version: 1,
        records: [record],
        steering: { "child-old": ["continue"] },
      })}\n`,
    );
    const runTurn = vi.fn(async () => completed("child-new", "unexpected"));
    const supervisor = await WorkspaceBackgroundSupervisor.create({
      stateDirectory,
      projectRoot,
      projectId: "project-a",
      createChildSession: async () => ({ sessionId: "child-new" }),
      runTurn: async () => await runTurn(),
      resumeInteraction: async () => completed("child-new", "unexpected"),
      cancelSession: async () => undefined,
    });
    try {
      expect(
        supervisor.status({
          callerSessionId: "parent-a",
          childSessionId: "child-old",
        }),
      ).toMatchObject({
        lifecycle: "interrupted",
        resultState: "interrupted",
        terminalReason: "host_restarted_during_run",
        partialOutput: "partial evidence",
        approval: undefined,
        currentTool: undefined,
        steeringQueued: 0,
      });
      expect(runTurn).not.toHaveBeenCalled();
    } finally {
      await supervisor.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
