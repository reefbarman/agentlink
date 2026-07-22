// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorktreeSetupPanel } from "./WorktreeSetupPanel";

afterEach(cleanup);

describe("WorktreeSetupPanel", () => {
  it("shows a configured draft and launches it explicitly", () => {
    const onLaunch = vi.fn();
    const config = {
      task: "Alternative auth",
      prompt: "Prototype the alternative auth flow",
      branch: "experiment/auth",
    };
    render(
      <WorktreeSetupPanel
        state={{
          requestId: "setup-1",
          input: "",
          answer: "Configuration ready.",
          phase: "ready",
          config,
        }}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        onLaunch={onLaunch}
        onReply={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Prototype the alternative auth flow"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create & start" }));
    expect(onLaunch).toHaveBeenCalledWith("setup-1", true);

    fireEvent.click(screen.getByRole("button", { name: "Create & prefill" }));
    expect(onLaunch).toHaveBeenLastCalledWith("setup-1", false);
  });

  it("offers cancellation while the setup agent is running", () => {
    const onCancel = vi.fn();
    render(
      <WorktreeSetupPanel
        state={{
          requestId: "setup-2",
          input: "",
          answer: "",
          phase: "configuring",
        }}
        onCancel={onCancel}
        onDismiss={vi.fn()}
        onLaunch={vi.fn()}
        onReply={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel worktree setup" }),
    );
    expect(onCancel).toHaveBeenCalledWith("setup-2");
  });

  it("accepts a plain-text reply to the setup agent", () => {
    const onReply = vi.fn();
    render(
      <WorktreeSetupPanel
        state={{
          requestId: "setup-3",
          input: "",
          answer: "What should the worktree agent do?",
          phase: "awaiting_input",
          conversation: [
            {
              role: "assistant",
              text: "What should the worktree agent do?",
            },
          ],
        }}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        onLaunch={vi.fn()}
        onReply={onReply}
      />,
    );

    const reply = screen.getByRole("textbox", {
      name: "Reply to worktree setup agent",
    });
    fireEvent.input(reply, { target: { value: "Prototype passkeys" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onReply).toHaveBeenCalledWith("setup-3", "Prototype passkeys");
  });

  it("uses only the header dismiss action after launch completes", () => {
    render(
      <WorktreeSetupPanel
        state={{
          requestId: "setup-4",
          input: "",
          answer: "",
          phase: "opened",
          message: "Worktree opened.",
        }}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
        onLaunch={vi.fn()}
        onReply={vi.fn()}
      />,
    );

    expect(screen.getByTitle("Dismiss")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
