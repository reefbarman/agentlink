/**
 * Thrown by a terminal dispatch guard when the authority a command was
 * approved under is no longer current. The command was never sent.
 */
export class TerminalDispatchRevokedError extends Error {
  readonly code = "terminal_dispatch_revoked";

  constructor(message: string) {
    super(message);
    this.name = "TerminalDispatchRevokedError";
  }
}
