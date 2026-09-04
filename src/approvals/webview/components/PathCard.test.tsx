// @vitest-environment jsdom

import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { PathCard } from "./PathCard.js";
import { createRef } from "preact";

afterEach(cleanup);

describe("PathCard", () => {
  it("uses the shared outside-path rule layout and ordering", () => {
    const request: ApprovalRequest = {
      kind: "path",
      id: "outside-read-1",
      filePath: "/outside/project/src/example.ts",
    };

    render(
      <PathCard
        request={request}
        submit={vi.fn<(data: Omit<DecisionMessage, "type">) => void>()}
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
    expect((modes[0] as HTMLInputElement).checked).toBe(true);
    expect(
      ["Session", "Project", "Global", "Skip"].map(
        (name) => screen.getByRole("button", { name }).textContent,
      ),
    ).toEqual(["Session", "Project", "Global", "Skip"]);
  });
});
