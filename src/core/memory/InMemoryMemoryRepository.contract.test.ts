import { AutonomousMemoryService } from "./AutonomousMemoryService.js";
import { InMemoryMemoryRepository } from "./InMemoryMemoryRepository.js";
import { describeMemoryServiceContract } from "../../test/memoryServiceContract.js";

describeMemoryServiceContract("InMemoryMemoryRepository", (options) => {
  const repository = new InMemoryMemoryRepository();
  return {
    repository,
    service: new AutonomousMemoryService(repository, options),
  };
});
