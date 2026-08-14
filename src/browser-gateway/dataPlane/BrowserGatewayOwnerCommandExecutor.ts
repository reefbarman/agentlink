import type { ChatViewProvider } from "../../agent/ChatViewProvider.js";
import type {
  BrowserGatewayDetachedSessionDetail,
  BrowserGatewayDetachedSessionSelection,
} from "../BrowserGatewayService.js";
import type { BrowserGatewayOwnerCommandExecutor } from "./BrowserGatewayOwnerRuntime.js";
import type {
  BrowserGatewayOwnerCommandBody,
  BrowserGatewayOwnerCommandKind,
} from "./protocol.js";

export const BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES = [
  "session.select",
  "session.detail",
  "session.send",
  "session.stop",
] as const satisfies readonly BrowserGatewayOwnerCommandKind[];

export type BrowserGatewayOwnerCommandTarget = Pick<
  ChatViewProvider,
  "submitBrowserLoadSession" | "submitBrowserSend" | "submitBrowserStop"
>;

export class ProductionBrowserGatewayOwnerCommandExecutor implements BrowserGatewayOwnerCommandExecutor {
  constructor(
    private readonly target: BrowserGatewayOwnerCommandTarget,
    private readonly instanceId: string,
    private readonly getSessionDetail: (
      selection: BrowserGatewayDetachedSessionSelection,
    ) => BrowserGatewayDetachedSessionDetail | null,
  ) {}

  async execute(
    command: BrowserGatewayOwnerCommandBody,
    signal: AbortSignal,
    operationId: string,
  ): ReturnType<BrowserGatewayOwnerCommandExecutor["execute"]> {
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
      case "session.detail": {
        if (command.instanceId !== this.instanceId) {
          throw new Error("browser_gateway_session_detail_instance_mismatch");
        }
        const detail = this.getSessionDetail({
          controllerEpoch: command.controllerEpoch,
          tabId: command.tabId,
          sessionId: command.sessionId,
        });
        assertNotAborted(signal);
        if (!detail) {
          throw new Error("browser_gateway_session_detail_unavailable");
        }
        return {
          detail: {
            content: new TextEncoder().encode(JSON.stringify(detail)),
            mediaType: "application/json; charset=utf-8",
            kind: "session",
          },
        };
      }
      case "session.send": {
        if (command.detailHandles.length > 0) {
          throw new Error("browser_gateway_session_send_details_unsupported");
        }
        const result = await this.target.submitBrowserSend({
          sessionId: command.sessionId,
          id: operationId,
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
