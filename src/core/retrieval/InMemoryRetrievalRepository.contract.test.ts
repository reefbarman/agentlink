import { InMemoryRetrievalRepository } from "./InMemoryRetrievalRepository.js";
import type { RetrievalSourceFreshness } from "@agentlink/protocol/retrieval-query";
import { describeRetrievalRepositoryContract } from "../../test/retrievalRepositoryContract.js";

describeRetrievalRepositoryContract("InMemoryRetrievalRepository", () => {
  const freshness = new Map<string, RetrievalSourceFreshness>();
  const repository = new InMemoryRetrievalRepository({
    freshnessVerifier: {
      verify: async (source) =>
        freshness.get(source.id) ?? { status: "current" },
    },
  });
  return {
    repository,
    controller: {
      setSourceFreshness(sourceId, value) {
        freshness.set(sourceId, value);
      },
      setEmbeddingAvailable(available) {
        repository.setEmbeddingAvailable(available);
      },
      setIndexAvailability(availability) {
        repository.setIndexAvailability(availability);
      },
    },
  };
});
