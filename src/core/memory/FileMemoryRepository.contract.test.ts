import { AutonomousMemoryService } from "@agentlink/core/memory";
import { FileMemoryRepository } from "@agentlink/node-host";
import { describeMemoryServiceContract } from "../../test/memoryServiceContract.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

describeMemoryServiceContract("FileMemoryRepository", async (options) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "file-memory-"));
  const repository = await FileMemoryRepository.open(directory);
  return {
    repository,
    service: new AutonomousMemoryService(repository, options),
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
});
