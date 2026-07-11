export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;

export function createEmbeddingRequest(input: string | string[]): {
  model: typeof EMBEDDING_MODEL;
  input: string | string[];
} {
  return { model: EMBEDDING_MODEL, input };
}
