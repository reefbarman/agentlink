import { describe, expect, it } from "vitest";

import { projectBrowserGatewayOwnerInteractionPayload } from "./interactionPayload.js";

function payload(commandSandbox: unknown) {
  return {
    approval: {
      id: "ask-agent-command-1",
      kind: "command" as const,
      command: "npm test",
      cwd: "/work/app",
      commandSandbox,
    },
    question: null,
    questionProgress: null,
    formElicitation: null,
    urlElicitation: null,
  } as Parameters<typeof projectBrowserGatewayOwnerInteractionPayload>[0];
}

describe("projectBrowserGatewayOwnerInteractionPayload", () => {
  it("keeps an Ask Agent command's sandbox description for relay clients", () => {
    expect(
      projectBrowserGatewayOwnerInteractionPayload(
        payload({ writableRoot: "/work/app", network: "loopback" }),
      )?.approval?.commandSandbox,
    ).toEqual({ writableRoot: "/work/app", network: "loopback" });
  });

  it("rejects a malformed sandbox description", () => {
    expect(
      projectBrowserGatewayOwnerInteractionPayload(
        payload({ writableRoot: "/work/app", network: "everything" }),
      ),
    ).toBeNull();
  });
});
