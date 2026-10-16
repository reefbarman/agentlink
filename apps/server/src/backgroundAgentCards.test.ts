import {
  agentApprovalRequest,
  parseAgentApprovalId,
  toAgentCard,
} from "./backgroundAgentCards.js";
import { describe, expect, it } from "vitest";

import type { WorkspaceBackgroundRecord } from "@agentlink/workspace-host";

const record = (
  patch: Partial<WorkspaceBackgroundRecord> = {},
): WorkspaceBackgroundRecord =>
  ({
    schemaVersion: 1,
    childSessionId: "child-1",
    parentSessionId: "ws-1",
    parentTurnId: "turn-1",
    rootSessionId: "ws-1",
    projectId: "home",
    depth: 1,
    task: "Review",
    scopes: [],
    lifecycle: "running",
    phase: "responding",
    resultState: "running",
    createdAt: 1,
    updatedAt: 2,
    steeringQueued: 0,
    ...patch,
  }) as WorkspaceBackgroundRecord;

describe("toAgentCard", () => {
  it("maps each lifecycle to the fleet card status", () => {
    expect(toAgentCard(record({ lifecycle: "queued" })).status).toBe("queued");
    expect(toAgentCard(record()).status).toBe("streaming");
    expect(toAgentCard(record({ currentTool: "read_file" })).status).toBe(
      "tool_executing",
    );
    expect(
      toAgentCard(record({ lifecycle: "awaiting_approval" })),
    ).toMatchObject({
      status: "awaiting_approval",
      lifecycle: "running",
      attention: "approval",
      canSteer: false,
      canKill: true,
    });
    expect(toAgentCard(record({ lifecycle: "completed" }))).toMatchObject({
      status: "idle",
      canSteer: false,
      canKill: false,
    });
    expect(toAgentCard(record({ lifecycle: "cancelled" })).status).toBe(
      "cancelled",
    );
    expect(
      toAgentCard(
        record({ lifecycle: "failed", terminalReason: "provider_error" }),
      ),
    ).toMatchObject({ status: "error", errorMessage: "provider_error" });
  });

  it("previews the tail of the output and keeps the model", () => {
    const card = toAgentCard(
      record({
        partialOutput: `${"x".repeat(600)}end`,
        model: { providerId: "claude", modelId: "opus" },
        currentTool: "grep",
      }),
    );
    expect(card.streamingText).toHaveLength(500);
    expect(card.streamingText?.endsWith("end")).toBe(true);
    expect(card).toMatchObject({
      resolvedModel: "opus",
      resolvedProvider: "claude",
      currentTool: "grep",
    });
    // A finished agent's result replaces the preview.
    expect(
      toAgentCard(
        record({
          lifecycle: "completed",
          resultText: "All good",
          currentTool: "grep",
        }),
      ),
    ).toMatchObject({ streamingText: "All good" });
    expect(
      toAgentCard(record({ lifecycle: "completed", currentTool: "grep" }))
        .currentTool,
    ).toBeUndefined();
  });
});

describe("agent approvals", () => {
  it("builds an attributed approval card and parses its ID back", () => {
    expect(agentApprovalRequest([record()])).toBeNull();
    const request = agentApprovalRequest([
      record({ childSessionId: "idle", lifecycle: "completed" }),
      record({
        lifecycle: "awaiting_approval",
        approval: {
          interactionId: "int:1",
          source: "durable_interaction",
          toolName: "execute_command",
          summary: "Run npm test",
          displayContent: { command: "npm test" },
          createdAt: 3,
        },
      }),
    ]);
    expect(request).toMatchObject({
      id: "agent-approval:child-1:int:1",
      backgroundTask: "Review",
      filePath: "Run npm test",
    });
    expect(request?.detail).toContain('"command": "npm test"');
    expect(parseAgentApprovalId(request!.id)).toEqual({
      childSessionId: "child-1",
      interactionId: "int:1",
    });
    expect(parseAgentApprovalId("approval-1")).toBeNull();
    expect(parseAgentApprovalId("agent-approval:child-1:")).toBeNull();
  });
});
