import * as os from "os";
import * as path from "path";

export const SHARED_MEMORY_STATE_DIRECTORY = ".agentlink";
export const SHARED_MEMORY_STORE_DIRECTORY = "memory-store";
export const SHARED_MEMORY_CONFIG_FILE = "memory-config.json";
export const SHARED_MEMORY_MIGRATION_DIRECTORY = "memory-migrations";

export function getSharedMemoryStoreRoot(
  homeDir: string = os.homedir(),
): string {
  return path.join(
    homeDir,
    SHARED_MEMORY_STATE_DIRECTORY,
    SHARED_MEMORY_STORE_DIRECTORY,
  );
}

export function getSharedMemoryConfigPath(
  homeDir: string = os.homedir(),
): string {
  return path.join(
    homeDir,
    SHARED_MEMORY_STATE_DIRECTORY,
    SHARED_MEMORY_CONFIG_FILE,
  );
}

export function getSharedMemoryMigrationDirectory(
  homeDir: string = os.homedir(),
): string {
  return path.join(
    homeDir,
    SHARED_MEMORY_STATE_DIRECTORY,
    SHARED_MEMORY_MIGRATION_DIRECTORY,
  );
}
