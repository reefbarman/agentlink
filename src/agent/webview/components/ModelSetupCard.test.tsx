/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ModelSetupCard } from "./ModelSetupCard";
import { h } from "preact";

const unauthenticatedModel = {
  id: "openai/gpt-5",
  displayName: "GPT-5",
  provider: "codex",
  providerDisplayName: "ChatGPT/Codex",
  authenticated: false,
  readiness: {
    status: "credentials_required" as const,
    action: { kind: "oauth" as const, providerId: "codex" },
  },
  authAction: { kind: "oauth" as const, providerId: "codex" },
};

describe("ModelSetupCard", () => {
  afterEach(() => cleanup());

  it("offers credential setup actions for an unauthenticated VS Code model", () => {
    const onSetupAction = vi.fn();
    render(
      h(ModelSetupCard, {
        setupState: {
          kind: "credentials_required",
          model: unauthenticatedModel,
        },
        hasWorkspace: true,
        surface: "vscode",
        onSetupAction,
      }),
    );

    expect(screen.getByText("Set up AgentLink")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with ChatGPT/Codex" }),
    );
    expect(onSetupAction).toHaveBeenCalledWith("codex", "codex");
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Use OpenAI API key" }),
    ).toBeTruthy();
  });

  it("keeps browser setup host-owned", () => {
    render(
      h(ModelSetupCard, {
        setupState: {
          kind: "credentials_required",
          model: unauthenticatedModel,
        },
        hasWorkspace: true,
        surface: "browser",
      }),
    );

    expect(
      screen.getByText(
        "Finish model setup in the AgentLink VS Code window. Credentials stay on that host.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue with ChatGPT/Codex" }),
    ).toBeNull();
  });

  it("shows ready guidance and can open a folder from projectless VS Code", () => {
    const onOpenFolder = vi.fn();
    render(
      h(ModelSetupCard, {
        setupState: {
          kind: "ready",
          model: { ...unauthenticatedModel, authenticated: true },
        },
        hasWorkspace: false,
        surface: "vscode",
        onOpenFolder,
      }),
    );

    expect(screen.getByText("Ready to start")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Folder" }));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });
});
