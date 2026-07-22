import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleStartWorktreeAgent } = vi.hoisted(() => ({
  handleStartWorktreeAgent: vi.fn(),
}));

vi.mock("../../tools/startWorktreeAgent.js", () => ({
  handleStartWorktreeAgent,
}));

import { createVscodeWorktreeAgentLaunchProvider } from "./worktreeAgentLaunchCapabilities.js";

describe("createVscodeWorktreeAgentLaunchProvider", () => {
  beforeEach(() => {
    handleStartWorktreeAgent.mockReset();
    handleStartWorktreeAgent.mockResolvedValue({ content: [] });
  });

  it("uses an explicit shelf decision instead of opening another approval", async () => {
    const fallbackApproval = vi.fn();
    const provider = createVscodeWorktreeAgentLaunchProvider({
      globalStorageUri: { fsPath: "/tmp/global" } as never,
      onApprovalRequest: fallbackApproval,
      sessionId: "foreground",
    });
    const request = { task: "Reliability", prompt: "Inspect reliability" };

    await provider.start(request, {
      approvalDecision: "approve-prefill",
    });

    expect(handleStartWorktreeAgent).toHaveBeenCalledOnce();
    const [, deps] = handleStartWorktreeAgent.mock.calls[0]!;
    await expect(deps.onApprovalRequest({})).resolves.toBe("approve-prefill");
    expect(fallbackApproval).not.toHaveBeenCalled();
  });
});
