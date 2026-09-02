import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayOwnerCommandBody } from "./browserGatewayOwnerCommandBody.js";

it("pins the complete browser gateway owner-command body contract", () => {
  expectTypeOf<BrowserGatewayOwnerCommandBody>().toEqualTypeOf<
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
    | { kind: "diff.detail"; requestId: string }
  >();
});
