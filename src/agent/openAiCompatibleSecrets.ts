export const OPENAI_COMPATIBLE_SECRET_PREFIX = "openaiCompatibleApiKey:";

export function getOpenAiCompatibleSecretKey(authKey: string): string {
  return `${OPENAI_COMPATIBLE_SECRET_PREFIX}${authKey}`;
}
