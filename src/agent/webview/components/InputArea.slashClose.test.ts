/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/preact";

import { InputArea } from "./InputArea";
import type { SlashCommandInfo } from "../types";
import { h } from "preact";

const slashCommands: SlashCommandInfo[] = [
  {
    name: "help",
    description: "Show help",
    source: "builtin",
    builtin: true,
  },
  {
    name: "skills",
    description: "Show skills",
    source: "builtin",
    builtin: true,
  },
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function renderInputArea() {
  return render(
    h(InputArea, {
      onSend: vi.fn(),
      onStop: vi.fn(),
      streaming: false,
      reasoningEffort: "none",
      onSetReasoningEffort: vi.fn(),
      onExportTranscript: vi.fn(),
      hasMessages: false,
      vscodeApi: { postMessage: vi.fn() },
      injection: null,
      onInjectionConsumed: vi.fn(),
      slashCommands,
    }),
  );
}

function openSlashPopup(container: ParentNode) {
  const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
  expect(input).toBeTruthy();

  input.value = "/";
  input.selectionStart = 1;
  input.selectionEnd = 1;
  fireEvent.input(input);

  expect(container.querySelector(".slash-cmd-popup")).toBeTruthy();
  return input;
}

describe("InputArea slash popup close behavior", () => {
  it("closes the popup when Escape is pressed outside the textarea", () => {
    const { container } = renderInputArea();
    openSlashPopup(container);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(container.querySelector(".slash-cmd-popup")).toBeNull();
  });

  it("closes the popup when clicking outside the composer and popup", () => {
    const { container } = renderInputArea();
    openSlashPopup(container);

    fireEvent.pointerDown(document.body);

    expect(container.querySelector(".slash-cmd-popup")).toBeNull();
  });
});
