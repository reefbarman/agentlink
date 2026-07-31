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

describe("InputArea project availability", () => {
  it("disables composing and sending when the project is unavailable", () => {
    const onSend = vi.fn();
    const { container, getByRole, getByText } = renderInputArea([], {
      onSend,
      disabled: true,
      disabledReason: "Project unavailable: Project B",
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    expect(input.disabled).toBe(true);
    expect(getByText("Project unavailable: Project B")).toBeTruthy();
    expect(
      (
        getByRole("button", {
          name: "Project unavailable: Project B",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("InputArea interjections", () => {
  it("submits the current message as an interjection while streaming", () => {
    const onSend = vi.fn();
    const onInterject = vi.fn();
    const { container, getByRole } = renderInputArea([], {
      onSend,
      onInterject,
      streaming: true,
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "Please change course";
    fireEvent.input(input);
    fireEvent.click(getByRole("button", { name: "Interject at next break" }));

    expect(onInterject).toHaveBeenCalledWith(
      "Please change course",
      [],
      undefined,
      undefined,
      undefined,
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });
});

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

  it("executes context-doctor immediately without sending prompt text", () => {
    const onExecuteBuiltinCommand = vi.fn();
    const onSend = vi.fn();
    const { container } = renderInputArea(
      [
        {
          name: "context-doctor",
          description: "Show context diagnostics",
          source: "builtin",
          builtin: true,
        },
      ],
      { onExecuteBuiltinCommand, onSend },
    );
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = "/context";
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    fireEvent.input(input);
    const option =
      container.querySelector<HTMLButtonElement>(".slash-cmd-option");
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    expect(onExecuteBuiltinCommand).toHaveBeenCalledWith("context-doctor", "");
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("shows skill commands without the skill prefix and sends their body", () => {
    const onSend = vi.fn();
    const slashCommands: SlashCommandInfo[] = [
      {
        name: "skill:smoke",
        description: "Smoke skill",
        source: "skill",
        builtin: false,
        body: "Use smoke skill",
      },
    ];

    const { container } = renderInputArea(slashCommands, { onSend });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = "/s";
    input.selectionStart = 2;
    input.selectionEnd = 2;
    fireEvent.input(input);

    expect(container.querySelector(".slash-cmd-name")?.textContent).toBe(
      "/smoke",
    );
    expect(container.querySelector(".slash-cmd-right")?.textContent).toBe(
      "Skill",
    );

    input.value = "/smoke";
    input.selectionStart = 6;
    input.selectionEnd = 6;
    fireEvent.input(input);

    expect(container.querySelector(".slash-match-pill-name")?.textContent).toBe(
      "/smoke",
    );
    expect(
      container
        .querySelector(".slash-match-pill .codicon")
        ?.classList.contains("codicon-sparkle"),
    ).toBe(true);

    input.value = "/s";
    input.selectionStart = 2;
    input.selectionEnd = 2;
    fireEvent.input(input);

    container.querySelector<HTMLButtonElement>(".slash-cmd-option")?.click();

    expect(onSend).toHaveBeenCalledWith("Use smoke skill", [], "/smoke");
  });

  it("opens, navigates, and selects emoji suggestions from the keyboard", () => {
    const { container } = renderInputArea([]);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = ":";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = ":thu";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    fireEvent.input(input);

    const options = container.querySelectorAll(".emoji-popup-option");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]?.textContent).toContain(":thumbsup:");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[2]?.textContent).toContain(":thumbsdown:");
    expect(options[2]?.classList.contains("selected")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("👎");
    expect(container.querySelector(".emoji-popup")).toBeNull();
  });

  it("renders and toggles Approve for Me from the toolbar", () => {
    const onSetCommandApprovalPolicy = vi.fn();
    const { getByRole, rerender } = renderInputArea([], {
      commandApprovalPolicy: "safe",
      configuredCommandApprovalPolicy: "sensitive",
      onSetCommandApprovalPolicy,
    });

    const button = getByRole("button", { name: "Approve for Me" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("approve-for-me-toggle")).toBe(true);
    expect(button.title).toContain("temporary-file commands");
    expect(button.title).toContain("model quota");

    fireEvent.click(button);
    expect(onSetCommandApprovalPolicy).toHaveBeenCalledWith("approve-for-me");

    rerender(
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
        commandApprovalPolicy="approve-for-me"
        configuredCommandApprovalPolicy="sensitive"
        onSetCommandApprovalPolicy={onSetCommandApprovalPolicy}
      />,
    );

    const activeButton = getByRole("button", { name: "Approve for Me On" });
    expect(activeButton.getAttribute("aria-pressed")).toBe("true");
    expect(activeButton.classList.contains("active")).toBe(true);
    expect(activeButton.title).toContain("guardrail-triggered commands");
    fireEvent.click(activeButton);
    expect(onSetCommandApprovalPolicy).toHaveBeenLastCalledWith("sensitive");
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

  it("does not submit Enter when submit-on-enter is disabled", () => {
    const onSend = vi.fn();
    const { container } = renderInputArea([], {
      onSend,
      submitOnEnter: false,
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "hello";
    input.selectionStart = 5;
    input.selectionEnd = 5;
    fireEvent.input(input);
    const keydown = fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      charCode: 13,
    });

    expect(keydown).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
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

  it("resolves copied Explorer image URIs into attachment thumbnails", async () => {
    const postMessage = vi.fn();
    const { container } = renderInputArea([], {
      vscodeApi: { postMessage },
      injection: { type: "attachment", path: "media/reference.png" },
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        command: "agentResolveAttachmentPreviews",
        paths: ["media/reference.png"],
      });
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "agentAttachmentPreviewsResolved",
          images: [
            {
              path: "media/reference.png",
              mimeType: "image/png",
              base64: "preview-data",
            },
          ],
        },
      }),
    );
    await waitFor(() => {
      expect(
        container
          .querySelector(".attachment-chip-thumbnail")
          ?.getAttribute("src"),
      ).toBe("data:image/png;base64,preview-data");
    });

    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        files: [],
        getData: (type: string) =>
          type === "text/uri-list" ? "file:///workspace/copied.png" : "",
      },
    });
    expect(postMessage).toHaveBeenCalledWith({
      command: "agentResolveDroppedFiles",
      paths: ["/workspace/copied.png"],
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

  it("routes scoped context through its callback and restores the normal draft", async () => {
    const onSend = vi.fn();
    const onContextSubmit = vi.fn();
    const onCancel = vi.fn();
    const { container, getByRole, rerender } = renderInputArea([], { onSend });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "Unsent normal draft";
    fireEvent.input(input);

    rerender(
      <InputArea
        onSend={onSend}
        onStop={vi.fn()}
        streaming={true}
        reasoningEffort="none"
        onSetReasoningEffort={vi.fn()}
        onExportTranscript={vi.fn()}
        hasMessages={false}
        vscodeApi={{ postMessage: vi.fn() }}
        injection={null}
        onInjectionConsumed={vi.fn()}
        slashCommands={[]}
        contextMode={{
          key: "question-1:choice",
          title: "Adding context to agent question",
          placeholder: "Add details or paste a screenshot…",
          initialText: "/not-a-command",
          onSubmit: onContextSubmit,
          onCancel,
        }}
      />,
    );

    await waitFor(() => {
      expect(input.value).toBe("/not-a-command");
    });
    expect(
      (getByRole("button", { name: "Attach file" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    const image = new File(["image-bytes"], "context.png", {
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
    fireEvent.click(getByRole("button", { name: "Add context (Enter)" }));

    expect(onContextSubmit).toHaveBeenCalledWith(
      "/not-a-command",
      [],
      undefined,
      undefined,
      [
        {
          name: "context.png",
          mimeType: "image/png",
          base64: "abc123",
          kind: "image",
        },
      ],
    );
    expect(onSend).not.toHaveBeenCalled();

    rerender(
      <InputArea
        onSend={onSend}
        onStop={vi.fn()}
        streaming={false}
        reasoningEffort="none"
        onSetReasoningEffort={vi.fn()}
        onExportTranscript={vi.fn()}
        hasMessages={false}
        vscodeApi={{ postMessage: vi.fn() }}
        injection={null}
        onInjectionConsumed={vi.fn()}
        slashCommands={[]}
      />,
    );
    await waitFor(() => {
      expect(input.value).toBe("Unsent normal draft");
    });
  });
});
