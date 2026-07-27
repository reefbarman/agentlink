// @vitest-environment jsdom

import type { ApprovalRequest, DecisionMessage } from "../types.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";

import { WriteCard } from "./WriteCard.js";
import { createRef } from "preact";

describe("WriteCard", () => {
  it("renders explicit non-file write choices without file trust controls", () => {
    const submit = vi.fn<(data: Omit<DecisionMessage, "type">) => void>();
    const request: ApprovalRequest = {
      kind: "write",
      id: "generate-image-1",
      filePath: "Generate 1 image?",
      writeOperation: "modify",
      detail: "Image generation consumes quota.",
      writeChoices: [
        { label: "Generate", value: "accept", isPrimary: true },
        { label: "Generate for Session", value: "accept-session" },
        { label: "Deny", value: "reject", isDanger: true },
      ],
    };

    render(
      <WriteCard
        request={request}
        submit={submit}
        followUpRef={createRef<string>()}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Approval required: Generate 1 image?",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("modify")).toBeNull();
    expect(screen.queryByText("Auto Approval Rules")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Generate for Session" }),
    );
    expect(submit).toHaveBeenCalledWith({
      id: "generate-image-1",
      decision: "accept-session",
      followUp: undefined,
    });
  });
});
