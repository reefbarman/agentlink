import * as path from "path";

export const RETRIEVAL_STORE_DIRECTORY = "retrieval-store";

export function getRetrievalStoreRoot(globalStoragePath: string): string {
  return path.join(globalStoragePath, RETRIEVAL_STORE_DIRECTORY);
}
