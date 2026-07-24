import type { TerminalProvider } from "../../core/capabilities/terminal.js";
import { getTerminalManager } from "../../integrations/TerminalManager.js";

export function createVscodeTerminalProvider(): TerminalProvider {
  const terminalManager = getTerminalManager();
  return {
    get log() {
      return terminalManager.log;
    },
    set log(value) {
      terminalManager.log = value;
    },
    async executeCommand(options) {
      if (options.sandboxCapabilityRequest || options.sandbox) {
        throw new Error(
          "Sandbox capability requests cannot run in the native VS Code terminal provider.",
        );
      }
      return terminalManager.executeCommand(options);
    },
    getBackgroundState(request) {
      return terminalManager.getBackgroundState(request);
    },
    getCurrentOutput(request) {
      return terminalManager.getCurrentOutput(request);
    },
    interruptTerminal(request) {
      return terminalManager.interruptTerminal(request);
    },
    detachTerminal(request) {
      return terminalManager.detachTerminal(request);
    },
    revealTerminal(request) {
      return terminalManager.revealTerminal(request);
    },
    getRecentlyClosedTerminals(request) {
      return terminalManager.getRecentlyClosedTerminals(request);
    },
    listTerminals(request) {
      return terminalManager.listTerminals(request);
    },
    closeTerminals(request) {
      return terminalManager.closeTerminals(request);
    },
  };
}
