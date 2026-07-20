export const CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY =
  "agentLink.customTerminalSupported";
export const CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY =
  "agentLink.customTerminalAvailable";

export interface CustomTerminalHost {
  platform: string;
  remoteName?: string;
}

export function isCustomTerminalSupported(host: CustomTerminalHost): boolean {
  return host.platform === "darwin" && !host.remoteName;
}
