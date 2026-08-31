export const BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID = "openai-codex";

export function normalizeBrowserGatewayModelCredentialProviderId(
  providerId: string,
): string {
  const normalized = providerId.trim();
  return normalized === "codex"
    ? BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID
    : normalized;
}
