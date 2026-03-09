import { useState, useRef, useCallback, useEffect } from "preact/hooks";
import { FilePicker } from "./FilePicker";
import { AttachmentChip } from "./AttachmentChip";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { ModeSelector } from "./ModeSelector";
import { WriteApprovalSelector } from "./WriteApprovalSelector";
import type { Injection } from "../App";
import type { SlashCommandInfo, ModeInfo } from "../types";

interface InputAreaProps {
  onSend: (text: string, attachments: string[], displayText?: string) => void;
  onStop: () => void;
  streaming: boolean;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  onExportTranscript: () => void;
  hasMessages: boolean;
  vscodeApi: { postMessage: (msg: unknown) => void };
  injection: Injection | null;
  onInjectionConsumed: () => void;
  slashCommands?: SlashCommandInfo[];
  onExecuteBuiltinCommand?: (name: string, args: string) => void;
  modes?: ModeInfo[];
  currentMode?: string;
  onSwitchMode?: (slug: string) => void;
  currentModel?: string;
  agentWriteApproval?: string;
  onSetAgentWriteApproval?: (mode: string) => void;
}

export function InputArea({
  onSend,
  onStop,
  streaming,
  thinkingEnabled,
  onToggleThinking,
  onExportTranscript,
  hasMessages,
  vscodeApi,
  injection,
  onInjectionConsumed,
  slashCommands = [],
  onExecuteBuiltinCommand,
  modes = [],
  currentMode = "code",
  onSwitchMode,
  currentModel = "claude-sonnet-4-6",
  agentWriteApproval = "prompt",
  onSetAgentWriteApproval,
}: InputAreaProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [atStart, setAtStart] = useState(-1); // cursor position of the @ that triggered the picker
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashStart, setSlashStart] = useState(-1);
  const [slashView, setSlashView] = useState<"main" | "mode" | "model" | "mcp">(
    "main",
  );
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Intercept slash commands typed manually (e.g. /mode architect)
    if (
      !attachments.length &&
      trimmed.startsWith("/") &&
      !trimmed.startsWith("//")
    ) {
      const space = trimmed.indexOf(" ");
      const name = space > 0 ? trimmed.slice(1, space) : trimmed.slice(1);
      const args = space > 0 ? trimmed.slice(space + 1).trim() : "";
      const cmd = slashCommands.find((c) => c.name === name);
      if (cmd) {
        setText("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        if (cmd.builtin) {
          onExecuteBuiltinCommand?.(name, args);
        } else if (cmd.body) {
          // File command — treat args as additional context prepended to body
          const finalText = args ? args + "\n\n" + cmd.body : cmd.body;
          const display = args ? `/${name} ${args}` : `/${name}`;
          onSend(finalText, [], display);
        }
        return;
      }
    }

    onSend(trimmed, attachments);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [
    text,
    attachments,
    streaming,
    onSend,
    slashCommands,
    onExecuteBuiltinCommand,
  ]);

  const AVAILABLE_MODELS = [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ];

  const closeSlash = useCallback(() => {
    setSlashOpen(false);
    setSlashQuery("");
    setSlashStart(-1);
    setSlashSelectedIdx(0);
    setSlashView("main");
  }, []);

  const filteredSlashCommands: SlashCommandInfo[] = (() => {
    // Sub-view: mode picker
    if (slashView === "mode") {
      return modes.map((m) => ({
        name: `__mode:${m.slug}`,
        description: m.name,
        source: "builtin" as const,
        builtin: true,
        icon: m.icon,
        isCurrent: m.slug === currentMode,
      }));
    }
    // Sub-view: model picker
    if (slashView === "model") {
      return AVAILABLE_MODELS.map((m) => ({
        name: `__model:${m.id}`,
        description: m.label,
        source: "builtin" as const,
        builtin: true,
        icon: "symbol-namespace",
        isCurrent: m.id === currentModel,
      }));
    }
    // Sub-view: mcp scope picker
    if (slashView === "mcp") {
      return [
        {
          name: "__mcp:project",
          description: "Project (.agentlink/mcp.json)",
          source: "builtin" as const,
          builtin: true,
          icon: "folder",
        },
        {
          name: "__mcp:global",
          description: "Global (~/.agentlink/mcp.json)",
          source: "builtin" as const,
          builtin: true,
          icon: "home",
        },
      ];
    }
    // Main view: filter + enrich with right labels
    const currentModeName =
      modes.find((m) => m.slug === currentMode)?.name ?? currentMode;
    const currentModelLabel =
      AVAILABLE_MODELS.find((m) => m.id === currentModel)?.label ??
      currentModel;
    return slashCommands
      .filter((c) => c.name.toLowerCase().startsWith(slashQuery.toLowerCase()))
      .map((c) => {
        if (c.name === "mode")
          return { ...c, icon: "symbol-misc", rightLabel: currentModeName };
        if (c.name === "model")
          return {
            ...c,
            icon: "symbol-namespace",
            rightLabel: currentModelLabel,
          };
        if (c.name === "new") return { ...c, icon: "add" };
        if (c.name === "clear") return { ...c, icon: "clear-all" };
        if (c.name === "help") return { ...c, icon: "question" };
        if (c.name === "condense") return { ...c, icon: "fold" };
        return c;
      });
  })();

  // Commands that execute immediately with no args needed
  const ZERO_ARG_BUILTINS = new Set([
    "new",
    "help",
    "mcp-refresh",
    "mcp-status",
  ]);
  // Commands that open a sub-picker
  const SUB_PICKER_CMDS = new Set(["mode", "model", "mcp"]);

  const handleSlashSelect = useCallback(
    (cmd: SlashCommandInfo) => {
      // Always strip the slash text from the input on any selection
      const before = slashStart >= 0 ? text.slice(0, slashStart) : "";

      // Virtual sub-picker selections (prefixed with __)
      if (cmd.name.startsWith("__mcp:")) {
        const scope = cmd.name.slice(6) as "project" | "global";
        setText(before);
        closeSlash();
        onExecuteBuiltinCommand?.("mcp", scope);
        return;
      }
      if (cmd.name.startsWith("__mode:")) {
        const slug = cmd.name.slice(7);
        setText(before);
        closeSlash();
        onSwitchMode?.(slug);
        return;
      }
      if (cmd.name.startsWith("__model:")) {
        const modelId = cmd.name.slice(8);
        setText(before);
        closeSlash();
        onExecuteBuiltinCommand?.("model", modelId);
        return;
      }

      // Commands that drill into a sub-picker — clear typed text, stay open
      if (SUB_PICKER_CMDS.has(cmd.name)) {
        setText(before);
        setSlashView(cmd.name as "mode" | "model" | "mcp");
        setSlashSelectedIdx(0);
        return;
      }

      // Everything else closes the popup first
      closeSlash();

      if (cmd.builtin) {
        if (ZERO_ARG_BUILTINS.has(cmd.name)) {
          setText(before);
          onExecuteBuiltinCommand?.(cmd.name, "");
        } else {
          // Fill input with "/name " for manual arg entry
          const newText = before + "/" + cmd.name + " ";
          setText(newText);
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.selectionStart = newText.length;
              textareaRef.current.selectionEnd = newText.length;
            }
          });
        }
      } else if (cmd.body) {
        // Send directly to agent; show only the command name in the chat
        setText(before);
        onSend(cmd.body, [], `/${cmd.name}`);
      }
    },
    [text, slashStart, closeSlash, onExecuteBuiltinCommand, onSwitchMode],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Handle slash popup navigation
      if (slashOpen && filteredSlashCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIdx((i) => (i + 1) % filteredSlashCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIdx((i) =>
            i <= 0 ? filteredSlashCommands.length - 1 : i - 1,
          );
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const cmd = filteredSlashCommands[slashSelectedIdx];
          if (cmd) handleSlashSelect(cmd);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const cmd = filteredSlashCommands[slashSelectedIdx];
          if (cmd && !cmd.name.startsWith("__")) {
            const before = slashStart >= 0 ? text.slice(0, slashStart) : "";
            const newText = before + "/" + cmd.name + " ";
            setText(newText);
            closeSlash();
            requestAnimationFrame(() => {
              if (textareaRef.current) {
                textareaRef.current.focus();
                textareaRef.current.selectionStart = newText.length;
                textareaRef.current.selectionEnd = newText.length;
              }
            });
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          if (slashView !== "main") {
            setSlashView("main");
            setSlashSelectedIdx(0);
          } else {
            closeSlash();
          }
          return;
        }
      }
      // Let FilePicker handle navigation keys when open
      if (
        pickerOpen &&
        ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)
      ) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape" && pickerOpen) {
        setPickerOpen(false);
      }
    },
    [
      handleSubmit,
      pickerOpen,
      slashOpen,
      filteredSlashCommands,
      slashSelectedIdx,
      handleSlashSelect,
      closeSlash,
    ],
  );

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerQuery("");
    setAtStart(-1);
  }, []);

  const handleFileSelect = useCallback(
    (path: string) => {
      // Replace @query with just @ (remove it) and add the file as attachment
      if (atStart >= 0) {
        const before = text.slice(0, atStart);
        const cursorPos = textareaRef.current?.selectionStart ?? text.length;
        const after = text.slice(cursorPos);
        setText(before + after);
        // Restore cursor
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            const pos = before.length;
            textareaRef.current.selectionStart = pos;
            textareaRef.current.selectionEnd = pos;
            textareaRef.current.focus();
          }
        });
      }
      if (!attachments.includes(path)) {
        setAttachments((prev) => [...prev, path]);
      }
      closePicker();
    },
    [text, atStart, attachments, closePicker],
  );

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  }, []);

  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      const value = target.value;
      const cursor = target.selectionStart ?? value.length;
      setText(value);

      // Auto-resize textarea
      target.style.height = "auto";
      target.style.height = target.scrollHeight + "px";

      // Detect @ trigger for file picker
      if (pickerOpen && atStart >= 0) {
        const query = value.slice(atStart + 1, cursor);
        if (query.includes(" ") || query.includes("\n") || cursor <= atStart) {
          closePicker();
        } else {
          setPickerQuery(query);
        }
      } else if (slashOpen && slashStart >= 0) {
        // Update slash query while popup is open
        const query = value.slice(slashStart + 1, cursor);
        if (
          query.includes(" ") ||
          query.includes("\n") ||
          cursor <= slashStart
        ) {
          // Space means user typed args — keep popup open but update query
          if (query.includes("\n") || cursor <= slashStart) {
            closeSlash();
          } else {
            setSlashQuery(query.split(" ")[0]);
          }
        } else {
          setSlashQuery(query);
          setSlashSelectedIdx(0);
        }
      } else if (!pickerOpen && !slashOpen) {
        // Check if user just typed @
        const charBefore = cursor >= 2 ? value[cursor - 2] : undefined;
        if (
          value[cursor - 1] === "@" &&
          (charBefore === undefined ||
            charBefore === " " ||
            charBefore === "\n")
        ) {
          setAtStart(cursor - 1);
          setPickerQuery("");
          setPickerOpen(true);
        }
        // Check if user just typed / at start or after whitespace
        if (
          value[cursor - 1] === "/" &&
          (cursor === 1 || value[cursor - 2] === "\n")
        ) {
          setSlashStart(cursor - 1);
          setSlashQuery("");
          setSlashOpen(true);
          setSlashSelectedIdx(0);
          // Reload slash commands from disk on every open
          vscodeApi.postMessage({ command: "agentRefreshSlashCommands" });
        }
      }
    },
    [pickerOpen, atStart, closePicker, slashOpen, slashStart],
  );

  // Handle injections from extension (code actions, context menus)
  useEffect(() => {
    if (!injection) return;
    switch (injection.type) {
      case "prompt": {
        const promptText = injection.prompt ?? "";
        const promptAttachments = injection.attachments ?? [];
        if (injection.autoSubmit && promptText.trim()) {
          onSend(promptText, promptAttachments);
        } else {
          setText(promptText);
          if (promptAttachments.length) {
            setAttachments((prev) => {
              const next = [...prev];
              for (const p of promptAttachments) {
                if (!next.includes(p)) next.push(p);
              }
              return next;
            });
          }
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.style.height = "auto";
              textareaRef.current.style.height =
                textareaRef.current.scrollHeight + "px";
            }
          });
        }
        break;
      }
      case "attachment":
        if (injection.path && !attachments.includes(injection.path)) {
          setAttachments((prev) => [...prev, injection.path!]);
        }
        requestAnimationFrame(() => textareaRef.current?.focus());
        break;
      case "context":
        setText((prev) =>
          prev
            ? prev + "\n\n" + (injection.context ?? "")
            : (injection.context ?? ""),
        );
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height =
              textareaRef.current.scrollHeight + "px";
          }
        });
        break;
    }
    onInjectionConsumed();
  }, [injection]);

  // Drag & drop file handling
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      if (!e.dataTransfer) return;

      // Try text/uri-list first (standard), then VS Code's custom types, then plain text
      let uriList = e.dataTransfer.getData("text/uri-list");
      if (!uriList) {
        // VS Code webviews may provide resources as plain text URIs
        const text =
          e.dataTransfer.getData("text/plain") ||
          e.dataTransfer.getData("text");
        if (
          text &&
          (text.startsWith("file://") || text.startsWith("vscode-"))
        ) {
          uriList = text;
        }
      }

      // Also handle dropped File objects (e.g. from OS file manager)
      if (!uriList && e.dataTransfer.files.length > 0) {
        // File objects in webviews don't have real paths, but have names
        // We can't resolve these without the extension's help
        const names = Array.from(e.dataTransfer.files).map((f) => f.name);
        vscodeApi.postMessage({
          command: "agentResolveDroppedFiles",
          paths: names,
        });
        return;
      }

      if (!uriList) return;

      // Parse URIs — each line is a URI, extract file paths
      const paths = uriList
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u && !u.startsWith("#"))
        .map((u) => {
          try {
            const url = new URL(u);
            return decodeURIComponent(url.pathname);
          } catch {
            // Might be a plain path
            return u;
          }
        })
        .filter((p): p is string => !!p);

      if (paths.length === 0) return;

      // Send paths to extension to resolve to workspace-relative paths
      vscodeApi.postMessage({
        command: "agentResolveDroppedFiles",
        paths,
      });
    },
    [vscodeApi],
  );

  // Listen for resolved dropped file paths
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (
        msg.type === "agentDroppedFilesResolved" &&
        Array.isArray(msg.files)
      ) {
        setAttachments((prev) => {
          const next = [...prev];
          for (const p of msg.files as string[]) {
            if (!next.includes(p)) next.push(p);
          }
          return next;
        });
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Compute picker anchor position relative to input wrapper
  const getPickerAnchor = useCallback(() => {
    const wrapper = inputWrapperRef.current;
    if (!wrapper) return { left: 0, bottom: 0 };
    return { left: 8, bottom: wrapper.offsetHeight + 4 };
  }, []);

  return (
    <div class="input-area">
      <div class="input-toolbar">
        {modes.length > 0 && onSwitchMode && (
          <ModeSelector
            currentMode={currentMode}
            modes={modes}
            onSelect={onSwitchMode}
          />
        )}
        <button
          class={`toolbar-control thinking-toggle ${thinkingEnabled ? "active" : ""}`}
          onClick={onToggleThinking}
          title={thinkingEnabled ? "Thinking enabled" : "Thinking disabled"}
          type="button"
        >
          <i class="codicon codicon-lightbulb" />
          <span class="thinking-toggle-label">
            {thinkingEnabled ? "Thinking" : "No thinking"}
          </span>
        </button>
        {onSetAgentWriteApproval && (
          <WriteApprovalSelector
            current={agentWriteApproval}
            onSelect={onSetAgentWriteApproval}
          />
        )}
        <button
          class="icon-button"
          onClick={() => vscodeApi.postMessage({ command: "agentAttachFile" })}
          title="Attach file"
          type="button"
          disabled={streaming}
        >
          <i class="codicon codicon-attach" />
        </button>
        <div class="input-toolbar-spacer" />
        {hasMessages && (
          <button
            class="icon-button"
            onClick={onExportTranscript}
            title="Export Transcript"
            type="button"
          >
            <i class="codicon codicon-export" />
          </button>
        )}
      </div>
      {attachments.length > 0 && (
        <div class="attachment-chips">
          {attachments.map((path) => (
            <AttachmentChip
              key={path}
              path={path}
              onRemove={handleRemoveAttachment}
            />
          ))}
        </div>
      )}
      {pickerOpen && (
        <FilePicker
          query={pickerQuery}
          anchor={getPickerAnchor()}
          onSelect={handleFileSelect}
          onClose={closePicker}
          vscodeApi={vscodeApi}
        />
      )}
      {slashOpen && filteredSlashCommands.length > 0 && (
        <SlashCommandPopup
          commands={filteredSlashCommands}
          selectedIndex={slashSelectedIdx}
          anchor={getPickerAnchor()}
          onSelect={handleSlashSelect}
          onClose={closeSlash}
          isSubView={slashView !== "main"}
          subViewTitle={
            slashView === "mode"
              ? "Switch Mode"
              : slashView === "model"
                ? "Switch Model"
                : slashView === "mcp"
                  ? "Open MCP Config"
                  : undefined
          }
          onBack={() => {
            setSlashView("main");
            setSlashSelectedIdx(0);
          }}
        />
      )}
      <div
        class={`input-wrapper ${dragOver ? "drag-over" : ""} ${pickerOpen ? "picker-active" : ""}`}
        ref={inputWrapperRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <textarea
          ref={textareaRef}
          class="chat-input"
          placeholder="Message... (/ for commands, @ to attach files)"
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        {streaming ? (
          <button
            class="send-button stop-button"
            onClick={onStop}
            title="Stop generation"
            type="button"
          >
            <i class="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            class="send-button"
            onClick={handleSubmit}
            disabled={!text.trim() && attachments.length === 0}
            title="Send message (Enter)"
            type="button"
          >
            <i class="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
}
