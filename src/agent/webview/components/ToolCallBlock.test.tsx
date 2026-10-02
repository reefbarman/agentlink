// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";

import { RemoteToolDetailProvider } from "./RemoteToolDetail";
import { ToolCallBlock } from "./ToolCallBlock";

afterEach(cleanup);

describe("ToolCallBlock remote details", () => {
  it("shows media delivery warnings and retries partial results instead of caching them", async () => {
    const projected = {
      type: "tool_call" as const,
      id: "partial-call",
      name: "read_file",
      inputJson: "{}",
      result: "",
      complete: true,
      remoteDetail: {
        messageId: "message",
        contentRevision: 1,
        available: true,
        imageCount: 1,
      },
    };
    const loadDetail = vi
      .fn()
      .mockResolvedValueOnce({
        ...projected,
        result: "usable text",
        remoteDetail: {
          ...projected.remoteDetail,
          warning: "Image 1: too large",
        },
      })
      .mockResolvedValueOnce({
        ...projected,
        result: "usable text",
        resultImages: [{ mimeType: "image/png", data: "YWJj" }],
      });
    render(
      <RemoteToolDetailProvider scopeKey="session" loadDetail={loadDetail}>
        <ToolCallBlock toolCall={projected} />
      </RemoteToolDetailProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));
    await waitFor(() =>
      expect(screen.getByText("Image 1: too large")).toBeTruthy(),
    );
    expect(screen.getByText("usable text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByAltText("read_file result image 1")).toBeTruthy(),
    );
    expect(screen.queryByText("Image 1: too large")).toBeNull();
    expect(loadDetail).toHaveBeenCalledTimes(2);
  });

  it("loads completed input, result, and media after expanding a running projection", async () => {
    const projected = {
      type: "tool_call" as const,
      id: "remote-call",
      name: "read_file",
      inputJson: '{"path":"src/index.ts"}',
      result: "",
      complete: false,
      remoteDetail: {
        messageId: "message",
        contentRevision: 3,
        available: true,
        imageCount: 1,
      },
    };
    const loadDetail = vi.fn(async () => ({
      ...projected,
      complete: true,
      result: "file contents loaded",
      resultImages: [{ mimeType: "image/png", data: "YWJj" }],
    }));
    render(
      <RemoteToolDetailProvider
        scopeKey="browser-session"
        loadDetail={loadDetail}
      >
        <ToolCallBlock toolCall={projected} />
      </RemoteToolDetailProvider>,
    );

    expect(loadDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));
    expect(screen.getByText(/Loading full tool detail/)).toBeTruthy();
    expect(screen.getByText("Input")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("file contents loaded")).toBeTruthy(),
    );
    expect(screen.getByAltText("read_file result image 1")).toBeTruthy();
    expect(loadDetail).toHaveBeenCalledTimes(1);
  });

  it("shows unavailable and loader errors with a retry action, leaving local calls alone", async () => {
    const unavailable = {
      type: "tool_call" as const,
      id: "old-call",
      name: "read_file",
      inputJson: "{}",
      result: "",
      complete: false,
      remoteDetail: {
        messageId: "message",
        contentRevision: 1,
        available: false,
      },
    };
    const loadDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        ...unavailable,
        id: "retry-call",
        complete: true,
        result: "loaded",
      });
    const { rerender } = render(
      <RemoteToolDetailProvider
        scopeKey="browser-session"
        loadDetail={loadDetail}
      >
        <ToolCallBlock toolCall={unavailable} />
      </RemoteToolDetailProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));
    expect(
      screen.getByText(/unavailable in this AgentLink version/),
    ).toBeTruthy();
    expect(loadDetail).not.toHaveBeenCalled();

    const retryable = {
      ...unavailable,
      id: "retry-call",
      remoteDetail: { ...unavailable.remoteDetail, available: true },
    };
    rerender(
      <RemoteToolDetailProvider
        scopeKey="browser-session"
        loadDetail={loadDetail}
      >
        <ToolCallBlock toolCall={retryable} />
      </RemoteToolDetailProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "temporary failure",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("loaded")).toBeTruthy());
    expect(loadDetail).toHaveBeenCalledTimes(2);

    const local = {
      type: "tool_call" as const,
      id: "local-call",
      name: "read_file",
      inputJson: "{}",
      result: "local result",
      complete: true,
    };
    rerender(<ToolCallBlock toolCall={local} />);
    fireEvent.click(screen.getByRole("button", { name: /read_file/i }));
    expect(screen.getByText("local result")).toBeTruthy();
  });
});
