export interface SessionActivityQuery {
  toolName?: string;
  path?: string;
  toolCallId?: string;
  limit?: number;
}

export interface SessionActivityEvidence {
  sequence: number;
  timestamp: number;
  kind: "tool_result" | "warning" | "error";
  source: string;
  summary: string;
  toolCallId?: string;
  toolName?: string;
  durationMs?: number;
  outcome?: string;
  input?: unknown;
  result?: unknown;
  retryable?: boolean;
  code?: string;
}

export interface SessionActivityDiagnosis {
  sessionId: string;
  eventCount: number;
  recordedEventCount: number;
  traceTruncated: boolean;
  filters: SessionActivityQuery;
  evidence: SessionActivityEvidence[];
}

export interface SessionActivityDiagnosticsProvider {
  diagnose(query: SessionActivityQuery): SessionActivityDiagnosis;
}
