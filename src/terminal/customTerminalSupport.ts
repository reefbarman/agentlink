export const CUSTOM_TERMINAL_SUPPORTED_CONTEXT_KEY =
  "agentLink.customTerminalSupported";
export const CUSTOM_TERMINAL_AVAILABLE_CONTEXT_KEY =
  "agentLink.customTerminalAvailable";

export interface CustomTerminalHost {
  platform: string;
  remoteName?: string;
  /**
   * Linux only: whether this install staged a node-pty prebuild for the
   * host. Alpine and other targets without one keep the VS Code terminal.
   */
  nodePtyAvailable?: boolean;
}

/** The AgentLink terminal runs on local macOS, and on local Linux with node-pty. */
export function isCustomTerminalSupported(host: CustomTerminalHost): boolean {
  if (host.remoteName) return false;
  if (host.platform === "darwin") return true;
  return host.platform === "linux" && host.nodePtyAvailable === true;
}
