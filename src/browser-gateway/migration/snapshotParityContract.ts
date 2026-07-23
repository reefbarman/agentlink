import type {
  BrowserGatewaySnapshotState,
  BrowserGatewayWireSessionState,
  BrowserGatewayWireState,
} from "../BrowserGatewayService.js";

export type BrowserGatewayParityStatus =
  | "covered"
  | "partial"
  | "missing"
  | "excluded";

export type BrowserGatewayParityTransport =
  | "checkpoint"
  | "owner_event"
  | "detail_handle"
  | "retained_http"
  | "none";

export interface BrowserGatewayParityCoverage {
  readonly status: BrowserGatewayParityStatus;
  readonly transports: readonly BrowserGatewayParityTransport[];
  readonly notes: string;
}

type CoverageRecord<T> = {
  readonly [K in keyof T]-?: BrowserGatewayParityCoverage;
};

type ForegroundState = NonNullable<
  BrowserGatewayWireSessionState["foreground"]
>;

type SessionCoverage = Omit<
  CoverageRecord<BrowserGatewayWireSessionState>,
  "foreground"
> & {
  readonly foreground: CoverageRecord<ForegroundState>;
};

type SnapshotCoverage = Omit<
  CoverageRecord<BrowserGatewaySnapshotState>,
  "ui" | "session"
> & {
  readonly ui: CoverageRecord<BrowserGatewayWireState>;
  readonly session: SessionCoverage;
};

const covered = (
  notes: string,
  ...transports: readonly BrowserGatewayParityTransport[]
): BrowserGatewayParityCoverage => ({
  status: "covered",
  transports,
  notes,
});

const partial = (
  notes: string,
  ...transports: readonly BrowserGatewayParityTransport[]
): BrowserGatewayParityCoverage => ({
  status: "partial",
  transports,
  notes,
});

const missing = (notes: string): BrowserGatewayParityCoverage => ({
  status: "missing",
  transports: ["none"],
  notes,
});

const excluded = (notes: string): BrowserGatewayParityCoverage => ({
  status: "excluded",
  transports: ["none"],
  notes,
});

/**
 * Executable inventory for the legacy snapshot fields consumed by the browser.
 *
 * The mapped types make additions to the exported legacy wire contracts fail the
 * type-check until their relay coverage is classified here. `partial` and
 * `missing` entries are explicit Phase 0 blockers, not accepted parity gaps.
 */
export const BROWSER_GATEWAY_SNAPSHOT_PARITY_CONTRACT = {
  ui: {
    approval: partial(
      "A generation-bound detail preserves concurrent approval state and reconstructs the browser DTO field-by-field; parity remains partial until the interaction contract is exercised across all approval variants and bounded explicitly.",
      "checkpoint",
      "owner_event",
      "detail_handle",
    ),
    question: partial(
      "A generation-bound detail preserves concurrent question state and reconstructs the browser DTO field-by-field; parity remains partial until the interaction contract is exercised across all question variants and bounded explicitly.",
      "checkpoint",
      "owner_event",
      "detail_handle",
    ),
    questionProgress: partial(
      "Question progress is preserved concurrently and reconstructed field-by-field from a generation-bound detail; explicit field/cardinality bounds remain to be enforced.",
      "checkpoint",
      "owner_event",
      "detail_handle",
    ),
    formElicitation: partial(
      "The normalized form schema is preserved concurrently and reconstructed field-by-field from a generation-bound detail; explicit field/cardinality bounds remain to be enforced.",
      "checkpoint",
      "owner_event",
      "detail_handle",
    ),
    urlElicitation: partial(
      "The validated URL request is preserved concurrently and reconstructed field-by-field from a generation-bound detail; URL validation provenance is still trusted from the owner.",
      "checkpoint",
      "owner_event",
      "detail_handle",
    ),
    recentEvents: excluded(
      "Legacy diagnostic UI event history is not authoritative state and must not expose raw AgentUiEvent objects.",
    ),
    mcpStatusInfos: missing(
      "Capability summaries do not contain the browser MCP status/tool/resource/prompt view model.",
    ),
  },
  session: {
    projects: covered(
      "Projected into checkpoint.catalog.projects.",
      "checkpoint",
      "owner_event",
    ),
    defaultProjectId: covered(
      "Projected into checkpoint.catalog.defaultProjectId.",
      "checkpoint",
      "owner_event",
    ),
    sessions: partial(
      "Catalog sessions omit token totals and retain a reduced ProjectInfo shape.",
      "checkpoint",
      "owner_event",
    ),
    repository: partial(
      "Repository branch/dirty state is present, but project association is not represented.",
      "checkpoint",
      "owner_event",
    ),
    foreground: {
      sessionId: covered(
        "Projected into checkpoint.foreground.sessionId.",
        "checkpoint",
        "owner_event",
      ),
      project: partial(
        "Foreground control identifies the session but does not carry its full ProjectInfo.",
        "checkpoint",
        "owner_event",
      ),
      title: covered(
        "Projected into checkpoint.foreground.title.",
        "checkpoint",
        "owner_event",
      ),
      mode: covered(
        "Projected into checkpoint.foreground.mode.",
        "checkpoint",
        "owner_event",
      ),
      model: covered(
        "Projected into checkpoint.foreground.model.",
        "checkpoint",
        "owner_event",
      ),
      status: covered(
        "Projected into checkpoint.foreground.status.",
        "checkpoint",
        "owner_event",
      ),
      streaming: covered(
        "Projected into checkpoint.foreground.streaming.",
        "checkpoint",
        "owner_event",
      ),
      projectedMessages: partial(
        "Complete browser-safe transcript messages and incremental updates are carried, with oversized text resolved through details; bounded-window cursor/hasEarlier reachability cannot be derived from the legacy snapshot, and intentionally omitted thinking, raw tool input/results/media, and other non-browser-safe fields remain outside the DTO.",
        "checkpoint",
        "owner_event",
        "detail_handle",
      ),
      statusOverride: covered(
        "Projected into checkpoint.foreground.statusOverride with explicit null clearing and legacy-compatible omission fallback.",
        "checkpoint",
        "owner_event",
      ),
      thinkingEnabled: covered(
        "Projected into checkpoint.foreground.thinkingEnabled with the legacy browser default preserved for older owners.",
        "checkpoint",
        "owner_event",
      ),
      reasoningEffort: covered(
        "Projected into checkpoint.foreground.reasoningEffort with the legacy browser default preserved for older owners.",
        "checkpoint",
        "owner_event",
      ),
      lastInputTokens: covered(
        "Projected into checkpoint.foreground.lastInputTokens.",
        "checkpoint",
        "owner_event",
      ),
      lastOutputTokens: covered(
        "Projected into checkpoint.foreground.lastOutputTokens.",
        "checkpoint",
        "owner_event",
      ),
      lastCacheReadTokens: covered(
        "Projected into checkpoint.foreground.lastCacheReadTokens.",
        "checkpoint",
        "owner_event",
      ),
      estimatedTotalUsed: covered(
        "Projected into checkpoint.foreground.estimatedTokens and normalized back to the legacy estimated-total semantics.",
        "checkpoint",
        "owner_event",
      ),
      messageQueue: partial(
        "Queue summaries omit full queued message bodies, attachments, and edit metadata.",
        "checkpoint",
        "owner_event",
        "detail_handle",
      ),
      questionRequest: partial(
        "Projected from the aggregate interaction detail even when another interaction is primary; browser DTO reconstruction is complete, with explicit field/cardinality bounds still open.",
        "checkpoint",
        "owner_event",
        "detail_handle",
      ),
      detectedQuestion: missing(
        "No data-plane field carries detected-question state.",
      ),
      todos: partial(
        "Flat todo summaries do not preserve nested TodoItem children and metadata.",
        "checkpoint",
        "owner_event",
      ),
      debugInfo: excluded(
        "Raw debug info is intentionally forbidden from checkpoints/events; keep the authenticated debug HTTP read.",
      ),
      systemPrompt: excluded(
        "System prompts are intentionally forbidden from browser-safe data-plane DTOs.",
      ),
      loadedInstructions: excluded(
        "Loaded instruction contents are intentionally forbidden from browser-safe data-plane DTOs.",
      ),
      restoringSession: covered(
        "Projected into checkpoint.foreground.restoringSession.",
        "checkpoint",
        "owner_event",
      ),
      revertRecoveryNotice: covered(
        "Projected as a browser-safe checkpoint.foreground.revertRecoveryNotice DTO with explicit null clearing.",
        "checkpoint",
        "owner_event",
      ),
      contextBudget: covered(
        "Projected into checkpoint.foreground.contextBudget with bounded numeric and relationship validation.",
        "checkpoint",
        "owner_event",
      ),
      condenseThreshold: covered(
        "Projected into checkpoint.foreground.condenseThreshold and validated as a unit interval.",
        "checkpoint",
        "owner_event",
      ),
      agentWriteApproval: covered(
        "Projected from the coherent owner policy read into checkpoint.foreground.agentWriteApproval.",
        "checkpoint",
        "owner_event",
      ),
      commandApprovalPolicy: covered(
        "Projected from the coherent owner policy read into checkpoint.foreground.commandApprovalPolicy.",
        "checkpoint",
        "owner_event",
      ),
      configuredCommandApprovalPolicy: covered(
        "Projected from the coherent owner policy read into checkpoint.foreground.configuredCommandApprovalPolicy.",
        "checkpoint",
        "owner_event",
      ),
    },
  },
  background: partial(
    "Background/fleet summaries omit fields consumed by the activity shelf and transcript-open flow.",
    "checkpoint",
    "owner_event",
    "retained_http",
  ),
  diffs: partial(
    "Diff metadata is present; original/proposed bodies require generation-bound detail upload and reads.",
    "checkpoint",
    "owner_event",
    "detail_handle",
  ),
  theme: partial(
    "Color scheme and safe --vscode-* variables are carried; non-VS-Code variables, themeLabel, and source are not represented.",
    "checkpoint",
    "owner_event",
  ),
  modelsVersion: partial(
    "A model catalog revision string exists, but the legacy numeric invalidation contract is not projected yet.",
    "checkpoint",
    "owner_event",
    "retained_http",
  ),
} as const satisfies SnapshotCoverage;

export interface BrowserGatewayFlattenedParityEntry extends BrowserGatewayParityCoverage {
  readonly path: string;
}

export function flattenBrowserGatewaySnapshotParityContract(): BrowserGatewayFlattenedParityEntry[] {
  const entries: BrowserGatewayFlattenedParityEntry[] = [];
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (
      typeof record.status === "string" &&
      Array.isArray(record.transports) &&
      typeof record.notes === "string"
    ) {
      entries.push({
        path,
        status: record.status as BrowserGatewayParityStatus,
        transports: record.transports as BrowserGatewayParityTransport[],
        notes: record.notes,
      });
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(BROWSER_GATEWAY_SNAPSHOT_PARITY_CONTRACT, "");
  return entries;
}
