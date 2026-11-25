// @vitest-environment jsdom

import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { PathCard } from "./PathCard.js";

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
        followUpRef={{ current: "" }}
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

  it("allows the file's folder for the session in one click", () => {
    const submit = vi.fn<(data: Omit<DecisionMessage, "type">) => void>();
    render(
      <PathCard
        request={{
          kind: "path",
          id: "outside-read-2",
          filePath: "/outside/project/src/example.ts",
        }}
        submit={submit}
        followUpRef={{ current: "" }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Allow Folder for Session" }),
    );
    expect(submit).toHaveBeenCalledWith({
      id: "outside-read-2",
      decision: "allow-session",
      rulePattern: "/outside/project/src/",
      ruleMode: "prefix",
      followUp: undefined,
    });
  });

  it("enables the rule from a match mode and swaps the default pattern", () => {
    const submit = vi.fn<(data: Omit<DecisionMessage, "type">) => void>();
    render(
      <PathCard
        request={{
          kind: "path",
          id: "outside-read-3",
          filePath: "/outside/project/src/example.ts",
        }}
        submit={submit}
        followUpRef={{ current: "" }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Auto Approval Rules" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Glob" }));

    expect(
      document.querySelector<HTMLTextAreaElement>(".rule-pattern-input")!.value,
    ).toBe("/outside/project/src/*");
    // The one-click shortcut steps aside once a rule is being edited.
    expect(
      screen.queryByRole("button", { name: "Allow Folder for Session" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Rule & Allow" }));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow-session",
        rulePattern: "/outside/project/src/*",
        ruleMode: "glob",
      }),
    );
  });
});
