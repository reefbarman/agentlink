import type {
  CoreModelContentBlock,
  CoreModelMessage,
} from "./modelRuntime.js";
import {
  toCoreModelDocumentMediaType,
  toCoreModelImageMediaType,
} from "./modelRuntime.js";

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

export function surfaceMessagesToCoreModelMessages(
  messages: readonly CoreSurfaceModelMessage[],
): CoreModelMessage[] {
  return messages.flatMap((message): CoreModelMessage[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];

    const text = surfaceMessageTextForModel(message);
    if (message.role === "user" && message.media) {
      const blocks: CoreModelContentBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const image of message.media.images ?? []) {
        const mediaType = toCoreModelImageMediaType(image.mimeType);
        if (!mediaType) continue;
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: image.base64,
          },
        });
      }
      for (const document of message.media.documents ?? []) {
        const mediaType = toCoreModelDocumentMediaType(document.mimeType);
        if (!mediaType) continue;
        blocks.push({
          type: "document",
          title: document.name,
          source: {
            type: "base64",
            media_type: mediaType,
            data: document.base64,
          },
        });
      }
      if (blocks.length > 0) return [{ role: "user", content: blocks }];
      return [];
    }

    return [{ role: message.role, content: text }];
  });
}

export function surfaceMessageTextForModel(
  message: CoreSurfaceModelMessage,
): string {
  const questionAnswerText = (message.blocks ?? [])
    .filter(
      (
        block,
      ): block is {
        type: "question_answer";
        items: CoreSurfaceQuestionAnswerItem[];
      } => block.type === "question_answer" && Array.isArray(block.items),
    )
    .flatMap((block) =>
      block.items.map((item) => {
        const answer = Array.isArray(item.answer)
          ? item.answer.join(", ")
          : String(item.answer ?? "");
        const note = item.note ? `\nNote: ${item.note}` : "";
        return `Q: ${item.question}\nA: ${answer}${note}`;
      }),
    )
    .join("\n\n");

  return [message.content.trim(), questionAnswerText.trim()]
    .filter(Boolean)
    .join("\n\n");
}
