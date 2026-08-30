const PORTABLE_PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Whether a function name is accepted across AgentLink's supported providers. */
export function isProviderSafeToolName(name: string): boolean {
  return PORTABLE_PROVIDER_TOOL_NAME_PATTERN.test(name);
}
