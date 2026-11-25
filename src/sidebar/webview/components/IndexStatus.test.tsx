// @vitest-environment jsdom

import type {
  PostCommand,
  SidebarState,
} from "@agentlink/protocol/sidebar-transport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";

import { INITIAL_CONTEXT_HEALTH } from "@agentlink/protocol/context-health";
import type { ContextHealthSnapshot } from "@agentlink/protocol/context-health";
import { IndexStatus } from "./IndexStatus.js";

afterEach(cleanup);

function renderStatus(embeddings: ContextHealthSnapshot["embeddings"]) {
  const postCommand = vi.fn();
  render(
    <IndexStatus
      state={
        {
          contextHealth: { ...INITIAL_CONTEXT_HEALTH, embeddings },
          indexStatus: { state: "idle" },
        } as SidebarState
      }
      postCommand={postCommand as unknown as PostCommand}
    />,
  );
  return postCommand;
}

describe("IndexStatus semantic search", () => {
  it("offers the opt-in with what it sends, and the guide", () => {
    const postCommand = renderStatus({ status: "disabled", enabled: false });
    expect(
      screen.getByText(/to OpenAI and uses your OpenAI API key/),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Turn On\u2026"));
    fireEvent.click(screen.getByText("Learn More"));
    expect(postCommand.mock.calls).toEqual([
      ["enableSemanticEmbeddings"],
      ["openSemanticEmbeddingsHelp"],
    ]);
    expect(screen.queryByText("Turn Off")).toBeNull();
  });

  it("asks for a key before anything else", () => {
    const postCommand = renderStatus({
      status: "unavailable",
      enabled: true,
      reason: "Add an OpenAI API key to create embeddings.",
    });
    fireEvent.click(screen.getByText("Set API Key"));
    expect(postCommand).toHaveBeenCalledWith("setOpenaiApiKey");
    expect(screen.queryByText("Rebuild to Embed")).toBeNull();
  });

  it("offers a rebuild for partial coverage", () => {
    const postCommand = renderStatus({
      status: "degraded",
      enabled: true,
      embeddedChunkCount: 4,
      chunkCount: 10,
      reason: "Some indexed code has no embedding.",
    });
    expect(screen.getByText(/4 of 10 chunks embedded/)).toBeTruthy();
    fireEvent.click(screen.getByText("Rebuild to Embed"));
    fireEvent.click(screen.getByText("Turn Off"));
    expect(postCommand.mock.calls).toEqual([
      ["rebuildIndex"],
      ["disableSemanticEmbeddings"],
    ]);
  });

  it.each([
    ["working", "indexing"],
    ["disabled", "off"],
    ["degraded", "warning"],
    ["unavailable", "error"],
  ] as const)(
    "does not show %s as a failure unless it is one",
    (status, dot) => {
      renderStatus({ status, enabled: status !== "disabled" });
      expect(
        document
          .querySelector(".embedding-status .dot")
          ?.classList.contains(dot),
      ).toBe(true);
      expect(Boolean(screen.queryByText(/indexing/))).toBe(
        status === "working",
      );
    },
  );

  it("has nothing to fix when ready, and hides when not provided", () => {
    renderStatus({
      status: "ready",
      enabled: true,
      embeddedChunkCount: 10,
      chunkCount: 10,
    });
    expect(screen.queryByText("Rebuild to Embed")).toBeNull();
    cleanup();
    renderStatus(undefined);
    expect(screen.queryByText("Learn More")).toBeNull();
  });
});
