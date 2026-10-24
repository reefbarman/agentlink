import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";

export type BrowserGatewayOwnerCommandBody =
  | { kind: "session.select"; sessionId: string }
  | {
      kind: "session.detail";
      instanceId: string;
      controllerEpoch: string;
      tabId: string;
      sessionId: string;
    }
  | {
      kind: "session.send";
      sessionId: string;
      text: string;
      detailHandles: BrowserGatewayDetailHandle[];
    }
  | {
      kind: "transcript.block-detail";
      sessionId: string;
      messageId: string;
      blockId: string;
      contentRevision: number;
      /**
       * `display-image` addresses message-level display media (user
       * attachments, promoted generated images). Its `blockId` is
       * `BROWSER_GATEWAY_DISPLAY_MEDIA_BLOCK_ID` and `contentRevision` is the
       * message's display-media revision. `work-summary` addresses the
       * message's final-marker work summary with
       * `BROWSER_GATEWAY_WORK_SUMMARY_BLOCK_ID` and the summary revision.
       */
      resource?: {
        kind: "image" | "document" | "display-image" | "work-summary";
        index: number;
      };
    }
  | { kind: "session.stop"; sessionId: string }
  | {
      kind: "approval.respond";
      requestId: string;
      decision: "approve" | "reject";
    }
  | {
      kind: "question.respond";
      requestId: string;
      responseHandle: BrowserGatewayDetailHandle;
    }
  | { kind: "history.load"; cursor: string; count: number }
  | { kind: "diff.detail"; requestId: string };
