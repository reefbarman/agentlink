export interface RefreshDesktopOwnerOptions {
  ownerId: string;
  refresh: () => Promise<void>;
  notify: (ownerId: string) => void;
  log: (message: string) => void;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export async function refreshDesktopOwner({
  ownerId,
  refresh,
  notify,
  log,
  retryDelayMs = 1_000,
  maxAttempts = 3,
}: RefreshDesktopOwnerOptions): Promise<void> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) return;

  notify(normalizedOwnerId);
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await refresh();
      notify(normalizedOwnerId);
      return;
    } catch (error) {
      log(
        `owner-change credential refresh failed (attempt ${attempt}/${attempts}): ${String(error)}`,
      );
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
}
