// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";

import { InputArea, type ComposerContextMode } from "./InputArea";
import {
  insertTranscript,
  type ComposerVoiceInput,
  type ComposerVoiceSessionListener,
} from "./composerVoiceInput";
import type { ChatSlashCommandInfo as SlashCommandInfo } from "@agentlink/protocol/chat-catalog";

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

describe("explicit skill selection", () => {
  const skill: SlashCommandInfo = {
    name: "skill:smoke",
    displayName: "smoke",
    description: "Smoke skill",
    source: "skill",
    builtin: false,
    body: "Call load_skill, then obey",
    directActivation: true,
    skillId: "project:smoke",
    skillRevision: "pinned-revision",
  };

  it("sends a selection-only picker command without the generated loader prompt", () => {
    const onSend = vi.fn();
    const { container } = renderInputArea([skill], { onSend });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "/";
    input.setSelectionRange(1, 1);
    fireEvent.input(input);
    input.value = "/smo";
    input.setSelectionRange(4, 4);
    fireEvent.input(input);
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".slash-cmd-option")!,
    );
    expect(onSend).toHaveBeenCalledWith("", [], "/smoke", "/smoke", undefined, {
      skillId: "project:smoke",
      skillRevision: "pinned-revision",
    });
  });

  it("carries literal arguments and the pinned selection through interjection submit", () => {
    const onInterject = vi.fn();
    const { container, getByRole } = renderInputArea([skill], {
      streaming: true,
      onInterject,
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    fireEvent.input(input, { target: { value: "/smoke check this" } });
    fireEvent.click(getByRole("button", { name: "Interject at next break" }));
    expect(onInterject.mock.calls[0]?.[0]).toBe("check this");
    expect(onInterject.mock.calls[0]?.[5]).toEqual({
      skillId: "project:smoke",
      skillRevision: "pinned-revision",
    });
    expect(onInterject.mock.calls[0]?.[0]).not.toContain("load_skill");
  });

  it("never treats an ordinary custom command as a selected skill", () => {
    const onSend = vi.fn();
    const { container } = renderInputArea([{ ...skill, source: "project" }], {
      onSend,
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "/";
    input.setSelectionRange(1, 1);
    fireEvent.input(input);
    input.value = "/smo";
    input.setSelectionRange(4, 4);
    fireEvent.input(input);
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".slash-cmd-option")!,
    );
    expect(onSend.mock.calls[0]?.[0]).toBe(skill.body);
    expect(onSend.mock.calls[0]?.[5]).toBeUndefined();
  });
});

describe("InputArea usage description", () => {
  it.each([
    ["claude", "Claude Sonnet"],
    ["codex", "GPT Codex"],
  ])("describes usage for the selected %s model", (currentModel, label) => {
    const { container, getByText, queryByText } = renderInputArea(
      [
        {
          name: "usage",
          description: "Show Codex subscription usage and reset times",
          source: "builtin",
          builtin: true,
        },
      ],
      {
        currentModel,
        availableModels: [
          {
            id: currentModel,
            displayName: label,
            provider: currentModel,
            authenticated: true,
            contextWindow: 100_000,
          },
        ],
      },
    );
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "/";
    input.setSelectionRange(1, 1);
    fireEvent.input(input);
    input.value = "/usa";
    input.setSelectionRange(4, 4);
    fireEvent.input(input);
    expect(getByText(`Show usage and reset times for ${label}`)).toBeTruthy();

    input.value = "/usage";
    fireEvent.input(input);
    expect(getByText(`Show usage and reset times for ${label}`)).toBeTruthy();
    expect(
      queryByText("Show Codex subscription usage and reset times"),
    ).toBeNull();
  });
});

describe("InputArea placeholder", () => {
  it("uses consumer copy when a surface supplies it", () => {
    const { container } = renderInputArea([], {
      placeholder: "Ask AgentLink anything",
    });

    expect(
      (container.querySelector(".chat-input") as HTMLTextAreaElement)
        .placeholder,
    ).toBe("Ask AgentLink anything");
  });
});

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

describe("InputArea model setup gate", () => {
  it("preserves a normal draft when provider setup blocks Enter or clicking Send", () => {
    const onSend = vi.fn();
    const { container, getByRole } = renderInputArea([], {
      onSend,
      sendBlockedReason: "Set up ChatGPT/Codex before sending a message.",
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "Keep this draft";
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(
      getByRole("button", {
        name: "Set up ChatGPT/Codex before sending a message.",
      }),
    );

    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep this draft");
    expect(input.disabled).toBe(false);
  });

  it("still executes local built-in commands while provider setup is required", () => {
    const onExecuteBuiltinCommand = vi.fn();
    const { container } = renderInputArea(
      [
        {
          name: "new",
          description: "Start a new chat",
          source: "builtin",
          builtin: true,
        },
      ],
      {
        onExecuteBuiltinCommand,
        sendBlockedReason: "Set up a model before sending a message.",
      },
    );
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/new";
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onExecuteBuiltinCommand).toHaveBeenCalledWith("new", "");
  });

  it("keeps provider-backed slash commands in the draft until setup is complete", () => {
    const onSend = vi.fn();
    const { container } = renderInputArea(
      [
        {
          name: "smoke",
          description: "Use a provider-backed command",
          source: "project",
          builtin: false,
          body: "Run the smoke test",
        },
      ],
      {
        onSend,
        sendBlockedReason: "Set up a model before sending a message.",
      },
    );
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/smoke";
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("/smoke");
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

  it("attaches the picker directly above the input wrapper", () => {
    const { container } = renderInputArea([
      {
        name: "help",
        description: "Show help",
        source: "builtin",
        builtin: true,
      },
    ]);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    const inputWrapper = container.querySelector(".input-wrapper");
    const popup = container.querySelector(".slash-cmd-popup");
    expect(inputWrapper?.contains(popup)).toBe(true);
    expect(popup?.classList.contains("slash-cmd-popup-attached")).toBe(true);
  });

  it("executes an exact match instead of the first grouped result", () => {
    const onExecuteBuiltinCommand = vi.fn();
    const onSend = vi.fn();
    const { container } = renderInputArea(
      [
        {
          name: "mcp-tools",
          description: "Project MCP tools",
          source: "project",
          builtin: false,
          body: "List the project MCP tools",
        },
        {
          name: "mcp",
          description: "Open MCP",
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
    input.value = "/mcp";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    fireEvent.input(input);

    const options =
      container.querySelectorAll<HTMLButtonElement>(".slash-cmd-option");
    expect(options[0]?.textContent).toContain("/mcp-tools");
    expect(options[1]?.textContent).toContain("/mcp");
    expect(options[1]?.classList.contains("selected")).toBe(true);

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onExecuteBuiltinCommand).toHaveBeenCalledWith("mcp", "");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("selects the visibly highlighted command when navigating mixed sources", () => {
    const onExecuteBuiltinCommand = vi.fn();
    const onSend = vi.fn();
    const { container } = renderInputArea(
      [
        {
          name: "help",
          description: "Show help",
          source: "builtin",
          builtin: true,
        },
        {
          name: "review",
          description: "Review changes",
          source: "project",
          builtin: false,
          body: "Review the current changes",
        },
      ],
      { onExecuteBuiltinCommand, onSend },
    );
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    const options =
      container.querySelectorAll<HTMLButtonElement>(".slash-cmd-option");
    expect(options[0]?.textContent).toContain("/review");
    expect(options[1]?.textContent).toContain("/help");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1]?.classList.contains("selected")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onExecuteBuiltinCommand).toHaveBeenCalledWith("help", "");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows an empty state instead of silently closing for an unmatched query", () => {
    const { container } = renderInputArea([
      {
        name: "help",
        description: "Show help",
        source: "builtin",
        builtin: true,
      },
    ]);
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    input.value = "/";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    fireEvent.input(input);

    input.value = "/missing";
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    fireEvent.input(input);

    expect(container.querySelector(".slash-cmd-popup")).toBeTruthy();
    expect(container.querySelector(".slash-cmd-empty")?.textContent).toContain(
      "/missing",
    );
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

  it("executes /workspace immediately without sending prompt text", () => {
    const onExecuteBuiltinCommand = vi.fn();
    const onSend = vi.fn();
    const { container } = renderInputArea(
      [
        {
          name: "workspace",
          description: "Show workspace history",
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

    input.value = "/work";
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    fireEvent.input(input);
    const option =
      container.querySelector<HTMLButtonElement>(".slash-cmd-option");
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    expect(onExecuteBuiltinCommand).toHaveBeenCalledWith("workspace", "");
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

  it("routes question composer context through its footer and keyboard shortcut", async () => {
    const onContextSubmit = vi.fn();
    const onPrimary = vi.fn();
    const onBack = vi.fn();
    const { container, getByRole } = renderInputArea([], {
      streaming: true,
      contextMode: {
        key: "question-1:choice",
        title: "Adding context to agent question",
        placeholder: "Add details…",
        initialText: "",
        onSubmit: onContextSubmit,
        onCancel: vi.fn(),
        actions: {
          canGoBack: false,
          onBack,
          primaryLabel: "Next",
          primaryDisabled: true,
          onPrimary,
        },
      },
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    expect(container.querySelector(".question-context-composer")).toBeTruthy();
    const contextHeader = container.querySelector(
      ".question-context-composer-header",
    );
    expect(contextHeader?.textContent).toContain(
      "Additional context or answer",
    );
    expect(contextHeader?.textContent).toContain(
      "Add supporting details, a screenshot, or answer in your own words",
    );
    expect(input.getAttribute("aria-describedby")).toBe(
      "question-context-composer-help",
    );
    const questionNav = container.querySelector(".question-composer-nav");
    expect(questionNav).toBeTruthy();
    expect(
      questionNav!.compareDocumentPosition(contextHeader!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      questionNav!.compareDocumentPosition(input) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.input(input, { target: { value: "Extra detail" } });
    expect(
      (getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPrimary).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onContextSubmit).toHaveBeenCalledWith(
      "Extra detail",
      [],
      undefined,
      undefined,
      undefined,
    );
    expect(onPrimary).toHaveBeenCalledWith("Extra detail", {
      questionId: "choice",
      paths: [],
      media: [],
    });
    expect(onBack).not.toHaveBeenCalled();
    expect(getByRole("button", { name: "Stop generation" })).toBeTruthy();
  });

  it("submits context-only confirmation answers from the composer tick", () => {
    const onContextSubmit = vi.fn();
    const onPrimary = vi.fn();
    const { container, getByRole } = renderInputArea([], {
      streaming: true,
      contextMode: {
        key: "question-1:confirmation",
        title: "Adding context to agent question",
        placeholder: "Add details…",
        initialText: "",
        onSubmit: onContextSubmit,
        onCancel: vi.fn(),
        actions: {
          canGoBack: false,
          onBack: vi.fn(),
          primaryLabel: "Submit",
          primaryDisabled: false,
          onPrimary,
          hidePrimaryAction: true,
        },
      },
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;

    expect(
      container.querySelector(".question-context-composer-header")?.textContent,
    ).toContain("Additional context or answer");
    expect(getByRole("button", { name: "Attach file" })).toBeTruthy();
    expect(getByRole("button", { name: "Stop generation" })).toBeTruthy();
    expect(
      getByRole("button", { name: "Add context (Cmd/Ctrl+Enter)" }),
    ).toBeTruthy();
    expect(container.querySelector(".question-composer-nav")).toBeNull();

    fireEvent.input(input, { target: { value: "Only if the backup passes." } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(onContextSubmit).toHaveBeenLastCalledWith(
      "Only if the backup passes.",
      [],
      undefined,
      undefined,
      undefined,
    );
    expect(onPrimary).toHaveBeenCalledWith("Only if the backup passes.", {
      questionId: "confirmation",
      paths: [],
      media: [],
    });
    expect(input.value).toBe("Only if the backup passes.");
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

  it("does not sync the previous question's draft into the next question", async () => {
    const actions = {
      canGoBack: false,
      onBack: vi.fn(),
      primaryLabel: "Next" as const,
      primaryDisabled: false,
      onPrimary: vi.fn(),
    };
    const contextMode = (
      questionId: string,
      onSubmit: ComposerContextMode["onSubmit"],
    ): ComposerContextMode => ({
      key: `question-1:${questionId}`,
      questionId,
      title: "Adding context to agent question",
      placeholder: "Add details…",
      initialText: "",
      onSubmit,
      onCancel: vi.fn(),
      actions,
    });
    const onFirstSubmit = vi.fn();
    const onSecondSubmit = vi.fn();
    const { container, rerender } = renderInputArea([], {
      contextMode: contextMode("first", onFirstSubmit),
    });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "First answer context";
    fireEvent.input(input);
    await waitFor(() => {
      expect(onFirstSubmit).toHaveBeenLastCalledWith(
        "First answer context",
        [],
        undefined,
        undefined,
        undefined,
      );
    });

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
        slashCommands={[]}
        contextMode={contextMode("second", onSecondSubmit)}
      />,
    );

    await waitFor(() => {
      expect(input.value).toBe("");
    });
    expect(onSecondSubmit).not.toHaveBeenCalledWith(
      "First answer context",
      expect.anything(),
      undefined,
      undefined,
      undefined,
    );
  });
});

describe("composer voice input", () => {
  function voiceBackend(overrides: Partial<ComposerVoiceInput> = {}) {
    return {
      start: vi.fn(async () => undefined),
      finish: vi.fn(async () => "open the readme"),
      cancel: vi.fn(),
      ...overrides,
    } satisfies ComposerVoiceInput;
  }

  it("inserts transcripts at the cursor with word-boundary spacing", () => {
    expect(insertTranscript("fix bug", 3, 3, "the login")).toEqual({
      value: "fix the login bug",
      caret: 13,
    });
    expect(insertTranscript("", 0, 0, "  hello  ")).toEqual({
      value: "hello",
      caret: 5,
    });
    expect(insertTranscript("draft", 5, 5, "   ")).toEqual({
      value: "draft",
      caret: 5,
    });
  });

  it("hides the mic button without a voice backend", () => {
    const { container } = renderInputArea([]);
    expect(container.querySelector(".voice-input-button")).toBeNull();
  });

  it("records, transcribes, and inserts dictated text into the draft", async () => {
    const voiceInput = voiceBackend();
    const { container } = renderInputArea([], { voiceInput });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    input.value = "please";
    input.setSelectionRange(6, 6);
    fireEvent.input(input);
    const mic = () =>
      container.querySelector<HTMLButtonElement>(".voice-input-button")!;

    fireEvent.click(mic());
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("true"),
    );
    expect(voiceInput.start).toHaveBeenCalledTimes(1);

    fireEvent.click(mic());
    await waitFor(() => expect(input.value).toBe("please open the readme"));
    expect(voiceInput.finish).toHaveBeenCalledTimes(1);
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the backend's reason and disables the mic when unavailable", () => {
    const { container } = renderInputArea([], {
      voiceInput: voiceBackend({ disabledReason: "Needs HTTPS." }),
    });
    const mic = container.querySelector<HTMLButtonElement>(
      ".voice-input-button",
    )!;
    expect(mic.disabled).toBe(true);
    expect(mic.title).toBe("Needs HTTPS.");
  });

  it("cancels an active recording with Escape without transcribing", async () => {
    const voiceInput = voiceBackend();
    const { container } = renderInputArea([], { voiceInput });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    const mic = () =>
      container.querySelector<HTMLButtonElement>(".voice-input-button")!;

    fireEvent.click(mic());
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.keyDown(input, { key: "Escape" });

    expect(voiceInput.cancel).toHaveBeenCalledTimes(1);
    expect(voiceInput.finish).not.toHaveBeenCalled();
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("surfaces transcription failures inline", async () => {
    const voiceInput = voiceBackend({
      finish: vi.fn(async () => {
        throw new Error("Sign in again");
      }),
    });
    const { container, findByText } = renderInputArea([], { voiceInput });
    const mic = () =>
      container.querySelector<HTMLButtonElement>(".voice-input-button")!;

    fireEvent.click(mic());
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.click(mic());

    expect(await findByText("Voice input failed: Sign in again")).toBeTruthy();
  });

  it("streams utterances into the draft and auto-sends after a pause", async () => {
    let listener: ComposerVoiceSessionListener | undefined;
    const onSend = vi.fn();
    const voiceInput = voiceBackend({
      autoSend: true,
      start: vi.fn(async (next: ComposerVoiceSessionListener) => {
        listener = next;
      }),
      finish: vi.fn(async () => "and run the tests"),
    });
    const { container } = renderInputArea([], { voiceInput, onSend });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    const mic = () =>
      container.querySelector<HTMLButtonElement>(".voice-input-button")!;

    fireEvent.click(mic());
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("true"),
    );
    listener!.onPartial("Open the readme.");
    await waitFor(() => expect(input.value).toBe("Open the readme."));
    expect(onSend).not.toHaveBeenCalled();

    listener!.onAutoStop();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toBe("Open the readme. and run the tests");
  });

  it("keeps a manually stopped dictation as a draft even with auto-send", async () => {
    const onSend = vi.fn();
    const voiceInput = voiceBackend({ autoSend: true });
    const { container } = renderInputArea([], { voiceInput, onSend });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    const mic = () =>
      container.querySelector<HTMLButtonElement>(".voice-input-button")!;

    fireEvent.click(mic());
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.click(mic());
    await waitFor(() => expect(input.value).toBe("open the readme"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("records while Alt+M is held and ignores auto-stop until release", async () => {
    let listener: ComposerVoiceSessionListener | undefined;
    const voiceInput = voiceBackend({
      start: vi.fn(async (next: ComposerVoiceSessionListener) => {
        listener = next;
      }),
    });
    const { container } = renderInputArea([], { voiceInput });
    const input = container.querySelector(".chat-input") as HTMLTextAreaElement;
    const mic = () =>
      container.querySelector<HTMLButtonElement>(".voice-input-button")!;
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      fireEvent.keyDown(input, { key: "µ", code: "KeyM", altKey: true });
      await waitFor(() =>
        expect(mic().getAttribute("aria-pressed")).toBe("true"),
      );
      listener!.onAutoStop();
      expect(voiceInput.finish).not.toHaveBeenCalled();

      now.mockReturnValue(3_000);
      fireEvent.keyUp(input, { key: "Alt", code: "AltLeft" });
      await waitFor(() => expect(input.value).toBe("open the readme"));
      expect(voiceInput.finish).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});
