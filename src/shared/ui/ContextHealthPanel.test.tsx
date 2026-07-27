// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { ContextHealthPanel } from "./ContextHealthPanel";
import type { ContextHealthSnapshot } from "../contextHealth";

afterEach(cleanup);

function health(
  overrides: Partial<ContextHealthSnapshot> = {},
): ContextHealthSnapshot {
  return {
    memory: {
      status: "ready",
      retrieval: "hybrid",
      activeRecordCount: 7,
    },
    retrieval: {
      status: "degraded",
      lexical: "ready",
      vector: "unavailable",
      structural: "ready",
      sourceCount: 12,
      chunkCount: 48,
      staleSourceCount: 2,
      reason: "Vector retrieval is unavailable.",
    },
    index: {
      status: "working",
      state: "indexing",
      current: 3,
      total: 10,
      totalFilesInIndex: 8,
      totalChunksInIndex: 32,
    },
    ...overrides,
  };
}

describe("ContextHealthPanel", () => {
  it("renders compact normalized status chips", () => {
    const { container } = render(<ContextHealthPanel health={health()} />);

    expect(screen.getByText("Context health")).toBeTruthy();
    expect(container.querySelectorAll(".context-health-chip")).toHaveLength(3);
    expect(screen.getByLabelText("Memory: Ready")).toBeTruthy();
    expect(screen.getByLabelText("Retrieval: Degraded")).toBeTruthy();
    expect(screen.getByLabelText("Index: Working")).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll(".context-health-chip-status"),
        (element) => element.textContent,
      ),
    ).toEqual(["Ready", "Degraded", "Working"]);
  });

  it("renders normalized details when expanded", () => {
    const { container } = render(<ContextHealthPanel health={health()} />);
    fireEvent.click(container.querySelector("summary")!);

    expect(screen.getByText("Active records:")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("Vector retrieval is unavailable.")).toBeTruthy();
    expect(screen.getByText("3/10")).toBeTruthy();
    expect(screen.getByText("48")).toBeTruthy();
  });

  it.each([
    ["ready", "Ready"],
    ["working", "Working"],
    ["degraded", "Degraded"],
    ["unavailable", "Unavailable"],
    ["disabled", "Disabled"],
    ["not_measured", "Not yet measured"],
  ] as const)("renders %s status", (status, label) => {
    render(
      <ContextHealthPanel
        health={health({
          memory: {
            status,
            retrieval: "not_measured",
            reason: "Health has not been measured yet.",
          },
        })}
      />,
    );

    expect(
      Array.from(document.querySelectorAll(".context-health-chip-status")).some(
        (element) => element.textContent === label,
      ),
    ).toBe(true);
  });

  it("renders only the bounded snapshot rather than backend details", () => {
    render(
      <ContextHealthPanel
        health={health({
          memory: {
            status: "unavailable",
            retrieval: "unavailable",
            reason: "Autonomous memory is unavailable.",
          },
        })}
      />,
    );

    expect(document.body.textContent).not.toContain("/Users/");
    expect(document.body.textContent).not.toContain("LanceDB");
  });
});
