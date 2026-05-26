export type FinalMessageStatus =
  | "completed"
  | "waiting_for_user"
  | "blocked"
  | "cancelled";

export interface FinalMessageMarker {
  status: FinalMessageStatus;
  summary?: string;
  source: "tool" | "engine";
  continueAction?: {
    label: string;
    prompt: string;
  };
}
