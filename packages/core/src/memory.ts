/**
 * Portable autonomous memory: the service that remembers, recalls, updates
 * and forgets statements, its policy (sensitive-text scan, lexical scoring,
 * evidence rendering) and an in-memory repository. Hosts supply their own
 * durable `MemoryRepository`; protocol types come from
 * `@agentlink/protocol/autonomous-memory`.
 */
export * from "./memory/AutonomousMemoryService.js";
export * from "./memory/InMemoryMemoryRepository.js";
export * from "./memory/memoryPolicy.js";
export type {
  AutonomousMemoryServiceOptions,
  MemoryRepository,
  MemoryRepositoryReader,
  MemoryRepositoryTransaction,
} from "./memory/contracts.js";
