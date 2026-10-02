// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import {
  RemoteToolDetailProvider,
  useRemoteToolDetail,
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

import { useState } from "preact/hooks";

afterEach(cleanup);

describe("RemoteToolDetailProvider", () => {
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
