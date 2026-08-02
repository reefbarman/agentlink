// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";

import { App } from "./App";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

/** Deliver an extension message to the webview synchronously. */
function deliver(msg: unknown): void {
  fireEvent(window, new MessageEvent("message", { data: msg }));
}

function findCalls(
  postMessage: ReturnType<typeof vi.fn>,
  command: string,
): Array<Record<string, unknown>> {
  return postMessage.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg.command === command);
}

/**
 * Mount the app with an active streaming session, then interject a composer
 * message so it sits in the queue panel as a pending interjection.
 * Returns the interjected message's queueId.
 */
function createVsCodeApi() {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
}

function setupInterjectedMessage(
  postMessage: ReturnType<typeof vi.fn>,
  container: Element,
): string {
  deliver({
    type: "stateUpdate",
    state: {
      sessionId: "session-1",
      mode: "code",
      model: "claude-sonnet-4-6",
      streaming: true,
    },
  });

  const composer = container.querySelector(
    ".chat-input",
  ) as HTMLTextAreaElement;
  expect(composer).toBeTruthy();
  fireEvent.input(composer, { target: { value: "original message" } });

  const interjectButton = container.querySelector(
    ".interject-button",
  ) as HTMLButtonElement;
  expect(interjectButton).toBeTruthy();
  fireEvent.click(interjectButton);

  const interjectCalls = findCalls(postMessage, "agentInterjectQueuedMessage");
  expect(interjectCalls).toHaveLength(1);
  expect(interjectCalls[0]).toMatchObject({
    sessionId: "session-1",
    text: "original message",
  });
  const queueId = interjectCalls[0].queueId as string;
  expect(queueId).toBeTruthy();
  expect(
    container
      .querySelector(".queue-item-interject")
      ?.classList.contains("active"),
  ).toBe(true);
  expect(
    container
      .querySelector(".queue-item")
      ?.classList.contains("interjection-ready"),
  ).toBe(true);

  // Extension confirms the pending interjection is registered.
  deliver({
    type: "agentQueueInterjectionReady",
    sessionId: "session-1",
    queueId,
    ready: true,
  });

  return queueId;
}

describe("queued interjection editing and removal", () => {
  it("immediately marks and can pause an existing queued interjection", () => {
    const vscodeApi = createVsCodeApi();
    const { postMessage } = vscodeApi;
    const { container, getByRole, getByTitle } = render(
      <App vscodeApi={vscodeApi} />,
    );

    deliver({
      type: "stateUpdate",
      state: {
        sessionId: "session-1",
        mode: "code",
        model: "claude-sonnet-4-6",
        streaming: true,
      },
    });
    deliver({
      type: "agentQueuedMessage",
      queueId: "queue-1",
      text: "queued message",
    });

    fireEvent.click(getByTitle("Interject at next break"));

    expect(findCalls(postMessage, "agentInterjectQueuedMessage")).toHaveLength(
      1,
    );
    expect(getByTitle("Ready to interject at next break")).toBeTruthy();
    expect(
      container
        .querySelector(".queue-item-interject")
        ?.classList.contains("active"),
    ).toBe(true);

    fireEvent.click(getByTitle("Ready to interject at next break"));
    expect(
      findCalls(postMessage, "agentPauseQueuedMessageInterjection"),
    ).toEqual([
      {
        command: "agentPauseQueuedMessageInterjection",
        sessionId: "session-1",
        queueId: "queue-1",
      },
    ]);
    expect(getByTitle("Interject at next break")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Edit" }));
    expect(
      findCalls(postMessage, "agentPauseQueuedMessageInterjection"),
    ).toHaveLength(1);
  });

  it("re-registers the interjection with the edited text after an edit", () => {
    const vscodeApi = createVsCodeApi();
    const { postMessage } = vscodeApi;
    const { container, getByRole } = render(<App vscodeApi={vscodeApi} />);
    const queueId = setupInterjectedMessage(postMessage, container);

    fireEvent.click(getByRole("button", { name: "Edit" }));
    expect(
      findCalls(postMessage, "agentPauseQueuedMessageInterjection"),
    ).toEqual([
      {
        command: "agentPauseQueuedMessageInterjection",
        sessionId: "session-1",
        queueId,
      },
    ]);
    // Extension confirms the pause.
    deliver({
      type: "agentQueueInterjectionReady",
      sessionId: "session-1",
      queueId,
      ready: false,
    });

    const editor = container.querySelector(
      ".queue-item-textarea",
    ) as HTMLTextAreaElement;
    expect(editor).toBeTruthy();
    fireEvent.input(editor, { target: { value: "edited message" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    const updates = findCalls(postMessage, "agentUpdateQueuedMessage");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionId: "session-1",
      queueId,
      text: "edited message",
    });

    // Saving the edit must resume the interjection with the edited text.
    const interjectCalls = findCalls(
      postMessage,
      "agentInterjectQueuedMessage",
    );
    expect(interjectCalls).toHaveLength(2);
    expect(interjectCalls[1]).toMatchObject({
      sessionId: "session-1",
      queueId,
      text: "edited message",
    });
  });

  it("clears the extension-side pending interjection when the message is removed", () => {
    const vscodeApi = createVsCodeApi();
    const { postMessage } = vscodeApi;
    const { container, getByRole } = render(<App vscodeApi={vscodeApi} />);
    const queueId = setupInterjectedMessage(postMessage, container);

    fireEvent.click(getByRole("button", { name: "Remove" }));

    // The extension must be told, or the pending interjection still fires and
    // the deleted message lands in the chat anyway.
    const removals = findCalls(postMessage, "agentRemoveQueuedMessage");
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({
      sessionId: "session-1",
      queueId,
    });
    expect(container.querySelector(".queue-item")).toBeNull();
  });
});
