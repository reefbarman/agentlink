// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { InputArea } from "./InputArea";
import type { SlashCommandInfo } from "../types";

class ImmediateFileReader {
  public result: string | ArrayBuffer | null = null;
  public onload:
    | ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown)
    | null = null;

  readAsDataURL(file: File): void {
    this.result = `data:${file.type || "image/png"};base64,abc123`;
    this.onload?.call(
      this as unknown as FileReader,
      {} as ProgressEvent<FileReader>,
    );
  }
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.FileReader = ImmediateFileReader as unknown as typeof FileReader;
});

afterEach(() => {
  cleanup();
});

function renderInputArea(
  slashCommands: SlashCommandInfo[],
  overrides: Partial<Parameters<typeof InputArea>[0]> = {},
) {
  return render(
    <InputArea
      onSend={vi.fn()}
      onStop={vi.fn()}
      streaming={false}
      reasoningEffort="none"
      onSetReasoningEffort={vi.fn()}
      onExportTranscript={vi.fn()}
      hasMessages={false}
      vscodeApi={{ postMessage: vi.fn() }}
      injection={null}
      onInjectionConsumed={vi.fn()}
      slashCommands={slashCommands}
      {...overrides}
    />,
  );
}

describe("InputArea slash popup", () => {
  it("keeps popup visible when exact match is a prefix of other commands", () => {
    const slashCommands: SlashCommandInfo[] = [
      {
        name: "mcp",
        description: "Open MCP picker",
        source: "builtin",
        builtin: true,
      },
      {
        name: "mcp-refresh",
        description: "Refresh MCP",
        source: "builtin",
        builtin: true,
      },
      {
        name: "mcp-config",
        description: "Open MCP config",
        source: "builtin",
        builtin: true,
      },
    ];

    const { container } = renderInputArea(slashCommands);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    expect(input).toBeTruthy();

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = "/mcp";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    fireEvent.input(input);

    expect(container.querySelector(".slash-cmd-popup")).toBeTruthy();
    expect(container.querySelectorAll(".slash-cmd-option").length).toBe(3);
  });

  it("renders and toggles Auto Continue from the toolbar", () => {
    const onToggleAutoContinue = vi.fn();
    const { getByRole } = renderInputArea([], {
      autoContinueEnabled: true,
      onToggleAutoContinue,
    });

    const button = getByRole("button", { name: "Auto Continue On" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("active")).toBe(true);
    expect(button.classList.contains("auto-continue-toggle")).toBe(true);

    fireEvent.click(button);
    expect(onToggleAutoContinue).toHaveBeenCalledWith(false);
  });

  it("attaches pasted images when the clipboard item type is empty but the file has a type", async () => {
    const { container } = renderInputArea([]);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    const image = new File(["image-bytes"], "screenshot.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "",
            getAsFile: () => image,
          },
        ],
        files: [],
      },
    });

    await waitFor(() => {
      expect(container.querySelector(".image-attachment-chip")).toBeTruthy();
    });
  });

  it("attaches pasted images exposed only through clipboard files", async () => {
    const { container } = renderInputArea([]);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    const image = new File(["image-bytes"], "clipboard.png", {
      type: "image/png",
    });

    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        files: [image],
      },
    });

    await waitFor(() => {
      expect(container.querySelector(".image-attachment-chip")).toBeTruthy();
    });
  });
});
