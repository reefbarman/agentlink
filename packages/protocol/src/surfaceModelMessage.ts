export interface CoreSurfaceQuestionAnswerItem {
  question: string;
  answer: string | string[] | number | boolean | null;
  note?: string;
}

export interface CoreSurfaceModelMediaItem {
  name: string;
  mimeType: string;
  base64: string;
}

export interface CoreSurfaceModelMessage {
  role: "user" | "assistant" | string;
  content: string;
  blocks?: Array<
    | { type: "question_answer"; items: CoreSurfaceQuestionAnswerItem[] }
    | { type: string; [key: string]: unknown }
  >;
  media?: {
    images?: CoreSurfaceModelMediaItem[];
    documents?: CoreSurfaceModelMediaItem[];
  };
}
