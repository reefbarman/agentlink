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
    getBackgroundState(terminalId) {
      return terminalManager.getBackgroundState(terminalId);
    },
    getCurrentOutput(terminalId, options) {
      return terminalManager.getCurrentOutput(terminalId, options);
    },
    interruptTerminal(terminalId) {
      return terminalManager.interruptTerminal(terminalId);
    },
    detachTerminal(terminalId) {
      return terminalManager.detachTerminal(terminalId);
    },
    revealTerminal(terminalId) {
      return terminalManager.revealTerminal(terminalId);
    },
    getRecentlyClosedTerminals(limit) {
      return terminalManager.getRecentlyClosedTerminals(limit);
    },
    listTerminals() {
      return terminalManager.listTerminals();
    },
    closeTerminals(names) {
      return terminalManager.closeTerminals(names);
    },
  };
}
