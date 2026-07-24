// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";

import type { ChatMessage } from "../types";
import { WarningRow } from "./WarningRow";

afterEach(() => {
  cleanup();
});

function warningMessage(text: string): ChatMessage {
  return {
    id: "warn-1",
    role: "warning",
    content: "",
    timestamp: 0,
    blocks: [],
    warningMessage: text,
  };
}

describe("WarningRow", () => {
  it("presents overloaded retries as a provider-side issue that needs waiting", () => {
    render(
      <WarningRow
        messages={[
          warningMessage(
            "API error 529: Overloaded — retrying request in 2s (attempt 1/8)",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Provider is overloaded")).toBeTruthy();
    expect(
      screen.getByText(/issues on their end.*keep retrying/i),
    ).toBeTruthy();
  });

  it("keeps the generic hint for non-overloaded warnings", () => {
    render(
      <WarningRow
        messages={[
          warningMessage("fetch failed — retrying request in 2s (attempt 1/4)"),
        ]}
      />,
    );

    expect(screen.getByText("Connection interrupted")).toBeTruthy();
    expect(
      screen.getByText(/the agent is still running; no action is needed/i),
    ).toBeTruthy();
  });
});
