import { describe, expect, it } from "vitest";
import {
  runAgentSessionRepositoryContract,
  runAgentTurnLeaseProviderContract,
} from "./hostAdapterContracts.js";

import { InMemoryAgentStateRepository } from "./sessionRepository.js";
import { InMemoryAgentTurnLeaseProvider } from "./turnLeases.js";

const PRINCIPAL = { tenantId: "tenant-a", subjectId: "subject-a" };
const OTHER_PRINCIPAL = { tenantId: "tenant-a", subjectId: "subject-b" };

describe("reusable E6 host-adapter contracts", () => {
  it("accepts the in-memory session repository", async () => {
    let id = 0;
    await expect(
      runAgentSessionRepositoryContract({
        repository: new InMemoryAgentStateRepository(),
        principal: PRINCIPAL,
        otherPrincipal: OTHER_PRINCIPAL,
        createSessionId: (label) => `${label}-${++id}`,
        now: () => 100,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts the in-memory distributed lease provider", async () => {
    let now = 100;
    let id = 0;
    const provider = new InMemoryAgentTurnLeaseProvider({
      now: () => now,
      createLeaseId: () => `lease-${++id}`,
    });
    await expect(
      runAgentTurnLeaseProviderContract({
        provider,
        principal: PRINCIPAL,
        otherPrincipal: OTHER_PRINCIPAL,
        createSessionId: (label) => `${label}-${++id}`,
        advanceTime(milliseconds) {
          now += milliseconds;
        },
      }),
    ).resolves.toBeUndefined();
  });
});
