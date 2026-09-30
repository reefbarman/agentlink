/**
 * Host-neutral `/usage` panel contract shared by the extension host, the VS
 * Code webview and the browser remote.
 */

export interface ProviderUsageWindow {
  usedPercent: number;
  /** Epoch seconds. */
  resetsAt: number | null;
}

export interface ProviderUsageAccountWindow {
  id: string;
  label: string;
  /** 0-100+, or null when unknown. Never a fabricated zero. */
  usedPercent: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
  /** The window reset after this reading, so its old percentage is hidden. */
  resetSinceObservation?: boolean;
}

export interface ProviderUsageAccount {
  id: string;
  label: string;
  /** The upstream's active/default selection, not proof it served this chat. */
  isActive: boolean;
  available: boolean;
  reason?: string;
  stale: boolean;
  /** Epoch milliseconds of the reading, or null when unknown. */
  observedAtMs: number | null;
  windows: ProviderUsageAccountWindow[];
  statusNote?: string;
}

export interface ProviderUsageEntry {
  providerId: string;
  providerName: string;
  available: boolean;
  reason?: string;
  /** Informational note, for example a cached reading or retry delay. */
  notice?: string;
  accountLabel?: string;
  accountSource?: string;
  switchAccountInstructions?: string;
  planType?: string;
  rateLimits?: Array<{
    id: string;
    name?: string;
    primary?: ProviderUsageWindow;
    secondary?: ProviderUsageWindow;
  }>;
  accounts?: ProviderUsageAccount[];
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  resetCredits?: number;
}

export interface ProviderUsageSnapshot {
  providers: ProviderUsageEntry[];
  /** Epoch milliseconds. */
  queriedAt: number;
}
