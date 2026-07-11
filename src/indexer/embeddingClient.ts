import { createEmbeddingRequest } from "./embeddingConfig.js";
import { sleep } from "../util/sleep.js";

const EMBEDDING_URL = "https://api.openai.com/v1/embeddings";

interface EmbeddingResponseItem {
  index?: number;
  embedding: number[];
}

export interface EmbeddingClientOptions {
  maxRetries: number;
  retryFetchErrors?: boolean;
  shouldRetryStatus?: (status: number) => boolean;
  retryDelayMs?: (attempt: number, random: number) => number;
  refreshBearerToken?: () => Promise<string>;
  bisectOnBadRequest?: boolean;
  sortByIndex?: boolean;
  fetch?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export async function requestEmbeddings(
  input: string | string[],
  bearerToken: string,
  options: EmbeddingClientOptions,
): Promise<number[][]> {
  const fetchImpl = options.fetch ?? fetch;
  const sleepImpl = options.sleep ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(EMBEDDING_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(createEmbeddingRequest(input)),
      });
    } catch (error) {
      if (options.retryFetchErrors && attempt < options.maxRetries) {
        await sleepImpl(getRetryDelay(options, attempt, random));
        continue;
      }
      throw error;
    }

    if (response.ok) {
      const data = (await response.json()) as {
        data?: EmbeddingResponseItem[];
      };
      if (!Array.isArray(data.data)) {
        throw new Error("OpenAI API returned invalid embedding data");
      }
      if (options.sortByIndex && Array.isArray(input)) {
        return getIndexedEmbeddings(data.data, input.length);
      }
      return data.data.map((item) => item.embedding);
    }

    if (
      attempt < options.maxRetries &&
      options.shouldRetryStatus?.(response.status)
    ) {
      await sleepImpl(getRetryDelay(options, attempt, random));
      continue;
    }

    if (
      response.status === 401 &&
      attempt < options.maxRetries &&
      options.refreshBearerToken
    ) {
      bearerToken = await options.refreshBearerToken();
      continue;
    }

    if (
      response.status === 400 &&
      options.bisectOnBadRequest &&
      Array.isArray(input) &&
      input.length > 1
    ) {
      const mid = Math.ceil(input.length / 2);
      const [left, right] = await Promise.all([
        requestEmbeddings(input.slice(0, mid), bearerToken, options),
        requestEmbeddings(input.slice(mid), bearerToken, options),
      ]);
      return [...left, ...right];
    }

    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }

  throw new Error("Unreachable");
}

function getIndexedEmbeddings(
  items: EmbeddingResponseItem[],
  expectedCount: number,
): number[][] {
  if (items.length !== expectedCount) {
    throw new Error("OpenAI API returned incomplete embedding data");
  }

  const embeddings: number[][] = Array.from({ length: expectedCount });
  for (const item of items) {
    if (
      !Number.isInteger(item.index) ||
      item.index === undefined ||
      item.index < 0 ||
      item.index >= expectedCount ||
      !Array.isArray(item.embedding) ||
      embeddings[item.index] !== undefined
    ) {
      throw new Error("OpenAI API returned invalid indexed embedding data");
    }
    embeddings[item.index] = item.embedding;
  }
  return embeddings;
}

function getRetryDelay(
  options: EmbeddingClientOptions,
  attempt: number,
  random: () => number,
): number {
  return options.retryDelayMs?.(attempt, random()) ?? 0;
}
