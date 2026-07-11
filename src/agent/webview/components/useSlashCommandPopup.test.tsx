// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import type { SlashCommandInfo } from "../types";
import { useRef } from "preact/hooks";
import { useSlashCommandPopup } from "./useSlashCommandPopup";

const commands: SlashCommandInfo[] = [
  {
    name: "mode",
    description: "Switch mode",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp",
    description: "Open MCP",
    source: "builtin",
    builtin: true,
  },
  {
    name: "mcp-refresh",
    description: "Refresh MCP",
    source: "builtin",
    builtin: true,
  },
];

function Harness({ matchedName }: { matchedName?: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const matchedCommand =
    commands.find((command) => command.name === matchedName) ?? null;
  const popup = useSlashCommandPopup({
    commands,
    modes: [
      { slug: "code", name: "Code", icon: "code" },
      { slug: "ask", name: "Ask", icon: "question" },
    ],
    currentMode: "code",
    availableModels: [],
    currentModel: "claude-sonnet-4-6",
    matchedCommand,
    inputWrapperRef: wrapperRef,
  });

  return (
    <div>
      <div ref={wrapperRef} data-testid="wrapper" />
      <div ref={popup.popupRef} data-testid="popup" />
      <output data-testid="state">
        {JSON.stringify({
          open: popup.open,
          start: popup.start,
          view: popup.view,
          selectedIndex: popup.selectedIndex,
          visible: popup.visible,
          commands: popup.filteredCommands.map((command) => command.name),
        })}
      </output>
      <button onClick={() => popup.openAt(4)}>open</button>
      <button onClick={() => popup.updateFromInput("say /mc", 7)}>query</button>
      <button onClick={() => popup.updateFromInput("say /mcp args", 13)}>
        args
      </button>
      <button onClick={() => popup.updateFromInput("say ", 4)}>
        backtrack
      </button>
      <button onClick={() => popup.enterView("mode")}>mode</button>
      <button onClick={popup.back}>back</button>
      <button onClick={() => popup.selectNext(popup.filteredCommands.length)}>
        next
      </button>
      <button
        onClick={() => popup.selectPrevious(popup.filteredCommands.length)}
      >
        previous
      </button>
    </div>
  );
}

function state(container: ParentNode) {
  return JSON.parse(
    container.querySelector('[data-testid="state"]')?.textContent ?? "{}",
  ) as {
    open: boolean;
    start: number;
    view: string;
    selectedIndex: number;
    visible: boolean;
    commands: string[];
  };
}

afterEach(() => {
  cleanup();
});

describe("useSlashCommandPopup", () => {
  it("opens, filters, and resets selection when the query changes", () => {
    const { container, getByText } = render(<Harness />);

    fireEvent.click(getByText("open"));
    expect(state(container)).toMatchObject({
      open: true,
      start: 4,
      selectedIndex: 0,
      visible: true,
      commands: ["mode", "mcp", "mcp-refresh"],
    });

    fireEvent.click(getByText("next"));
    fireEvent.click(getByText("query"));
    expect(state(container)).toMatchObject({
      selectedIndex: 0,
      commands: ["mcp", "mcp-refresh"],
    });
    fireEvent.click(getByText("args"));
    expect(state(container)).toMatchObject({
      open: true,
      commands: ["mcp", "mcp-refresh"],
    });
    fireEvent.click(getByText("backtrack"));
    expect(state(container)).toMatchObject({ open: false, start: -1 });
  });

  it("builds subviews, navigates back, and wraps selection", () => {
    const { container, getByText } = render(<Harness />);
    fireEvent.click(getByText("open"));
    fireEvent.click(getByText("mode"));

    expect(state(container)).toMatchObject({
      view: "mode",
      selectedIndex: 0,
      commands: ["__mode:code", "__mode:ask"],
    });
    fireEvent.click(getByText("previous"));
    expect(state(container).selectedIndex).toBe(1);
    fireEvent.click(getByText("next"));
    expect(state(container).selectedIndex).toBe(0);
    fireEvent.click(getByText("back"));
    expect(state(container)).toMatchObject({ view: "main", selectedIndex: 0 });
  });

  it("keeps exact prefix alternatives visible and dismisses from the document", () => {
    const { container, getByText } = render(<Harness matchedName="mcp" />);
    fireEvent.click(getByText("open"));
    expect(state(container).visible).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(state(container)).toMatchObject({
      open: false,
      start: -1,
      view: "main",
      selectedIndex: 0,
    });

    fireEvent.click(getByText("open"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(state(container).open).toBe(false);
  });

  it("does not dismiss for clicks inside the wrapper or popup", () => {
    const { container, getByText, getByTestId } = render(<Harness />);
    fireEvent.click(getByText("open"));

    fireEvent.pointerDown(getByTestId("wrapper"));
    fireEvent.pointerDown(getByTestId("popup"));

    expect(state(container).open).toBe(true);
  });
});
