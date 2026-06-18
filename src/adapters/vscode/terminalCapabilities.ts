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
    executeCommand(options) {
      return terminalManager.executeCommand(options);
    },
    getBackgroundState(terminalId) {
      return terminalManager.getBackgroundState(terminalId);
    },
    interruptTerminal(terminalId) {
      return terminalManager.interruptTerminal(terminalId);
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
