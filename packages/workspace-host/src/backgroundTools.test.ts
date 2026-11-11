import type {
  HostToolExecutionContext,
  HostToolResolveRequest,
} from "@agentlink/core";
import {
  REASONING_EFFORT_PROPERTY,
  parseBackgroundReasoningEffortInput,
} from "@agentlink/core/background-agent-tools";
import type {
  WorkspaceBackgroundRecord,
  WorkspaceBackgroundSupervisor,
} from "./backgroundSupervisor.js";
import { expect, it, vi } from "vitest";

import { createWorkspaceBackgroundTools } from "./backgroundTools.js";

it("uses the shared reasoning effort contract and forwards canonical or legacy input", async () => {
  expect(REASONING_EFFORT_PROPERTY.enum).toContain("ultra");
  expect(parseBackgroundReasoningEffortInput(undefined)).toBeUndefined();
  expect(() => parseBackgroundReasoningEffortInput("unsupported")).toThrow(
    "Invalid reasoningEffort",
  );

  for (const [input, effort] of [
    [{ reasoningEffort: "ultra" }, "ultra"],
    [{ reasoning_effort: "max" }, "max"],
    [{ reasoningEffort: "medium", reasoning_effort: "medium" }, "medium"],
    [{ reasoningEffort: "medium", reasoning_effort: "high" }, "conflict"],
    [{}, undefined],
  ] as const) {
    const spawn = vi.fn(
      async () =>
        ({
          childSessionId: "child-1",
          task: "Inspect",
          scopes: [],
          lifecycle: "queued",
          resultState: "running",
          phase: "queued",
          steeringQueued: 0,
        }) as WorkspaceBackgroundRecord,
    );
    const supervisor = {
      activeChildLimit: 2,
      spawn,
    } as unknown as WorkspaceBackgroundSupervisor;
    const [tool] = createWorkspaceBackgroundTools({
      supervisor,
      isForegroundSession: () => true,
    }).resolveTools({
      principal: {} as HostToolResolveRequest["principal"],
      sessionId: "parent-1",
      turnId: "turn-1",
      input: {},
    });
    const context = {
      principal: {},
      sessionId: "parent-1",
      turnId: "turn-1",
      model: {},
      signal: undefined,
    } as HostToolExecutionContext;

    const result = await tool!.execute(
      { task: "Inspect", message: "Inspect", ...input },
      context,
    );

    if (effort === "conflict") {
      expect(result.isError).toBe(true);
      expect(result.modelContent).toBe("conflicting_reasoning_effort_aliases");
      expect(spawn).not.toHaveBeenCalled();
      continue;
    }
    expect(result.isError).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining(
        effort === undefined
          ? { task: "Inspect", message: "Inspect" }
          : { reasoningEffort: effort },
      ),
    );
    if (effort === undefined) {
      expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    }
  }
});
