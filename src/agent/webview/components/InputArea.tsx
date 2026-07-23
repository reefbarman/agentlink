import {
  AttachmentChip,
  DocumentAttachmentChip,
  ImageAttachmentChip,
} from "./AttachmentChip";
import type {
  ModeInfo,
  ReasoningEffort,
  SlashCommandInfo,
  WebviewModelInfo,
} from "../types";
import {
  autosizeTextarea,
  canSubmitComposer,
  focusAndAutosizeTextarea,
  observeTextareaAutosize,
} from "../../../shared/composerBehavior";
import {
  findTrailingEmojiShortcode,
  resolveEmojiShortcode,
  shouldOpenEmojiPopup,
} from "../emojiShortcodes";
import {
  getSlashCommandSelectionState,
  parseMatchedSlashCommand,
  shouldOpenSlashPopup,
  wrapSlashCommandInBackticks,
} from "../slashCommandInput";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  useSlashCommandPopup,
  withSlashCommandDisplayName,
} from "./useSlashCommandPopup";

import type { CommandApprovalPolicy } from "../../../approvals/commandApprovalPolicy";
import { ComposerBox } from "../../../shared/ui/ComposerBox";
import { EmojiPopup } from "./EmojiPopup";
import { FilePicker } from "./FilePicker";
import type { Injection } from "../App";
import { ModeSelector } from "./ModeSelector";
import { ModelSelector } from "./ModelSelector";
import { ReasoningEffortSelector } from "./ReasoningEffortSelector";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { ToolbarControlButton } from "../../../shared/ui/ToolbarSelector";
import type { WriteApprovalSelection } from "../../../shared/selectionCommands";
import { WriteApprovalSelector } from "./WriteApprovalSelector";
import { randomId } from "../../../shared/randomId";
import { useEmojiPopup } from "./useEmojiPopup";
import { useFileMentionPopup } from "./useFileMentionPopup";

export interface ComposerMedia {
  name: string;
  mimeType: string;
  base64: string;
  kind: "image" | "document";
}

/** A pasted or dropped file held in webview state before sending. */
export interface MediaAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  kind: "image" | "document";
}

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const ACCEPTED_DOC_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/typescript",
  "application/xml",
  "application/x-javascript",
  "application/x-jsonlines",
  "application/x-ndjson",
  "application/x-yaml",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/jsx",
  "text/markdown",
  "text/plain",
  "text/tsx",
  "text/typescript",
  "text/xml",
  "text/yaml",
]);

const DOCUMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  c: "text/x-c",
  cc: "text/x-c++src",
  cpp: "text/x-c++src",
  cs: "text/x-csharp",
  css: "text/css",
  csv: "text/csv",
  go: "text/x-go",
  h: "text/x-c",
  hpp: "text/x-c++hdr",
  html: "text/html",
  java: "text/x-java-source",
  js: "text/javascript",
  json: "application/json",
  jsonl: "application/x-jsonlines",
  jsx: "text/jsx",
  kt: "text/x-kotlin",
  log: "text/plain",
  md: "text/markdown",
  mjs: "text/javascript",
  ndjson: "application/x-ndjson",
  pdf: "application/pdf",
  php: "text/x-php",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  swift: "text/x-swift",
  toml: "text/plain",
  ts: "text/typescript",
  tsx: "text/tsx",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB (conservative for v1)
const ATTACHMENT_KEY_SEPARATOR = "\u001f";

function getDocumentMimeType(file: File): string | null {
  if (ACCEPTED_DOC_TYPES.has(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext ? (DOCUMENT_EXTENSION_MIME_TYPES[ext] ?? null) : null;
}

export type ComposerSubmitHandler = (
  text: string,
  attachments: string[],
  displayText?: string,
  slashCommandLabel?: string,
  media?: ComposerMedia[],
) => void;

export interface ComposerContextMode {
  key: string;
  title: string;
  placeholder: string;
  initialText: string;
  initialAttachments?: string[];
  initialMedia?: ComposerMedia[];
  onSubmit: ComposerSubmitHandler;
  onCancel: () => void;
}

interface InputAreaProps {
  onSend: ComposerSubmitHandler;
  onInterject?: ComposerSubmitHandler;
  onStop: () => void;
  onPolishPrompt?: (draft: string) => Promise<string>;
  streaming: boolean;
  reasoningEffort: ReasoningEffort;
  onSetReasoningEffort: (effort: ReasoningEffort) => void;
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
  currentCondenseThreshold?: number;
  availableModels?: WebviewModelInfo[];
  onSelectModel?: (modelId: string) => void;
  onSetCondenseThreshold?: (threshold: number) => void;
  onSignIn?: (provider: string) => void;
  agentWriteApproval?: WriteApprovalSelection;
  onSetAgentWriteApproval?: (mode: WriteApprovalSelection) => void;
  commandApprovalPolicy?: CommandApprovalPolicy;
  configuredCommandApprovalPolicy?: Exclude<
    CommandApprovalPolicy,
    "approve-for-me"
  >;
  onSetCommandApprovalPolicy?: (policy: CommandApprovalPolicy) => void;
  autoContinueEnabled?: boolean;
  onToggleAutoContinue?: (enabled: boolean) => void;
  autoContinueStatus?: string;
  allowAttachments?: boolean;
  allowMediaPaste?: boolean;
  allowFileMentions?: boolean;
  allowThinkingToggle?: boolean;
  allowExportTranscript?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  submitOnEnter?: boolean;
  contextMode?: ComposerContextMode | null;
  onComposerEvent?: (
    event: string,
    fields?: Record<string, string | number | boolean | null | undefined>,
  ) => void;
}

export function InputArea({
  onSend,
  onInterject,
  onStop,
  onPolishPrompt,
  streaming,
  reasoningEffort,
  onSetReasoningEffort,
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
  currentCondenseThreshold,
  availableModels = [],
  onSelectModel,
  onSetCondenseThreshold,
  onSignIn,
  agentWriteApproval = "prompt",
  onSetAgentWriteApproval,
  commandApprovalPolicy = "safe",
  configuredCommandApprovalPolicy = "safe",
  onSetCommandApprovalPolicy,
  autoContinueEnabled = false,
  onToggleAutoContinue,
  autoContinueStatus,
  allowAttachments = true,
  allowMediaPaste = true,
  allowFileMentions = true,
  allowThinkingToggle = true,
  allowExportTranscript = true,
  disabled = false,
  disabledReason,
  submitOnEnter = true,
  contextMode = null,
  onComposerEvent,
}: InputAreaProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [mediaAttachments, setMediaAttachments] = useState<MediaAttachment[]>(
    [],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const normalDraftRef = useRef<{
    text: string;
    attachments: string[];
    mediaAttachments: MediaAttachment[];
  } | null>(null);
  const activeContextKeyRef = useRef<string | null>(null);
  const {
    open: emojiOpen,
    query: emojiQuery,
    selectedIndex: emojiSelectedIdx,
    suggestions: emojiSuggestions,
    visible: shouldShowEmojiPopup,
    close: closeEmoji,
    trackAt: trackEmojiAt,
    updateFromInput: updateEmojiFromInput,
    selectNext: selectNextEmoji,
    selectPrevious: selectPreviousEmoji,
    setSelectedIndex: setEmojiSelectedIdx,
    complete: handleEmojiSelect,
  } = useEmojiPopup({
    text,
    onTextChange: setText,
    textareaRef,
  });
  const {
    open: pickerOpen,
    query: pickerQuery,
    close: closePicker,
    openAt: openPickerAt,
    openStandalone: openStandalonePicker,
    updateFromInput: updatePickerFromInput,
    complete: completeFileMention,
  } = useFileMentionPopup({
    text,
    onTextChange: setText,
    textareaRef,
  });
  const hasSubmitContent = canSubmitComposer({
    text,
    hasAttachments: allowAttachments && attachments.length > 0,
    hasMedia: allowMediaPaste && mediaAttachments.length > 0,
  });

  // Keep the textarea's DOM value in sync with `text` WITHOUT making it a fully
  // controlled input. A controlled `value={text}` makes Preact re-apply the prop
  // to the live DOM on every render; on surfaces that re-render frequently (the
  // browser gateway polls a snapshot every 150ms), a render carrying a stale
  // `text` can land between a keystroke's `input` event and its batched setText
  // commit, reverting the just-typed/deleted character — which manifests as the
  // composer "replaying" the last keystroke and locking up under fast edits.
  // Syncing imperatively only when `text` actually changes leaves the live DOM
  // value untouched during typing (handleInput already mirrors it into state),
  // so frequent re-renders can no longer clobber in-progress input.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || el.value === text) return;
    el.value = text;
    autosizeTextarea(el);
  }, [text]);

  useEffect(() => observeTextareaAutosize(textareaRef.current), []);

  const [polishing, setPolishing] = useState(false);
  const [lastPolish, setLastPolish] = useState<{
    original: string;
    polished: string;
  } | null>(null);
  const [polishError, setPolishError] = useState<string | null>(null);

  useEffect(() => {
    setPolishError(null);
  }, [text]);

  const handlePolish = useCallback(async () => {
    if (!onPolishPrompt || polishing) return;
    const draft = textareaRef.current?.value ?? text;
    if (!draft.trim()) return;
    setPolishError(null);
    setPolishing(true);
    onComposerEvent?.("polish.click", { chars: draft.length });
    try {
      const polished = await onPolishPrompt(draft);
      // The user may have kept typing while the request was in flight; never
      // clobber a draft that no longer matches what was sent for polishing.
      const current = textareaRef.current?.value ?? "";
      if (current !== draft) {
        onComposerEvent?.("polish.stale", {});
        return;
      }
      if (!polished.trim() || polished === draft) {
        setLastPolish(null);
        onComposerEvent?.("polish.unchanged", {});
        return;
      }
      setText(polished);
      setLastPolish({ original: draft, polished });
      onComposerEvent?.("polish.applied", { chars: polished.length });
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = polished.length;
        }
      });
    } catch (err) {
      setPolishError(err instanceof Error ? err.message : String(err));
      onComposerEvent?.("polish.failed", {});
    } finally {
      setPolishing(false);
    }
  }, [onPolishPrompt, polishing, text, onComposerEvent]);

  const handleUndoPolish = useCallback(() => {
    if (!lastPolish) return;
    const { original } = lastPolish;
    setText(original);
    setLastPolish(null);
    onComposerEvent?.("polish.reverted", {});
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = original.length;
      }
    });
  }, [lastPolish, onComposerEvent]);
  const canUndoPolish =
    lastPolish !== null && !polishing && text === lastPolish.polished;

  const displaySlashCommands = useMemo(
    () => slashCommands.map(withSlashCommandDisplayName),
    [slashCommands],
  );

  const matchedSlashCommand = useMemo(
    () =>
      contextMode ? null : parseMatchedSlashCommand(text, displaySlashCommands),
    [text, displaySlashCommands, contextMode],
  );
  const pendingMedia = useMemo(() => {
    if (mediaAttachments.length === 0) return undefined;
    const result = mediaAttachments.map((m) => {
      const commaIdx = m.dataUrl.indexOf(",");
      const base64 = commaIdx >= 0 ? m.dataUrl.slice(commaIdx + 1) : m.dataUrl;
      return {
        name: m.name,
        mimeType: m.mimeType,
        base64,
        kind: m.kind,
      };
    });
    return result;
  }, [mediaAttachments]);
  const matchedExecutableSlashCommand = useMemo(() => {
    if (!matchedSlashCommand) {
      return null;
    }
    if (
      matchedSlashCommand.command.builtin &&
      ((allowAttachments && attachments.length > 0) ||
        (allowMediaPaste && mediaAttachments.length > 0))
    ) {
      return null;
    }
    return matchedSlashCommand;
  }, [
    matchedSlashCommand,
    attachments.length,
    mediaAttachments.length,
    allowAttachments,
    allowMediaPaste,
  ]);
  const {
    open: slashOpen,
    start: slashStart,
    view: slashView,
    selectedIndex: slashSelectedIdx,
    popupRef: slashPopupRef,
    filteredCommands: filteredSlashCommands,
    visible: shouldShowSlashPopup,
    close: closeSlash,
    openAt: openSlashAt,
    updateFromInput: updateSlashFromInput,
    enterView: enterSlashView,
    back: backSlashView,
    selectNext: selectNextSlash,
    selectPrevious: selectPreviousSlash,
  } = useSlashCommandPopup({
    commands: displaySlashCommands,
    modes,
    currentMode,
    availableModels,
    currentModel,
    matchedCommand: matchedExecutableSlashCommand?.command ?? null,
    inputWrapperRef,
  });

  useEffect(() => {
    const nextKey = contextMode?.key ?? null;
    if (nextKey === activeContextKeyRef.current) return;

    if (nextKey) {
      if (activeContextKeyRef.current === null) {
        normalDraftRef.current = {
          text,
          attachments,
          mediaAttachments,
        };
      }
      setText(contextMode?.initialText ?? "");
      setAttachments(contextMode?.initialAttachments ?? []);
      setMediaAttachments(
        (contextMode?.initialMedia ?? []).map((media) => ({
          id: randomId(),
          name: media.name,
          mimeType: media.mimeType,
          dataUrl: `data:${media.mimeType};base64,${media.base64}`,
          kind: media.kind,
        })),
      );
      closeSlash();
      closePicker();
      closeEmoji();
      requestAnimationFrame(() => {
        focusAndAutosizeTextarea(textareaRef.current);
      });
    } else {
      const normalDraft = normalDraftRef.current;
      if (normalDraft) {
        setText(normalDraft.text);
        setAttachments(normalDraft.attachments);
        setMediaAttachments(normalDraft.mediaAttachments);
      }
      normalDraftRef.current = null;
    }
    activeContextKeyRef.current = nextKey;
  }, [contextMode?.key]);

  const handleSubmit = useCallback(
    (asInterjection = false) => {
      const trimmed = text.trim();
      onComposerEvent?.("submit.attempt", {
        textChars: trimmed.length,
        hasSubmitContent,
        streaming,
        asInterjection,
        attachmentCount: allowAttachments ? attachments.length : 0,
        mediaCount: allowMediaPaste ? mediaAttachments.length : 0,
        slashMatch: Boolean(matchedExecutableSlashCommand),
      });
      if (disabled) {
        onComposerEvent?.("submit.ignored", { reason: "disabled" });
        return;
      }
      if (!hasSubmitContent) {
        onComposerEvent?.("submit.ignored", { reason: "empty" });
        return;
      }

      const submitAttachments = allowAttachments ? attachments : [];
      const submitMedia = allowMediaPaste ? pendingMedia : undefined;
      const submitMessage = contextMode
        ? contextMode.onSubmit
        : asInterjection && onInterject
          ? onInterject
          : onSend;

      if (!contextMode && matchedExecutableSlashCommand) {
        setText("");
        setAttachments([]);
        setMediaAttachments([]);
        closeSlash();
        if (textareaRef.current) textareaRef.current.style.height = "auto";

        const { command, args, displayText, userText, prefixText } =
          matchedExecutableSlashCommand;
        if (command.builtin) {
          onComposerEvent?.("submit.builtin", { command: command.name });
          onExecuteBuiltinCommand?.(command.name, args);
        } else if (command.body) {
          const contextParts = [prefixText, args].filter(
            (part) => part.length > 0,
          );
          const commandInput = contextParts.join("\n\n");
          const finalText = commandInput
            ? `${commandInput}\n\n${command.body}`
            : command.body;
          onComposerEvent?.("submit.send", {
            route: "slash_command_body",
            command: command.name,
          });
          submitMessage(
            finalText,
            submitAttachments,
            userText,
            displayText,
            submitMedia,
          );
        }
        return;
      }

      onComposerEvent?.("submit.send", { route: "message" });
      submitMessage(
        trimmed,
        submitAttachments,
        undefined,
        undefined,
        submitMedia,
      );
      setText("");
      setAttachments([]);
      setMediaAttachments([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    },
    [
      text,
      attachments,
      mediaAttachments,
      allowAttachments,
      allowMediaPaste,
      hasSubmitContent,
      onSend,
      onInterject,
      matchedExecutableSlashCommand,
      onExecuteBuiltinCommand,
      closeSlash,
      pendingMedia,
      onComposerEvent,
      streaming,
      disabled,
      contextMode,
    ],
  );

  // Commands that execute immediately with no args needed
  const ZERO_ARG_BUILTINS = new Set([
    "new",
    "condense",
    "checkpoint",
    "revert",
    "help",
    "skills",
    "mcp",
    "mcp-refresh",
    "worktree",
    "pair",
  ]);
  // Commands that open a sub-picker
  const SUB_PICKER_CMDS = new Set(["mode", "model", "mcp-config"]);

  const handleSlashSelect = useCallback(
    (cmd: SlashCommandInfo) => {
      const before = slashStart >= 0 ? text.slice(0, slashStart) : "";
      const selectionState = getSlashCommandSelectionState(
        text,
        slashStart,
        cmd.displayName ?? cmd.name,
      );

      // Virtual sub-picker selections (prefixed with __)
      if (cmd.name.startsWith("__mcp:")) {
        const scope = cmd.name.slice(6) as "project" | "global";
        setText(before);
        closeSlash();
        onExecuteBuiltinCommand?.("mcp-config", scope);
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
        enterSlashView(cmd.name as "mode" | "model" | "mcp-config");
        return;
      }

      // Everything else closes the popup first
      closeSlash();

      if (cmd.builtin) {
        if (
          ZERO_ARG_BUILTINS.has(cmd.name) &&
          !selectionState.args &&
          (!allowAttachments || attachments.length === 0) &&
          (!allowMediaPaste || mediaAttachments.length === 0)
        ) {
          setText(before);
          onExecuteBuiltinCommand?.(cmd.name, "");
        } else {
          setText(selectionState.replacementText);
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.selectionStart =
                selectionState.replacementText.length;
              textareaRef.current.selectionEnd =
                selectionState.replacementText.length;
            }
          });
        }
      } else if (cmd.body) {
        if (selectionState.args) {
          setText(selectionState.replacementText);
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.selectionStart =
                selectionState.replacementText.length;
              textareaRef.current.selectionEnd =
                selectionState.replacementText.length;
            }
          });
        } else {
          setText(before);
          onSend(cmd.body, [], `/${cmd.displayName ?? cmd.name}`);
        }
      }
    },
    [
      text,
      slashStart,
      closeSlash,
      onExecuteBuiltinCommand,
      onSwitchMode,
      onSend,
      enterSlashView,
      allowAttachments,
      allowMediaPaste,
      attachments.length,
      mediaAttachments.length,
    ],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Handle emoji popup navigation
      if (shouldShowEmojiPopup) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          selectNextEmoji(emojiSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          selectPreviousEmoji(emojiSuggestions.length);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const selected = emojiSuggestions[emojiSelectedIdx];
          if (selected) {
            handleEmojiSelect(selected);
          }
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const selected = emojiSuggestions[emojiSelectedIdx];
          if (selected) {
            handleEmojiSelect(selected);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeEmoji();
          return;
        }
      }

      // Handle slash popup navigation
      if (shouldShowSlashPopup) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          selectNextSlash(filteredSlashCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          selectPreviousSlash(filteredSlashCommands.length);
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
            const selectionState = getSlashCommandSelectionState(
              text,
              slashStart,
              cmd.displayName ?? cmd.name,
            );
            setText(selectionState.replacementText);
            closeSlash();
            requestAnimationFrame(() => {
              if (textareaRef.current) {
                textareaRef.current.focus();
                textareaRef.current.selectionStart =
                  selectionState.replacementText.length;
                textareaRef.current.selectionEnd =
                  selectionState.replacementText.length;
              }
            });
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          if (slashView !== "main") {
            backSlashView();
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
      if (submitOnEnter && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onComposerEvent?.("submit.key", { key: "Enter" });
        handleSubmit();
      }
    },
    [
      handleSubmit,
      submitOnEnter,
      pickerOpen,
      filteredSlashCommands,
      slashSelectedIdx,
      handleSlashSelect,
      closeSlash,
      backSlashView,
      selectNextSlash,
      selectPreviousSlash,
      shouldShowSlashPopup,
      shouldShowEmojiPopup,
      emojiSuggestions,
      emojiSelectedIdx,
      handleEmojiSelect,
      closeEmoji,
      selectNextEmoji,
      selectPreviousEmoji,
      onComposerEvent,
    ],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      if (!allowAttachments) {
        closePicker();
        return;
      }

      completeFileMention(path);
      if (!attachments.includes(path)) {
        setAttachments((prev) => [...prev, path]);
      }
    },
    [allowAttachments, attachments, closePicker, completeFileMention],
  );

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  }, []);

  const handleRemoveMedia = useCallback((id: string) => {
    setMediaAttachments((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (!allowMediaPaste) {
        return;
      }
      if (!e.clipboardData) return;

      const items = Array.from(e.clipboardData.items);
      const clipboardFiles = Array.from(e.clipboardData.files);
      const mediaItems: Array<{
        file: File;
        itemType: string;
        isImage: boolean;
        docMimeType: string | null;
      }> = [];
      // Dedup by file metadata, not object identity: the same clipboard entry
      // surfaces in both `items` (via getAsFile()) and `files`, but each access
      // returns a distinct File instance, so an identity Set wouldn't catch it.
      const seenFiles = new Set<string>();

      const addClipboardFile = (file: File, itemType = file.type) => {
        const key = [file.name, file.size, file.type, file.lastModified].join(
          ATTACHMENT_KEY_SEPARATOR,
        );
        if (seenFiles.has(key)) return;
        const mimeType = itemType || file.type;
        const isImage = ACCEPTED_IMAGE_TYPES.has(mimeType);
        const docMimeType = isImage ? null : getDocumentMimeType(file);
        if (!isImage && !docMimeType) return;
        seenFiles.add(key);
        mediaItems.push({ file, itemType: mimeType, isImage, docMimeType });
      };

      // `items` and `files` expose the SAME clipboard entries. Read from a
      // single source — otherwise each entry gets added twice (and the two File
      // instances carry different lastModified/name, so metadata dedup misses
      // them). Prefer `items`, which also gives us the precise MIME via
      // item.type; only fall back to `files` when no file-kind items exist.
      const fileItems = items.filter((item) => item.kind === "file");
      if (fileItems.length > 0) {
        for (const item of fileItems) {
          const file = item.getAsFile();
          if (!file) continue;
          addClipboardFile(file, item.type || file.type);
        }
      } else {
        for (const file of clipboardFiles) {
          addClipboardFile(file);
        }
      }

      if (mediaItems.length === 0) return; // Let text paste through

      e.preventDefault();

      for (const { file, itemType, isImage, docMimeType } of mediaItems) {
        const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;

        if (file.size > maxBytes) {
          const limitMB = Math.round(maxBytes / (1024 * 1024));
          const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
          // Post an error to the extension for display
          vscodeApi.postMessage({
            command: "agentToast",
            message: `File too large (${sizeMB}MB). Max ${limitMB}MB for ${isImage ? "images" : "files"}.`,
            level: "error",
          });
          continue;
        }

        const fileName =
          file.name || (isImage ? "pasted-image.png" : "pasted-file.txt");
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // Use the synchronously-captured itemType. If it's somehow still
          // empty, infer from the data URL prefix or fall back to file extension.
          let mimeType = itemType;
          if (!mimeType) {
            const dataUrlMatch = dataUrl.match(/^data:([^;,]+)/);
            if (dataUrlMatch) {
              mimeType = dataUrlMatch[1];
            }
          }
          if (!mimeType) {
            const ext = fileName.split(".").pop()?.toLowerCase();
            const extMap: Record<string, string> = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
            };
            mimeType =
              (ext && (extMap[ext] || DOCUMENT_EXTENSION_MIME_TYPES[ext])) ||
              docMimeType ||
              (isImage ? "image/png" : "text/plain");
          }
          const attachment: MediaAttachment = {
            id: randomId(),
            name: fileName,
            mimeType,
            dataUrl,
            kind: isImage ? "image" : "document",
          };
          setMediaAttachments((prev) => [...prev, attachment]);
        };
        reader.readAsDataURL(file);
      }
    },
    [allowMediaPaste, vscodeApi],
  );

  const handleInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLTextAreaElement;
      const value = target.value;
      const cursor = target.selectionStart ?? value.length;
      setText(value);

      // Auto-resize textarea
      autosizeTextarea(target);

      // Auto-convert :shortcode: when trailing colon is typed.
      const matchedShortcode = findTrailingEmojiShortcode(value, cursor);
      if (matchedShortcode) {
        const emoji = resolveEmojiShortcode(matchedShortcode.shortcode);
        if (emoji) {
          const before = value.slice(0, matchedShortcode.start);
          const after = value.slice(matchedShortcode.end);
          const nextValue = `${before}${emoji}${after}`;
          const nextCursor = (before + emoji).length;
          setText(nextValue);
          closeEmoji();
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.selectionStart = nextCursor;
              textareaRef.current.selectionEnd = nextCursor;
              autosizeTextarea(textareaRef.current);
            }
          });
          return;
        }
      }

      updatePickerFromInput(value, cursor);

      if (!contextMode) {
        updateSlashFromInput(value, cursor);
      }

      updateEmojiFromInput(value, cursor);

      if (!pickerOpen && !slashOpen && !emojiOpen) {
        // Check if user just typed @
        const charBefore = cursor >= 2 ? value[cursor - 2] : undefined;
        if (
          allowFileMentions &&
          allowAttachments &&
          value[cursor - 1] === "@" &&
          (charBefore === undefined ||
            charBefore === " " ||
            charBefore === "\n")
        ) {
          openPickerAt(cursor - 1);
        }
        // Check if user just typed / at start or after whitespace
        if (
          !contextMode &&
          value[cursor - 1] === "/" &&
          shouldOpenSlashPopup(value, cursor - 1)
        ) {
          openSlashAt(cursor - 1);
          // Reload slash commands from disk on every open
          vscodeApi.postMessage({ command: "agentRefreshSlashCommands" });
        }
      }

      if (!matchedShortcode && !pickerOpen && !slashOpen && !emojiOpen) {
        if (
          value[cursor - 1] === ":" &&
          shouldOpenEmojiPopup(value, cursor - 1)
        ) {
          trackEmojiAt(cursor - 1);
        }
      }
    },
    [
      pickerOpen,
      updatePickerFromInput,
      openPickerAt,
      slashOpen,
      updateSlashFromInput,
      openSlashAt,
      emojiOpen,
      closeEmoji,
      updateEmojiFromInput,
      trackEmojiAt,
      vscodeApi,
      allowFileMentions,
      contextMode,
    ],
  );

  // Handle injections from extension (code actions, context menus)
  useEffect(() => {
    if (!injection) return;
    switch (injection.type) {
      case "prompt": {
        const promptText = injection.prompt ?? "";
        const promptAttachments = allowAttachments
          ? (injection.attachments ?? [])
          : [];
        if (injection.autoSubmit && promptText.trim()) {
          onSend(promptText, promptAttachments);
        } else {
          setText(promptText);
          if (allowAttachments && promptAttachments.length) {
            setAttachments((prev) => {
              const next = [...prev];
              for (const p of promptAttachments) {
                if (!next.includes(p)) next.push(p);
              }
              return next;
            });
          }
          requestAnimationFrame(() => {
            focusAndAutosizeTextarea(textareaRef.current);
          });
        }
        break;
      }
      case "attachment":
        if (
          allowAttachments &&
          injection.path &&
          !attachments.includes(injection.path)
        ) {
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
          focusAndAutosizeTextarea(textareaRef.current);
        });
        break;
    }
    onInjectionConsumed();
  }, [injection, allowAttachments, attachments, onInjectionConsumed, onSend]);

  // Drag & drop file handling
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      if (!allowAttachments) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }
    },
    [allowAttachments],
  );

  const handleDragLeave = useCallback(
    (e: DragEvent) => {
      if (!allowAttachments) return;
      e.preventDefault();
      setDragOver(false);
    },
    [allowAttachments],
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      if (!allowAttachments) return;
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
        const droppedFiles = Array.from(e.dataTransfer.files);

        if (allowMediaPaste) {
          const acceptedFiles = droppedFiles.filter(
            (file) =>
              ACCEPTED_IMAGE_TYPES.has(file.type) || getDocumentMimeType(file),
          );

          for (const file of acceptedFiles) {
            const isImage = ACCEPTED_IMAGE_TYPES.has(file.type);
            const docMimeType = isImage ? null : getDocumentMimeType(file);
            if (!isImage && !docMimeType) continue;
            const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;

            if (file.size > maxBytes) {
              const limitMB = Math.round(maxBytes / (1024 * 1024));
              const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
              vscodeApi.postMessage({
                command: "agentToast",
                message: `File too large (${sizeMB}MB). Max ${limitMB}MB for ${isImage ? "images" : "files"}.`,
                level: "error",
              });
              continue;
            }

            const fileName =
              file.name || (isImage ? "dropped-image.png" : "dropped-file.txt");
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              const attachment: MediaAttachment = {
                id: randomId(),
                name: fileName,
                mimeType: docMimeType || file.type || "text/plain",
                dataUrl,
                kind: isImage ? "image" : "document",
              };
              setMediaAttachments((prev) => [...prev, attachment]);
            };
            reader.readAsDataURL(file);
          }

          if (acceptedFiles.length > 0) {
            textareaRef.current?.focus();
            return;
          }
        }

        // Fallback to extension-side dropped path resolver.
        const names = droppedFiles.map((f) => f.name);
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
    [allowAttachments, allowMediaPaste, vscodeApi],
  );

  // Listen for resolved dropped file paths
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!allowAttachments) return;
      const msg = event.data;
      if (msg.type === "agentOpenFilePicker") {
        if (!allowFileMentions || !allowAttachments) {
          return;
        }
        openStandalonePicker();
        return;
      }

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
  }, [allowAttachments, allowFileMentions, openStandalonePicker]);

  // Compute picker anchor position relative to input wrapper
  const getPickerAnchor = useCallback(() => {
    const wrapper = inputWrapperRef.current;
    if (!wrapper) return { left: 0, bottom: 0 };
    return { left: 8, bottom: wrapper.offsetHeight + 4 };
  }, []);

  return (
    <div class="input-area">
      <div class="input-toolbar">
        {contextMode && (
          <div class="composer-context-mode" role="status">
            <i class="codicon codicon-comment-discussion" aria-hidden="true" />
            <span>{contextMode.title}</span>
          </div>
        )}
        {!contextMode && modes.length > 0 && onSwitchMode && (
          <ModeSelector
            currentMode={currentMode}
            modes={modes}
            onSelect={onSwitchMode}
          />
        )}
        {!contextMode && availableModels.length > 0 && onSelectModel && (
          <ModelSelector
            currentModel={currentModel}
            currentCondenseThreshold={currentCondenseThreshold}
            models={availableModels}
            onSelect={onSelectModel}
            onSetCondenseThreshold={onSetCondenseThreshold}
            onSignIn={onSignIn}
          />
        )}
        {!contextMode && allowThinkingToggle && (
          <ReasoningEffortSelector
            current={reasoningEffort}
            currentModel={currentModel}
            models={availableModels}
            onSelect={onSetReasoningEffort}
          />
        )}
        {!contextMode && onSetAgentWriteApproval && (
          <WriteApprovalSelector
            current={agentWriteApproval}
            onSelect={onSetAgentWriteApproval}
          />
        )}
        {!contextMode && onSetCommandApprovalPolicy && (
          <ToolbarControlButton
            active={commandApprovalPolicy === "approve-for-me"}
            aria-pressed={commandApprovalPolicy === "approve-for-me"}
            className="approve-for-me-toggle"
            onClick={() =>
              onSetCommandApprovalPolicy(
                commandApprovalPolicy === "approve-for-me"
                  ? configuredCommandApprovalPolicy
                  : "approve-for-me",
              )
            }
            title={
              commandApprovalPolicy === "approve-for-me"
                ? "Approve for Me is on. Eligible workspace and temporary-file commands go to a separate reviewer. High-confidence, bounded commands may run automatically; guardrail-triggered commands ask you directly with a short reason, while reviewer uncertainty shows the review reason. Uses model quota."
                : "Let a separate reviewer approve eligible workspace and temporary-file commands. Guardrail-triggered commands ask you directly; reviewer uncertainty includes the review reason. Uses model quota and applies only to this session."
            }
            type="button"
          >
            <i class="codicon codicon-shield" />
            <span>
              {commandApprovalPolicy === "approve-for-me"
                ? "Approve for Me On"
                : "Approve for Me"}
            </span>
          </ToolbarControlButton>
        )}
        {!contextMode && onToggleAutoContinue && (
          <ToolbarControlButton
            active={autoContinueEnabled}
            aria-pressed={autoContinueEnabled}
            className="auto-continue-toggle"
            onClick={() => onToggleAutoContinue(!autoContinueEnabled)}
            title={
              autoContinueStatus ||
              (autoContinueEnabled
                ? "Auto Continue is on. Completed turns will automatically continue until the agent marks the task definitely complete."
                : "Automatically send Continue after completed turns until the agent marks the task definitely complete.")
            }
            type="button"
          >
            <i class="codicon codicon-debug-continue" />
            <span>
              {autoContinueEnabled ? "Auto Continue On" : "Auto Continue"}
            </span>
          </ToolbarControlButton>
        )}
        {allowAttachments && (
          <button
            class="icon-button"
            onClick={() =>
              vscodeApi.postMessage({ command: "agentAttachFile" })
            }
            title="Attach file"
            type="button"
            disabled={(!contextMode && streaming) || disabled}
          >
            <i class="codicon codicon-attach" />
          </button>
        )}
        {onPolishPrompt && (
          <button
            class="icon-button polish-button"
            onClick={() => void handlePolish()}
            title="Polish prompt — fix spelling and grammar and improve wording (uses model quota)"
            type="button"
            disabled={disabled || polishing || !text.trim()}
            aria-busy={polishing}
          >
            <i
              class={`codicon ${polishing ? "codicon-loading codicon-modifier-spin" : "codicon-sparkle"}`}
            />
          </button>
        )}
        {onPolishPrompt && canUndoPolish && (
          <button
            class="icon-button polish-undo-button"
            onClick={handleUndoPolish}
            title="Revert polish — restore what you had typed"
            type="button"
          >
            <i class="codicon codicon-discard" />
          </button>
        )}
        <div class="input-toolbar-spacer" />
        {contextMode && (
          <button
            class="composer-context-cancel"
            onClick={contextMode.onCancel}
            title="Cancel other context"
            type="button"
          >
            Cancel
          </button>
        )}
        {!contextMode && allowExportTranscript && hasMessages && (
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
      {((allowAttachments && attachments.length > 0) ||
        (allowMediaPaste && mediaAttachments.length > 0)) && (
        <div class="attachment-chips">
          {allowAttachments &&
            attachments.map((path) => (
              <AttachmentChip
                key={path}
                path={path}
                onRemove={handleRemoveAttachment}
              />
            ))}
          {allowMediaPaste &&
            mediaAttachments
              .filter((m) => m.kind === "image")
              .map((img) => (
                <ImageAttachmentChip
                  key={img.id}
                  id={img.id}
                  name={img.name}
                  dataUrl={img.dataUrl}
                  onRemove={handleRemoveMedia}
                />
              ))}
          {allowMediaPaste &&
            mediaAttachments
              .filter((m) => m.kind === "document")
              .map((doc) => (
                <DocumentAttachmentChip
                  key={doc.id}
                  id={doc.id}
                  name={doc.name}
                  onRemove={handleRemoveMedia}
                />
              ))}
        </div>
      )}
      {allowFileMentions && allowAttachments && pickerOpen && (
        <FilePicker
          query={pickerQuery}
          anchor={getPickerAnchor()}
          onSelect={handleFileSelect}
          onClose={closePicker}
          vscodeApi={vscodeApi}
        />
      )}
      {shouldShowSlashPopup && (
        <SlashCommandPopup
          ref={slashPopupRef}
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
                : slashView === "mcp-config"
                  ? "Open MCP Config"
                  : undefined
          }
          onBack={backSlashView}
        />
      )}
      {shouldShowEmojiPopup && (
        <EmojiPopup
          suggestions={emojiSuggestions}
          selectedIndex={emojiSelectedIdx}
          query={emojiQuery}
          anchor={getPickerAnchor()}
          onSelect={handleEmojiSelect}
          onHover={setEmojiSelectedIdx}
        />
      )}
      {disabled && disabledReason && (
        <div class="composer-disabled-notice" role="status">
          <i class="codicon codicon-warning" />
          <span>{disabledReason}</span>
        </div>
      )}
      {polishError && (
        <div class="composer-disabled-notice" role="status">
          <i class="codicon codicon-warning" />
          <span>Polish failed: {polishError}</span>
        </div>
      )}
      <ComposerBox
        className={`input-wrapper ${dragOver ? "drag-over" : ""} ${pickerOpen ? "picker-active" : ""} ${matchedExecutableSlashCommand ? "slash-match-active" : ""}`}
        mainAlign="center"
        accessory={
          matchedExecutableSlashCommand && (
            <div class="slash-match-pill-row">
              <div
                class="slash-match-pill"
                title={matchedExecutableSlashCommand.command.description}
              >
                <i
                  class={`codicon codicon-${matchedExecutableSlashCommand.command.icon ?? (matchedExecutableSlashCommand.command.builtin ? "symbol-event" : matchedExecutableSlashCommand.command.source === "skill" ? "sparkle" : "file")}`}
                />
                <span class="slash-match-pill-name">
                  /
                  {matchedExecutableSlashCommand.command.displayName ??
                    matchedExecutableSlashCommand.command.name}
                </span>
                <span class="slash-match-pill-desc">
                  {matchedExecutableSlashCommand.command.description}
                </span>
              </div>
              <button
                class="slash-match-escape"
                type="button"
                title="Wrap in backticks to send this slash command as raw text"
                onClick={() => {
                  const escaped = wrapSlashCommandInBackticks(text);
                  setText(escaped);
                  closeSlash();
                  requestAnimationFrame(() => {
                    if (textareaRef.current) {
                      textareaRef.current.focus();
                      textareaRef.current.selectionStart = escaped.length;
                      textareaRef.current.selectionEnd = escaped.length;
                    }
                  });
                }}
              >
                <code>`raw`</code>
              </button>
            </div>
          )
        }
      >
        <textarea
          ref={textareaRef}
          class="chat-input"
          placeholder={
            disabled
              ? (disabledReason ?? "Local execution unavailable")
              : contextMode
                ? contextMode.placeholder
                : allowFileMentions && allowAttachments
                  ? "Message... (/ for commands, @ to attach files, : for emoji)"
                  : "Message... (/ for commands, : for emoji)"
          }
          disabled={disabled}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        />
        <div class="composer-action-buttons">
          {!contextMode && streaming && (
            <button
              class="send-button stop-button"
              onClick={onStop}
              title="Stop generation"
              type="button"
            >
              <i class="codicon codicon-debug-stop" />
            </button>
          )}
          {!contextMode &&
            streaming &&
            onInterject &&
            !matchedExecutableSlashCommand?.command.builtin &&
            hasSubmitContent && (
              <button
                class="send-button interject-button"
                onClick={() => {
                  onComposerEvent?.("submit.click", {
                    disabled: disabled || !hasSubmitContent,
                    asInterjection: true,
                  });
                  handleSubmit(true);
                }}
                disabled={disabled || !hasSubmitContent}
                title="Interject at next break"
                type="button"
              >
                <i class="codicon codicon-reply" />
              </button>
            )}
          {(contextMode || !streaming || hasSubmitContent) && (
            <button
              class="send-button"
              onClick={() => {
                onComposerEvent?.("submit.click", {
                  disabled: disabled || !hasSubmitContent,
                });
                handleSubmit();
              }}
              disabled={disabled || !hasSubmitContent}
              title={
                disabled
                  ? (disabledReason ?? "Local execution unavailable")
                  : contextMode
                    ? submitOnEnter
                      ? "Add context (Enter)"
                      : "Add context"
                    : submitOnEnter
                      ? "Send message (Enter)"
                      : "Send message"
              }
              type="button"
            >
              <i
                class={`codicon ${contextMode ? "codicon-check" : "codicon-send"}`}
              />
            </button>
          )}
        </div>
      </ComposerBox>
    </div>
  );
}
