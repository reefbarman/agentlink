import type {
  SessionPreferencesSnapshot,
  SessionPreferencesStore,
} from "@agentlink/node-host";

const REFRESH_INTERVAL_MS = 5_000;

/**
 * Per-model auto-condense thresholds from the shared
 * `~/.agentlink/session-preferences.json`, the file VS Code's threshold
 * control writes. Reads are synchronous for the condenser's budget check;
 * the file is re-read in the background at most every few seconds, so a
 * change made in VS Code applies to a running CLI.
 */
export interface CliCondenseThresholds {
  read(): Readonly<Record<string, number>>;
  /** Re-read the file now, for showing the current values. */
  refresh(): Promise<Readonly<Record<string, number>>>;
  /** Save a threshold for a model ID (0.1 to 1, as VS Code clamps it), or remove it with null. */
  set(modelId: string, threshold: number | null): Promise<number | undefined>;
}

export function createCliCondenseThresholds(
  store: Pick<SessionPreferencesStore, "read" | "update">,
  initial: SessionPreferencesSnapshot | undefined,
  now: () => number = Date.now,
): CliCondenseThresholds {
  let current: Readonly<Record<string, number>> =
    initial?.modelCondenseThresholds ?? {};
  let readAt = now();
  let refreshing = false;
  const refresh = () => {
    if (refreshing || now() - readAt < REFRESH_INTERVAL_MS) return;
    refreshing = true;
    readAt = now();
    void store
      .read()
      .then((preferences) => {
        current = preferences.modelCondenseThresholds;
      })
      // A broken preferences file keeps the last good values.
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  };
  return {
    read() {
      refresh();
      return current;
    },
    async refresh() {
      try {
        current = (await store.read()).modelCondenseThresholds;
        readAt = now();
      } catch {
        // A broken preferences file keeps the last good values.
      }
      return current;
    },
    async set(modelId, threshold) {
      const key = modelId.trim();
      if (!key) throw new Error("A model ID is required");
      const next = await store.update(
        threshold === null
          ? { removeModelCondenseThresholds: [key] }
          : {
              modelCondenseThresholds: {
                [key]: Math.min(1, Math.max(0.1, threshold)),
              },
            },
      );
      current = next.modelCondenseThresholds;
      readAt = now();
      return current[key];
    },
  };
}
