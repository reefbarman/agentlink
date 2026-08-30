export type ComposeChildStatus =
  | "running"
  | "completed"
  | "error"
  | "cancelled";

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
  children: ComposeTraceChild[];
}
