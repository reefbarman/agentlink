import type {
  ContextHealthSnapshot,
  ContextHealthStatus,
} from "@agentlink/protocol/context-health";

import type { ComponentChildren } from "preact";

interface ContextHealthPanelProps {
  health: ContextHealthSnapshot;
}

const STATUS_LABELS: Record<ContextHealthStatus, string> = {
  ready: "Ready",
  working: "Working",
  degraded: "Degraded",
  unavailable: "Unavailable",
  disabled: "Disabled",
  not_measured: "Not yet measured",
};

function formatCapability(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function StatusChip({
  label,
  status,
}: {
  label: string;
  status: ContextHealthStatus;
}) {
  const statusLabel = STATUS_LABELS[status];
  return (
    <span
      class={`context-health-chip context-health-${status}`}
      aria-label={`${label}: ${statusLabel}`}
      title={`${label}: ${statusLabel}`}
    >
      <span class="context-health-dot" aria-hidden="true" />
      <span>{label}</span>
      <span class="context-health-chip-status">{statusLabel}</span>
    </span>
  );
}

function HealthSection({
  label,
  status,
  reason,
  children,
}: {
  label: string;
  status: ContextHealthStatus;
  reason?: string;
  children: ComponentChildren;
}) {
  return (
    <section class="context-health-section">
      <div class="context-health-section-heading">
        <strong>{label}</strong>
        <span class={`context-health-state context-health-${status}`}>
          {STATUS_LABELS[status]}
        </span>
      </div>
      <div class="context-health-metrics">{children}</div>
      {reason && <p class="context-health-reason">{reason}</p>}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <span>
      {label}: <strong>{value}</strong>
    </span>
  );
}

export function ContextHealthPanel({ health }: ContextHealthPanelProps) {
  return (
    <details class="context-health-panel">
      <summary>
        <span class="context-health-title">
          <span class="context-health-pulse" aria-hidden="true" />
          Context health
        </span>
        <span class="context-health-summary">
          <StatusChip label="Memory" status={health.memory.status} />
          <StatusChip label="Retrieval" status={health.retrieval.status} />
          <StatusChip label="Index" status={health.index.status} />
        </span>
        <span class="context-health-chevron" aria-hidden="true" />
      </summary>
      <div class="context-health-body">
        <HealthSection
          label="Memory"
          status={health.memory.status}
          reason={health.memory.reason}
        >
          <Metric
            label="Retrieval"
            value={formatCapability(health.memory.retrieval)}
          />
          {health.memory.activeRecordCount !== undefined && (
            <Metric
              label="Active records"
              value={health.memory.activeRecordCount}
            />
          )}
        </HealthSection>
        <HealthSection
          label="Retrieval"
          status={health.retrieval.status}
          reason={health.retrieval.reason}
        >
          <Metric
            label="Lexical"
            value={formatCapability(health.retrieval.lexical)}
          />
          <Metric
            label="Vector"
            value={formatCapability(health.retrieval.vector)}
          />
          <Metric
            label="Structural"
            value={formatCapability(health.retrieval.structural)}
          />
          {health.retrieval.sourceCount !== undefined && (
            <Metric label="Sources" value={health.retrieval.sourceCount} />
          )}
          {health.retrieval.chunkCount !== undefined && (
            <Metric label="Chunks" value={health.retrieval.chunkCount} />
          )}
          {health.retrieval.staleSourceCount !== undefined && (
            <Metric
              label="Stale sources"
              value={health.retrieval.staleSourceCount}
            />
          )}
        </HealthSection>
        <HealthSection
          label="Index"
          status={health.index.status}
          reason={health.index.reason}
        >
          <Metric label="State" value={formatCapability(health.index.state)} />
          {health.index.current !== undefined && (
            <Metric
              label="Progress"
              value={`${health.index.current}/${health.index.total ?? "?"}`}
            />
          )}
          {health.index.totalFilesInIndex !== undefined && (
            <Metric label="Files" value={health.index.totalFilesInIndex} />
          )}
          {health.index.totalChunksInIndex !== undefined && (
            <Metric label="Chunks" value={health.index.totalChunksInIndex} />
          )}
        </HealthSection>
      </div>
    </details>
  );
}
