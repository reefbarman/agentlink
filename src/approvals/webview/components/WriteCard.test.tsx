// @vitest-environment jsdom

import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { WriteCard } from "./WriteCard.js";
import { createRef } from "preact";

afterEach(cleanup);

describe("WriteCard", () => {
  it("reveals a file diff without resolving the approval", () => {
    const submit = vi.fn<(data: Omit<DecisionMessage, "type">) => void>();
    const onRevealDiff = vi.fn();
    const request: ApprovalRequest = {
      kind: "write",
      id: "diff-request-1",
      filePath: "src/example.ts",
      writeOperation: "modify",
    };

    render(
      <WriteCard
        request={request}
        submit={submit}
        followUpRef={createRef<string>()}
        onRevealDiff={onRevealDiff}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reveal diff in editor" }),
    );

    expect(onRevealDiff).toHaveBeenCalledWith("diff-request-1");
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses the shared outside-path rule layout and ordering", () => {
    const request: ApprovalRequest = {
      kind: "write",
      id: "outside-write-1",
      filePath: "/outside/project/src/example.ts",
      writeOperation: "modify",
      outsideWorkspace: true,
    };

    render(
      <WriteCard
        request={request}
        submit={vi.fn()}
        followUpRef={createRef<string>()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Auto Approval Rules" }),
    );
    expect(screen.getByText("Matching path:")).toBeTruthy();
    const modeLabels = ["Prefix", "Exact", "Glob"];
    const modes = modeLabels.map((name) => screen.getByRole("radio", { name }));
    expect(modes.map((mode) => mode.parentElement?.textContent)).toEqual(
      modeLabels,
    );
    expect((modes[1] as HTMLInputElement).checked).toBe(true);
    expect(
      ["Session", "Project", "Global", "Skip"].map(
        (name) => screen.getByRole("button", { name }).textContent,
      ),
    ).toEqual(["Session", "Project", "Global", "Skip"]);
  });

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
    expect(
      screen.queryByRole("button", { name: "Reveal diff in editor" }),
    ).toBeNull();
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
