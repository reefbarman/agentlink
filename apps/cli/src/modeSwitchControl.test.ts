import type {
  TuiControlRequest,
  TuiControlResponse,
} from "./tui/controlTypes.js";
import { describe, expect, it, vi } from "vitest";

import { confirmModeSwitchInControlPanel } from "./modeSwitchControl.js";

function presenter(response: {
  readonly cancelled: boolean;
  readonly optionId?: string;
  readonly text?: string;
}) {
  const requests: TuiControlRequest[] = [];
  const present = vi.fn(async (request: TuiControlRequest) => {
    requests.push(request);
    return { requestId: request.id, ...response } as TuiControlResponse;
  });
  return { present, requests };
}

const request = {
  sessionId: "s1",
  mode: "architect",
  modeName: "Architect",
  reason: "needs a plan",
};

describe("confirmModeSwitchInControlPanel", () => {
  it("shows VS Code's card and returns a follow-up with Allow", async () => {
    const { present, requests } = presenter({
      cancelled: false,
      optionId: "allow",
      text: " start small ",
    });
    await expect(
      confirmModeSwitchInControlPanel(request, present),
    ).resolves.toEqual({ approved: true, followUp: "start small" });
    expect(requests[0]).toMatchObject({
      kind: "approval",
      title: 'Switch to "architect" mode',
      body: [
        "The agent wants to switch this session to Architect mode.",
        "Reason: needs a plan",
      ],
      options: [
        { id: "allow", label: "Allow" },
        { id: "reject", label: "Reject", tone: "danger" },
      ],
    });
  });

  it("returns the typed reason with Reject, and rejects when cancelled", async () => {
    await expect(
      confirmModeSwitchInControlPanel(
        request,
        presenter({ cancelled: false, optionId: "reject", text: "not yet" })
          .present,
      ),
    ).resolves.toEqual({ approved: false, rejectionReason: "not yet" });
    await expect(
      confirmModeSwitchInControlPanel(
        request,
        presenter({ cancelled: true }).present,
      ),
    ).resolves.toEqual({ approved: false });
  });
});
