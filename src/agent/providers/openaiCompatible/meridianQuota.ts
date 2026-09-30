import type {
  ProviderUsageAccount,
  ProviderUsageAccountWindow,
} from "../../../shared/providerUsage.js";

/** Oldest reading shown, measured from the upstream observation time. */
export const MAX_QUOTA_READING_AGE_MS = 5 * 60_000;

const MAX_PROFILES = 32;
const MAX_WINDOWS_PER_PROFILE = 16;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 64;

const KNOWN_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_oauth_apps: "Weekly OAuth apps",
  seven_day_cowork: "Weekly Cowork",
};

const PROFILE_ERROR_REASONS: Record<string, string> = {
  no_token:
    "Meridian has no Claude login for this profile. Run claude login for it.",
  not_oauth:
    "This profile does not use a Claude subscription login, so Meridian reports no allowance.",
  rate_limited: "Meridian's usage check is temporarily rate limited.",
  upstream_error: "Meridian could not reach the Claude usage service.",
};

export class MeridianQuotaParseError extends Error {
  constructor() {
    super("The quota endpoint returned an unrecognised response.");
    this.name = "MeridianQuotaParseError";
  }
}

export interface MeridianQuotaParseOptions {
  nowMs: number;
  /** Treat every reading as stale, for example when a refresh failed. */
  forceStale?: boolean;
}

/**
 * Parses Meridian's `GET /v1/usage/quota/all` response. Utilisation arrives
 * as a 0..1 fraction and timestamps as epoch milliseconds; both are converted
 * exactly once here.
 */
export function parseMeridianQuotaResponse(
  body: unknown,
  options: MeridianQuotaParseOptions,
): ProviderUsageAccount[] {
  if (!isRecord(body) || !Array.isArray(body.profiles)) {
    throw new MeridianQuotaParseError();
  }
  const accounts: ProviderUsageAccount[] = [];
  const seen = new Set<string>();
  for (const raw of body.profiles.slice(0, MAX_PROFILES)) {
    if (!isRecord(raw)) continue;
    const id = boundedString(raw.id, MAX_ID_LENGTH);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    accounts.push(parseProfile(raw, id, options));
  }
  return accounts;
}

function parseProfile(
  raw: Record<string, unknown>,
  id: string,
  { nowMs, forceStale }: MeridianQuotaParseOptions,
): ProviderUsageAccount {
  const observedAtMs = finiteNumber(raw.fetchedAt);
  const stale = raw.stale === true || forceStale === true;
  const base = {
    id,
    label: id === "default" ? "Default account" : id,
    isActive: raw.isActive === true,
    stale,
    observedAtMs,
    ...spentNote(raw.spent, nowMs),
  };

  const error = typeof raw.error === "string" ? raw.error : undefined;
  const windowsRaw = Array.isArray(raw.windows) ? raw.windows : [];
  if (error && windowsRaw.length === 0) {
    return {
      ...base,
      available: false,
      reason:
        PROFILE_ERROR_REASONS[error] ??
        "Usage is unavailable for this profile.",
      windows: [],
    };
  }

  const tooOld =
    observedAtMs === null
      ? stale
      : nowMs - observedAtMs > MAX_QUOTA_READING_AGE_MS;
  if (tooOld) {
    return {
      ...base,
      available: false,
      reason: "The last usage reading is too old to show.",
      windows: [],
    };
  }

  const windows: ProviderUsageAccountWindow[] = [];
  const windowIds = new Set<string>();
  for (const window of windowsRaw.slice(0, MAX_WINDOWS_PER_PROFILE)) {
    if (!isRecord(window)) continue;
    const type = boundedString(window.type, MAX_ID_LENGTH);
    if (!type || windowIds.has(type)) continue;
    windowIds.add(type);
    windows.push(parseWindow(window, type, nowMs));
  }
  return { ...base, available: true, windows };
}

function parseWindow(
  raw: Record<string, unknown>,
  type: string,
  nowMs: number,
): ProviderUsageAccountWindow {
  const utilization = finiteNumber(raw.utilization);
  const resetsAtMs = finiteNumber(raw.resetsAt);
  const label = windowLabel(type);
  if (resetsAtMs !== null && resetsAtMs <= nowMs) {
    return {
      id: type,
      label,
      usedPercent: null,
      resetsAt: null,
      resetSinceObservation: true,
    };
  }
  return {
    id: type,
    label,
    usedPercent:
      utilization === null || utilization < 0 ? null : utilization * 100,
    resetsAt: resetsAtMs === null ? null : Math.floor(resetsAtMs / 1_000),
  };
}

function spentNote(spent: unknown, nowMs: number): { statusNote?: string } {
  if (!isRecord(spent)) return {};
  const until = finiteNumber(spent.until);
  if (until !== null && until <= nowMs) return {};
  return {
    statusNote: "Meridian reports this profile is currently refusing requests.",
  };
}

export function windowLabel(type: string): string {
  const known = KNOWN_WINDOW_LABELS[type];
  if (known) return known;
  const weekly = /^seven_day_(.+)$/.exec(type);
  const label = weekly ? `Weekly ${humanize(weekly[1]!)}` : humanize(type);
  return label.length > MAX_LABEL_LENGTH
    ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : label;
}

function humanize(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
