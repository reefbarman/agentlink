import { describe, expect, it } from "vitest";

import { InMemoryAgentStateRepository } from "./sessionRepository.js";
import { InMemoryAgentTurnLeaseProvider } from "./turnLeases.js";
import { runHostApprovalContract } from "./hostApprovalTestKit.js";

describe("host approval test kit", () => {
  it("verifies allow, deny, replay, revision, restart, and principal isolation", async () => {
    const state = new InMemoryAgentStateRepository();
    const leases = new InMemoryAgentTurnLeaseProvider();
    let id = 0;

    await expect(
      runHostApprovalContract({
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        otherPrincipal: { tenantId: "tenant-a", subjectId: "subject-b" },
        createPersistence: () => ({
          sessions: state,
          interactions: state,
          turnLeases: leases,
        }),
        createSessionId: (label) => `${label}-${++id}`,
        now: () => 100,
      }),
    ).resolves.toEqual({
      allowedWriteCount: 1,
      deniedWriteCount: 0,
      replayRejected: true,
      revisionTamperingRejected: true,
      principalIsolation: true,
      restartResume: true,
    });
  });
});
