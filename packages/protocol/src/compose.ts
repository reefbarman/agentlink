export type ComposeChildStatus =
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export type ComposeErrorCode =
  | "final_result_too_large"
  | "child_result_too_large"
  | "cumulative_child_result_too_large"
  | "unsupported_data"
  | "cyclic_data"
  | "non_finite_data"
  | "invalid_json"
  | "serialization_failed"
  | "child_handler_failed"
  | "canonical_result_required"
  | "tool_not_available"
  | "tool_not_in_request"
  | "tool_not_in_mode"
  | "tool_not_composable"
  | "tool_input_not_composable"
  | "interaction_denied"
  | "budget_exhausted"
  | "compose_runtime_busy"
  | "timeout"
  | "memory_limit"
  | "aborted"
  | "validation_failed"
  | "script_policy_violation"
  | "script_error"
  | "internal_failure";

export interface ComposeTraceChild {
  id: string;
  name: string;
  status: ComposeChildStatus;
  durationMs?: number;
  inputSummary?: string;
  errorSummary?: string;
}

export interface ComposeTrace {
  description?: string;
  status: "running" | "completed" | "error" | "cancelled";
  totalChildren: number;
  completedChildren: number;
  succeededChildren?: number;
  failedChildren?: number;
  cancelledChildren?: number;
  toolAllBatchCount?: number;
  toolAllSettledBatchCount?: number;
  bridgedBytes?: number;
  errorKind?: string;
  errorCode?: ComposeErrorCode;
  children: ComposeTraceChild[];
}
