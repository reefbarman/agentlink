/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { InputArea } from "./InputArea";
import { h } from "preact";

const SEARCH_REQUEST_COMMAND = "agentSearchFiles";
const SELECTED_PATH = "src/agent/webview/components/InputArea.tsx";

function stubScrollIntoView() {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
}

function stubAnimationFrame() {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
}

describe("InputArea file picker inline completion", () => {
  beforeEach(() => {
    stubScrollIntoView();
    stubAnimationFrame();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the selected @path inline while attaching the file", async () => {
    const postMessage = vi.fn();
    const { container } = render(
      h(InputArea, {
        onSend: vi.fn(),
        onStop: vi.fn(),
        streaming: false,
        reasoningEffort: "none",
        onSetReasoningEffort: vi.fn(),
        onExportTranscript: vi.fn(),
        hasMessages: false,
        vscodeApi: { postMessage },
        injection: null,
        onInjectionConsumed: vi.fn(),
        slashCommands: [],
      }),
    );

    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    expect(input).toBeTruthy();

    input.value = "@";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = "@src/ag";
    input.selectionStart = 7;
    input.selectionEnd = 7;
    fireEvent.input(input);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalled();
    });

    const searchCall = postMessage.mock.calls.find(
      ([msg]) =>
        msg &&
        typeof msg === "object" &&
        (msg as { command?: string; query?: string }).command ===
          SEARCH_REQUEST_COMMAND &&
        (msg as { command?: string; query?: string }).query === "src/ag",
    );
    expect(searchCall).toBeTruthy();

    const requestId = (searchCall![0] as { requestId: string }).requestId;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "agentFileSearchResults",
          requestId,
          files: [
            {
              path: SELECTED_PATH,
              kind: "file",
            },
          ],
        },
      }),
    );

    await waitFor(() => {
      expect(container.querySelector(".file-picker-item")).toBeTruthy();
    });

    const selectedItem = container.querySelector(".file-picker-item");
    expect(selectedItem).toBeTruthy();
    fireEvent.click(selectedItem!);

    await waitFor(() => {
      expect(input.value).toBe(`@${SELECTED_PATH}`);
    });

    const attachmentChip = container.querySelector(
      `.attachment-chip[title="${SELECTED_PATH}"]`,
    );
    expect(attachmentChip).toBeTruthy();
  });
});
