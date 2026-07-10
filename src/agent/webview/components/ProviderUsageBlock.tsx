import type { ProviderUsageCardData } from "../types";

function formatReset(timestamp: number | null): string {
  if (timestamp === null) return "reset unavailable";
  return `resets ${new Date(timestamp * 1_000).toLocaleString()}`;
}

function UsageWindow({
  label,
  window,
}: {
  label: string;
  window: { usedPercent: number; resetsAt: number | null };
}) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  return (
    <div class="provider-usage-window">
      <div class="provider-usage-window-header">
        <span>{label}</span>
        <span>{Math.round(used)}% used</span>
      </div>
      <div class="provider-usage-track" aria-label={`${used}% used`}>
        <div class="provider-usage-fill" style={{ width: `${used}%` }} />
      </div>
      <div class="provider-usage-reset">{formatReset(window.resetsAt)}</div>
    </div>
  );
}

export function ProviderUsagePanel({
  data,
  onClose,
  onRefresh,
}: {
  data: ProviderUsageCardData;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <div class="provider-usage-card">
      <div class="provider-usage-card-header">
        <i class="codicon codicon-dashboard" />
        <span>Provider usage</span>
        <span class="provider-usage-card-count">
          {data.providers.length} provider
          {data.providers.length === 1 ? "" : "s"}
        </span>
        <button
          class="icon-button"
          onClick={onRefresh}
          title="Refresh usage"
        >
          <i class="codicon codicon-refresh" />
        </button>
        <button class="icon-button" onClick={onClose} title="Dismiss">
          <i class="codicon codicon-close" />
        </button>
      </div>
      <div class="provider-usage-body">
        {data.providers.map((provider) => (
          <section
            class="provider-usage-provider"
            key={provider.providerId}
          >
            <div class="provider-usage-provider-header">
              <i
                class={`codicon codicon-${provider.available ? "pass-filled" : "circle-slash"}`}
              />
              <strong>{provider.providerName}</strong>
              {provider.planType && (
                <span class="provider-usage-plan">{provider.planType}</span>
              )}
            </div>
            {provider.accountLabel && (
              <div class="provider-usage-account-row">
                <i class="codicon codicon-account" />
                <div>
                  <div class="provider-usage-account-label">
                    {provider.accountLabel}
                  </div>
                  <div class="provider-usage-account-source">
                    {provider.accountSource}
                  </div>
                </div>
              </div>
            )}
            {!provider.available ? (
              <div class="provider-usage-unavailable">
                <i class="codicon codicon-info" />
                <span>{provider.reason ?? "Usage is unavailable"}</span>
              </div>
            ) : (
              <>
                {provider.rateLimits?.map((limit) => (
                  <div class="provider-usage-limit" key={limit.id}>
                    <div class="provider-usage-limit-name">
                      {limit.name ?? limit.id}
                    </div>
                    {limit.primary && (
                      <UsageWindow label="Primary" window={limit.primary} />
                    )}
                    {limit.secondary && (
                      <UsageWindow
                        label="Secondary"
                        window={limit.secondary}
                      />
                    )}
                  </div>
                ))}
                <div class="provider-usage-stats">
                  {provider.lifetimeTokens !== undefined && (
                    <span>
                      Lifetime: {provider.lifetimeTokens.toLocaleString()} tokens
                    </span>
                  )}
                  {provider.peakDailyTokens !== undefined && (
                    <span>
                      Peak day: {provider.peakDailyTokens.toLocaleString()} tokens
                    </span>
                  )}
                  {provider.resetCredits !== undefined && (
                    <span>Resets available: {provider.resetCredits}</span>
                  )}
                </div>
              </>
            )}
            {provider.switchAccountInstructions && (
              <details class="provider-usage-switch-account">
                <summary>Show usage for another account</summary>
                <div>{provider.switchAccountInstructions}</div>
              </details>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
