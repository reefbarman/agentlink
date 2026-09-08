import type { MemoryDisposition } from "@agentlink/protocol/autonomous-memory";

export function memoryMutationError(
  disposition: MemoryDisposition,
): string | null {
  switch (disposition) {
    case "rejected-sensitive":
      return "This memory contains potentially sensitive information. Remove secrets or private details before saving.";
    case "rejected-quota":
      return "The memory exceeds the record length or storage limit. Shorten it or forget unneeded records.";
    case "stale-revision":
      return "This memory changed elsewhere. If editing, cancel the draft first, then select the record again to load its latest revision.";
    case "not-found":
      return "This memory is no longer available. Refresh the list and select another record.";
    default:
      return null;
  }
}
