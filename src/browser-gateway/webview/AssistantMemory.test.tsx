// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemoryPanel,
  RememberedStrip,
  type MemoryEntry,
} from "./AssistantMemory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ENTRY: MemoryEntry = {
  id: "m1",
  revision: 1,
  kind: "preference",
  statement: "Prefers short answers",
  status: "active",
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  source: {
    projectId: "home",
    sessionId: "chat-1",
    observedAt: "2026-10-16T00:00:00.000Z",
    words: "I prefer short answers",
  },
};

describe("RememberedStrip", () => {
  it("shows nothing without memories, and undoes one", async () => {
    const { container, rerender } = render(<RememberedStrip memories={[]} />);
    expect(container.innerHTML).toBe("");
    const onUndo = vi.fn(async () => undefined);
    rerender(
      <RememberedStrip
        memories={[
          { id: "m1", statement: "Prefers short answers", createdAt: "" },
        ]}
        onUndo={onUndo}
      />,
    );
    expect(screen.getByText("Remembered: Prefers short answers")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledWith("m1"));
  });
});

describe("MemoryPanel", () => {
  it("lists memories with their source, and forgets one", async () => {
    const calls: string[] = [];
    let memories = [ENTRY];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/forget")) {
          memories = [];
          return new Response(JSON.stringify({ forgotten: true }));
        }
        return new Response(JSON.stringify({ memories }));
      }),
    );
    const openChat = vi.fn();
    render(<MemoryPanel onClose={() => undefined} openChat={openChat} />);
    await screen.findByText("Prefers short answers");
    expect(screen.getByText(/you said “I prefer short answers”/u)).toBeTruthy();
    expect(
      screen.getByText(/What the Assistant remembers about you/u),
    ).toBeTruthy();
    fireEvent.input(
      screen.getByRole("searchbox", { name: "Search memories" }),
      {
        target: { value: "short" },
      },
    );
    await waitFor(() => expect(calls).toContain("GET /api/memory?q=short"));
    fireEvent.input(
      screen.getByRole("searchbox", { name: "Search memories" }),
      { target: { value: "" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(openChat).toHaveBeenCalledWith("home", "chat-1");
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await screen.findByText(/Nothing remembered yet/u);
    expect(calls).toContain("POST /api/memory/m1/forget");
  });
});
