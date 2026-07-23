// @vitest-environment jsdom

import {
  ApprovalPanelEmbed,
  DEFAULT_APPROVAL_PANEL_HEIGHT,
} from "./ApprovalPanelEmbed";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/preact";

import type { ApprovalRequest } from "../../../approvals/webview/types";
import { h } from "preact";

afterEach(cleanup);

const request: ApprovalRequest = {
  kind: "mode-switch",
  id: "mode-switch-1",
  command: "Switch to architect mode",
};

describe("ApprovalPanelEmbed", () => {
  it("uses the requested size as a minimum and leaves overflow to the shelf", () => {
    const { container } = render(
      h(ApprovalPanelEmbed, {
        request,
        height: 360,
        resizing: false,
        followUpRef: { current: "" },
        submit: vi.fn(),
        onResizeStart: vi.fn(),
      }),
    );

    const embed = container.querySelector<HTMLElement>(".approval-panel-embed");
    expect(embed?.style.minHeight).toBe("360px");
    expect(embed?.style.height).toBe("");
  });

  it("keeps the optional follow-up field collapsed by default", () => {
    const { container, getByLabelText, getByText } = render(
      h(ApprovalPanelEmbed, {
        request,
        height: DEFAULT_APPROVAL_PANEL_HEIGHT,
        resizing: false,
        followUpRef: { current: "" },
        submit: vi.fn(),
        onResizeStart: vi.fn(),
      }),
    );

    const section = container.querySelector("details.follow-up-section");
    expect(section?.hasAttribute("open")).toBe(false);
    expect(getByText("Add follow-up or rejection reason")).toBeTruthy();
    expect(getByLabelText("Follow-up or rejection reason")).toBeTruthy();
  });

  it("identifies approvals requested by a background agent", () => {
    const { getByText } = render(
      h(ApprovalPanelEmbed, {
        request: { ...request, backgroundTask: "Review write handling" },
        height: DEFAULT_APPROVAL_PANEL_HEIGHT,
        resizing: false,
        followUpRef: { current: "" },
        submit: vi.fn(),
        onResizeStart: vi.fn(),
      }),
    );

    expect(getByText("Review write handling")).toBeTruthy();
    expect(getByText(/From background agent:/)).toBeTruthy();
  });
});
