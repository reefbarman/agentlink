// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";
import { RemoteFinalMarkerResult } from "./RemoteFinalMarkerResult";
import { RemoteToolDetailProvider } from "./RemoteToolDetail";
import { StreamingText } from "./StreamingText";

vi.mock("./StreamingText", () => ({
  StreamingText: vi.fn(({ text }: { text: string }) => <div>{text}</div>),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const reference = { messageId: "final-1", contentRevision: 123 };

describe("RemoteFinalMarkerResult", () => {
  it("shows loading, then renders the existing final result with navigation and citation props", async () => {
    let resolve!: (result: FleetResultEnvelope) => void;
    const loadFinalResult = vi.fn(
      () =>
        new Promise<FleetResultEnvelope>((done) => {
          resolve = done;
        }),
    );
    const onOpenFile = vi.fn();
    const onOpenSpecialBlockPanel = vi.fn();
    const citations = [{ url: "https://example.com", title: "Reference" }];
    render(
      <RemoteToolDetailProvider
        scopeKey="session"
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        <RemoteFinalMarkerResult
          reference={reference}
          summary="Overview"
          citations={citations}
          onOpenFile={onOpenFile}
          onOpenSpecialBlockPanel={onOpenSpecialBlockPanel}
        />
      </RemoteToolDetailProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("Loading result…");
    await waitFor(() =>
      expect(loadFinalResult).toHaveBeenCalledWith(reference),
    );
    resolve({
      type: "review_findings",
      reviewedScope: "HEAD~1..HEAD",
      emptyDiff: false,
      findings: [
        {
          severity: "high",
          message: "Full finding detail",
          path: "src/a.ts",
          line: 12,
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByText("Full finding detail")).toBeTruthy(),
    );
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts:12" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts", 12);
    expect(vi.mocked(StreamingText).mock.calls.at(-1)?.[0]).toMatchObject({
      citations,
      onOpenFile,
      onOpenSpecialBlockPanel,
      streaming: false,
    });
  });

  it("forwards the summary so an identical text result is not rendered twice", async () => {
    const loadFinalResult = vi.fn(async (): Promise<FleetResultEnvelope> => ({
      type: "text",
      text: "Same summary",
    }));
    const { container } = render(
      <RemoteToolDetailProvider
        scopeKey="session"
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        <RemoteFinalMarkerResult
          reference={reference}
          summary="Same summary"
          citations={[]}
        />
      </RemoteToolDetailProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(container.textContent).toBe("");
  });

  it.each([
    "This result exceeds the 8 MiB detail delivery limit.",
    "This result is no longer available in the selected session.",
  ])("shows a useful loading error and allows retry: %s", async (message) => {
    const loadFinalResult = vi
      .fn<() => Promise<FleetResultEnvelope>>()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce({ type: "text", text: "Recovered final result" });
    render(
      <RemoteToolDetailProvider
        scopeKey="session"
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        <RemoteFinalMarkerResult reference={reference} citations={[]} />
      </RemoteToolDetailProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(message),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry result" }));
    await waitFor(() =>
      expect(screen.getByText("Recovered final result")).toBeTruthy(),
    );
    expect(loadFinalResult).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not silently omit results when the provider is unavailable", () => {
    render(<RemoteFinalMarkerResult reference={reference} citations={[]} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Final result is unavailable.",
    );
  });
});
