import type { ChatViewProvider } from "../../agent/ChatViewProvider.js";
import type { BrowserGatewayOwnerCommandExecutor } from "./BrowserGatewayOwnerRuntime.js";
import type {
  BrowserGatewayOwnerCommandBody,
  BrowserGatewayOwnerCommandKind,
} from "./protocol.js";

export const BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES = [
  "session.select",
  "session.send",
  "session.stop",
] as const satisfies readonly BrowserGatewayOwnerCommandKind[];

export type BrowserGatewayOwnerCommandTarget = Pick<
  ChatViewProvider,
  "submitBrowserLoadSession" | "submitBrowserSend" | "submitBrowserStop"
>;

export class ProductionBrowserGatewayOwnerCommandExecutor implements BrowserGatewayOwnerCommandExecutor {
  constructor(private readonly target: BrowserGatewayOwnerCommandTarget) {}

  async execute(
    command: BrowserGatewayOwnerCommandBody,
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    switch (command.kind) {
      case "session.select": {
        const result = await this.target.submitBrowserLoadSession(
          command.sessionId,
        );
        assertNotAborted(signal);
        if (!result.ok)
          throw new Error("browser_gateway_session_select_failed");
        return;
      }
      case "session.send": {
        if (command.detailHandles.length > 0) {
          throw new Error("browser_gateway_session_send_details_unsupported");
        }
        const result = await this.target.submitBrowserSend({
          sessionId: command.sessionId,
          text: command.text,
        });
        assertNotAborted(signal);
        if (!result.ok) {
          throw new Error(
            result.error
              ? `browser_gateway_session_send_failed:${result.error}`
              : "browser_gateway_session_send_failed",
          );
        }
        return;
      }
      case "session.stop": {
        const result = this.target.submitBrowserStop(command.sessionId);
        if (!result.ok) throw new Error("browser_gateway_session_stop_failed");
        return;
      }
      case "approval.respond":
      case "question.respond":
      case "history.load":
      case "diff.detail":
        throw new Error(
          `browser_gateway_owner_command_unsupported:${command.kind}`,
        );
    }
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new Error("browser_gateway_owner_command_cancelled");
}
