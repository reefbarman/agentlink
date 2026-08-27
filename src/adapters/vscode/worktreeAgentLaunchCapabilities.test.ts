import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVscodeWorktreeAgentLaunchProvider } from "./worktreeAgentLaunchCapabilities.js";

const { handleStartWorktreeAgent } = vi.hoisted(() => ({
  handleStartWorktreeAgent: vi.fn(),
}));

vi.mock("../../tools/startWorktreeAgent.js", () => ({
  handleStartWorktreeAgent,
}));

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
    const request = {
      task: "Review owner/repo#123",
      prompt: "Review the pull request",
      mode: "review",
      fetchRef: {
        repository: "owner/repo",
        ref: "refs/pull/123/head",
      },
    };

    await provider.start(request, {
      approvalDecision: "approve-prefill",
    });

    expect(handleStartWorktreeAgent).toHaveBeenCalledOnce();
    const [forwardedRequest, deps] = handleStartWorktreeAgent.mock.calls[0]!;
    expect(forwardedRequest).toBe(request);
    await expect(deps.onApprovalRequest({})).resolves.toBe("approve-prefill");
    expect(fallbackApproval).not.toHaveBeenCalled();
  });
});
