// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import type {
  ContentBlock,
  RemoteFinalResultDetail,
} from "@agentlink/protocol/chat-transcript";
import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";
import {
  RemoteToolDetailProvider,
  useRemoteToolDetail,
  useRemoteFinalResult,
} from "./RemoteToolDetail";

const projected = {
  type: "tool_call",
  id: "call-1",
  name: "read_file",
  inputJson: '{"path":"src/index.ts"}',
  result: "",
  complete: false,
  remoteDetail: {
    messageId: "message-1",
    contentRevision: 1,
    available: true,
  },
} satisfies Extract<ContentBlock, { type: "tool_call" }>;

function DetailHarness({ block = projected }: { block?: typeof projected }) {
  const [expanded, setExpanded] = useState(false);
  const detail = useRemoteToolDetail(block, expanded);
  return (
    <div>
      <button type="button" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Close" : "Open"}
      </button>
      {detail.loading && <span>loading</span>}
      <span>{detail.block.result || "empty"}</span>
      {detail.error && <span role="alert">{detail.error}</span>}
      <button type="button" onClick={detail.retry}>
        Retry
      </button>
    </div>
  );
}

function FinalResultHarness({
  reference,
}: {
  reference?: RemoteFinalResultDetail;
}) {
  const { result, loading, error, retry } = useRemoteFinalResult(reference);
  return (
    <div>
      {loading && <span>loading result</span>}
      {result?.type === "text" && <span>{result.text}</span>}
      {error && <span role="alert">{error}</span>}
      <button onClick={retry}>Retry result</button>
    </div>
  );
}

import { useState } from "preact/hooks";

afterEach(cleanup);

describe("RemoteToolDetailProvider", () => {
  it("loads final results on demand, deduplicates consumers and resets cache with scope", async () => {
    const reference = { messageId: "final-1", contentRevision: 3 };
    const loadFinalResult = vi.fn(async (): Promise<FleetResultEnvelope> => ({
      type: "text",
      text: "full final answer",
    }));
    const view = (scopeKey: string, mounted: boolean) => (
      <RemoteToolDetailProvider
        scopeKey={scopeKey}
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        {mounted && (
          <>
            <FinalResultHarness reference={reference} />
            <FinalResultHarness reference={reference} />
          </>
        )}
      </RemoteToolDetailProvider>
    );
    const { rerender } = render(view("session-a", false));
    expect(loadFinalResult).not.toHaveBeenCalled();
    rerender(view("session-a", true));
    await waitFor(() =>
      expect(screen.getAllByText("full final answer")).toHaveLength(2),
    );
    expect(loadFinalResult).toHaveBeenCalledTimes(1);
    rerender(view("session-a", false));
    rerender(view("session-a", true));
    await waitFor(() =>
      expect(screen.getAllByText("full final answer")).toHaveLength(2),
    );
    expect(loadFinalResult).toHaveBeenCalledTimes(1);
    rerender(view("session-b", true));
    await waitFor(() => expect(loadFinalResult).toHaveBeenCalledTimes(2));
    expect(loadFinalResult).toHaveBeenLastCalledWith(reference);
  });

  it("evicts least-recently used final results at the shared byte budget", async () => {
    const payload = "x".repeat(6 * 1024 * 1024);
    const loadFinalResult = vi.fn(async (): Promise<FleetResultEnvelope> => ({
      type: "text",
      text: payload,
    }));
    function CacheHarness({ id }: { id: string }) {
      const { result } = useRemoteFinalResult({
        messageId: id,
        contentRevision: 1,
      });
      return <span>{result ? id : "loading"}</span>;
    }
    const view = (id: string, mount = true) => (
      <RemoteToolDetailProvider
        scopeKey="bounded"
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        {mount && <CacheHarness key={id} id={id} />}
      </RemoteToolDetailProvider>
    );
    const { rerender } = render(view("first"));
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());
    rerender(view("second"));
    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    rerender(view("third"));
    await waitFor(() => expect(screen.getByText("third")).toBeTruthy());
    expect(loadFinalResult).toHaveBeenCalledTimes(3);
    rerender(view("third", false));
    rerender(view("third"));
    await waitFor(() => expect(screen.getByText("third")).toBeTruthy());
    expect(loadFinalResult).toHaveBeenCalledTimes(3);
    rerender(view("first"));
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());
    expect(loadFinalResult).toHaveBeenCalledTimes(4);
  });

  it("does not cache failed final results and retries with the current loader", async () => {
    const reference = { messageId: "final-1", contentRevision: 1 };
    const failed = vi.fn(async (): Promise<FleetResultEnvelope> => {
      throw new Error("Result expired");
    });
    const recovered = vi.fn(async (): Promise<FleetResultEnvelope> => ({
      type: "text",
      text: "recovered answer",
    }));
    const view = (loadFinalResult: typeof failed) => (
      <RemoteToolDetailProvider
        scopeKey="session"
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        <FinalResultHarness reference={reference} />
      </RemoteToolDetailProvider>
    );
    const { rerender } = render(view(failed));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Result expired"),
    );
    rerender(view(recovered));
    fireEvent.click(screen.getByRole("button", { name: "Retry result" }));
    await waitFor(() =>
      expect(screen.getByText("recovered answer")).toBeTruthy(),
    );
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores late final results after the reference changes", async () => {
    const resolvers: Array<(result: FleetResultEnvelope) => void> = [];
    const loadFinalResult = vi.fn(
      () =>
        new Promise<FleetResultEnvelope>((resolve) => resolvers.push(resolve)),
    );
    const view = (contentRevision: number) => (
      <RemoteToolDetailProvider
        scopeKey="session"
        loadDetail={async (block) => block}
        loadFinalResult={loadFinalResult}
      >
        <FinalResultHarness
          reference={{ messageId: "final-1", contentRevision }}
        />
      </RemoteToolDetailProvider>
    );
    const { rerender } = render(view(1));
    await waitFor(() => expect(loadFinalResult).toHaveBeenCalledTimes(1));
    rerender(view(2));
    await waitFor(() => expect(loadFinalResult).toHaveBeenCalledTimes(2));
    resolvers[1]({ type: "text", text: "current final answer" });
    await waitFor(() =>
      expect(screen.getByText("current final answer")).toBeTruthy(),
    );
    resolvers[0]({ type: "text", text: "stale final answer" });
    await waitFor(() =>
      expect(screen.queryByText("stale final answer")).toBeNull(),
    );
    expect(screen.getByText("current final answer")).toBeTruthy();
  });

  it("reports unavailable final results without a provider or loader", async () => {
    const reference = { messageId: "final-1", contentRevision: 1 };
    const { unmount } = render(<FinalResultHarness reference={reference} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Final result is unavailable.",
    );
    unmount();
    render(
      <RemoteToolDetailProvider
        scopeKey="session"
        loadDetail={async (block) => block}
      >
        <FinalResultHarness reference={reference} />
      </RemoteToolDetailProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Final results are unavailable.",
      ),
    );
  });

  it("loads only after expansion and shares the cached detail within its scope", async () => {
    const loaded = { ...projected, result: "completed result", complete: true };
    const loadDetail = vi.fn(async () => loaded);
    const { rerender } = render(
      <RemoteToolDetailProvider scopeKey="session-a" loadDetail={loadDetail}>
        <DetailHarness />
      </RemoteToolDetailProvider>,
    );

    expect(loadDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("completed result")).toBeTruthy(),
    );
    expect(loadDetail).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("completed result")).toBeTruthy(),
    );
    expect(loadDetail).toHaveBeenCalledTimes(1);

    rerender(
      <RemoteToolDetailProvider
        scopeKey="session-b"
        loadDetail={vi.fn(async () => ({ ...loaded, result: "other scope" }))}
      >
        <DetailHarness />
      </RemoteToolDetailProvider>,
    );
  });

  it("does not share cached detail between provider scopes", async () => {
    const firstLoader = vi.fn(async () => ({ ...projected, result: "first" }));
    const secondLoader = vi.fn(async () => ({
      ...projected,
      result: "second",
    }));
    render(
      <>
        <RemoteToolDetailProvider scopeKey="scope-a" loadDetail={firstLoader}>
          <DetailHarness />
        </RemoteToolDetailProvider>
        <RemoteToolDetailProvider scopeKey="scope-b" loadDetail={secondLoader}>
          <DetailHarness />
        </RemoteToolDetailProvider>
      </>,
    );

    const openButtons = screen.getAllByRole("button", { name: "Open" });
    fireEvent.click(openButtons[0]);
    fireEvent.click(openButtons[1]);
    await waitFor(() => {
      expect(firstLoader).toHaveBeenCalledTimes(1);
      expect(secondLoader).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText("first")).toBeTruthy();
      expect(screen.getByText("second")).toBeTruthy();
    });
  });

  it("keeps the last detail visible while an updated revision loads", async () => {
    let resolveUpdate!: (block: typeof projected) => void;
    const loadDetail = vi
      .fn()
      .mockResolvedValueOnce({ ...projected, result: "previous result" })
      .mockImplementationOnce(
        () =>
          new Promise<typeof projected>((resolve) => {
            resolveUpdate = resolve;
          }),
      );
    const { rerender } = render(
      <RemoteToolDetailProvider scopeKey="session" loadDetail={loadDetail}>
        <DetailHarness />
      </RemoteToolDetailProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("previous result")).toBeTruthy(),
    );
    rerender(
      <RemoteToolDetailProvider scopeKey="session" loadDetail={loadDetail}>
        <DetailHarness
          block={{
            ...projected,
            remoteDetail: { ...projected.remoteDetail, contentRevision: 2 },
          }}
        />
      </RemoteToolDetailProvider>,
    );
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(2));
    expect(screen.getByText("previous result")).toBeTruthy();
    resolveUpdate({ ...projected, result: "updated result" });
    await waitFor(() =>
      expect(screen.getByText("updated result")).toBeTruthy(),
    );
  });

  it("skips queued revisions that are no longer wanted", async () => {
    const resolvers: Array<(block: typeof projected) => void> = [];
    const loadDetail = vi.fn(
      (_block: Extract<ContentBlock, { type: "tool_call" | "skill_load" }>) =>
        new Promise<typeof projected>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = (revision: number) => (
      <RemoteToolDetailProvider scopeKey="session" loadDetail={loadDetail}>
        {["first", "second", "third"].map((id) => (
          <DetailHarness
            key={id}
            block={{
              ...projected,
              id,
              remoteDetail: {
                ...projected.remoteDetail,
                contentRevision: id === "third" ? revision : 1,
              },
            }}
          />
        ))}
      </RemoteToolDetailProvider>
    );
    const { rerender } = render(view(1));
    for (const button of screen.getAllByRole("button", { name: "Open" }))
      fireEvent.click(button);
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(2));
    rerender(view(2));
    await waitFor(() => expect(screen.getAllByText("loading")).toHaveLength(3));
    resolvers[0]({ ...projected, id: "first", result: "first result" });
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(3));
    expect(loadDetail.mock.calls[2][0].remoteDetail?.contentRevision).toBe(2);
  });

  it("ignores a late response from an older content revision", async () => {
    const resolvers: Array<
      (block: Extract<ContentBlock, { type: "tool_call" }>) => void
    > = [];
    const loadDetail = vi.fn(
      () =>
        new Promise<Extract<ContentBlock, { type: "tool_call" }>>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { rerender } = render(
      <RemoteToolDetailProvider scopeKey="session" loadDetail={loadDetail}>
        <DetailHarness />
      </RemoteToolDetailProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    rerender(
      <RemoteToolDetailProvider scopeKey="session" loadDetail={loadDetail}>
        <DetailHarness
          block={{
            ...projected,
            remoteDetail: { ...projected.remoteDetail!, contentRevision: 2 },
          }}
        />
      </RemoteToolDetailProvider>,
    );
    await waitFor(() => expect(loadDetail).toHaveBeenCalledTimes(2));
    resolvers[0]({ ...projected, result: "stale result", complete: true });
    expect(screen.getByText("loading")).toBeTruthy();
    resolvers[1]({ ...projected, result: "current result", complete: true });
    await waitFor(() =>
      expect(screen.getByText("current result")).toBeTruthy(),
    );
    expect(screen.queryByText("stale result")).toBeNull();
  });
});
