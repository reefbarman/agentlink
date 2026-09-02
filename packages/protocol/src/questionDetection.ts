export interface DetectedQuestionOption {
  label: string;
  payload: string;
}

export interface DetectedQuestion {
  kind: "yes_no" | "single_choice";
  prompt: string;
  options: DetectedQuestionOption[];
}
