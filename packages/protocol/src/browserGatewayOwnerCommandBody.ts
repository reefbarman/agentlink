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
      resource?: { kind: "image" | "document"; index: number };
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
