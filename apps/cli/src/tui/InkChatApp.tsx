import type { AgentTurnResult } from "@agentlink/core";
import Image from "ink-picture";
import {
  Box,
  Text,
  useApp,
  useFocus,
  useInput,
  useWindowSize,
  type SuspendTerminal,
} from "ink";
import React, {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { TextArea } from "react-ink-textarea";

import { attachmentPathsFromText } from "../attachments.js";
import {
  hasVisibleReleaseUpdate,
  type ReleaseUpdateState,
} from "../../../../src/updates/releaseUpdateTypes.js";
import type { StandaloneSessionController } from "../sessionController.js";
import type {
  StandaloneSessionProjection,
  StandaloneThinkingActivity,
  StandaloneTranscriptAttachment,
  StandaloneToolActivity,
} from "../sessionProjection.js";
import { ActivityShelf, buildActivityShelfItems } from "./ActivityShelf.js";
import type { TuiControlRequest, TuiControlResponse } from "./controlTypes.js";
import { MarkdownText } from "./MarkdownText.js";
import {
  ComposerCard,
  type FooterTone,
  type KeyHint,
  SessionMeta,
  ShellFooter,
  ShellHeader,
  STATUS_SPINNER_FRAMES,
} from "./ShellChrome.js";
import { sanitizeTerminalText } from "./terminalText.js";
import { formatElapsed, tuiTheme } from "./theme.js";
import { Wordmark } from "./Wordmark.js";
import {
  initialTuiShellState,
  maxTranscriptOffset,
  reduceTuiShellState,
  selectedPickerItem,
  TUI_COMMANDS,
  type TuiPickerItem,
  type TuiShellState,
  visibleTranscriptWindow,
} from "./tuiShellState.js";

export interface InkChatSubmitResult {
  readonly exit?: boolean;
  readonly status?: string;
}

interface QueuedSubmission {
  readonly id: number;
  readonly text: string;
  readonly attachmentPaths: readonly string[];
}

export interface InkChatAppProps {
  readonly controller: StandaloneSessionController;
  readonly initialProjection: StandaloneSessionProjection;
  readonly initialStatus?: string;
  readonly loadFileSuggestions: (
    query: string,
  ) => Promise<readonly TuiPickerItem[]>;
  readonly onSubmit: (
    text: string,
    attachmentPaths?: readonly string[],
  ) => Promise<InkChatSubmitResult | void>;
  readonly onExit: () => void;
  readonly onError: (error: unknown) => void;
  readonly registerSuspendTerminal?: (suspend: SuspendTerminal) => void;
  readonly suspendProcess?: (signal: NodeJS.Signals) => void;
  readonly onProjection?: (projection: StandaloneSessionProjection) => void;
  readonly externalStatus?: string;
  readonly externalStatusRevision?: number;
  readonly registerControlPresenter?: (
    present: (
      request: TuiControlRequest,
      signal?: AbortSignal,
    ) => Promise<TuiControlResponse>,
  ) => void;
  readonly onOpenControlCenter?: () => void;
  readonly releaseUpdateState?: ReleaseUpdateState;
}

export function InkChatApp({
  controller,
  initialProjection,
  initialStatus,
  loadFileSuggestions,
  onSubmit,
  onExit,
  onError,
  onProjection,
  registerSuspendTerminal,
  suspendProcess = (signal) => process.kill(process.pid, signal),
  externalStatus,
  externalStatusRevision,
  registerControlPresenter,
  onOpenControlCenter,
  releaseUpdateState,
}: InkChatAppProps): React.JSX.Element {
  const { columns, rows } = useWindowSize();
  const { exit, suspendTerminal } = useApp();
  const transcript = useFocus({ id: "transcript" });
  const activity = useFocus({ id: "activity" });
  const composer = useFocus({ id: "composer", autoFocus: true });

  const [projection, setProjection] = useState(initialProjection);
  const [shell, dispatch] = useReducer(reduceTuiShellState, undefined, () => ({
    ...initialTuiShellState(),
    status: initialStatus,
  }));
  const [busy, setBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [workingSince, setWorkingSince] = useState<number>();
  const busyRef = useRef(false);
  const [queuedSubmissions, setQueuedSubmissions] = useState<
    QueuedSubmission[]
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<readonly TuiPickerItem[]>(
    [],
  );
  const nextSubmissionId = useRef(0);
  const [controlRequest, setControlRequest] = useState<TuiControlRequest>();
  const [controlSelection, setControlSelection] = useState(0);
  const [controlBodyOffset, setControlBodyOffset] = useState(0);
  const [controlText, setControlText] = useState("");
  const controlResolve = useRef<
    ((response: TuiControlResponse) => void) | undefined
  >(undefined);
  const controlRequestId = useRef<string | undefined>(undefined);
  const suggestionRequest = useRef(0);
  const onProjectionRef = useRef(onProjection);

  useLayoutEffect(() => {
    registerSuspendTerminal?.(suspendTerminal);
  }, [registerSuspendTerminal, suspendTerminal]);
  useLayoutEffect(() => {
    registerControlPresenter?.(
      (request, signal) =>
        new Promise<TuiControlResponse>((resolve) => {
          let settled = false;
          const complete = (response: TuiControlResponse) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(response);
          };
          const onAbort = () => {
            if (controlRequestId.current === request.id) {
              controlResolve.current = undefined;
              controlRequestId.current = undefined;
              setControlRequest(undefined);
            }
            complete({ requestId: request.id, cancelled: true });
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
          const previousRequestId = controlRequestId.current;
          if (previousRequestId) {
            controlResolve.current?.({
              requestId: previousRequestId,
              cancelled: true,
            });
          }
          controlResolve.current = complete;
          controlRequestId.current = request.id;
          setControlRequest(request);
          setControlSelection(0);
          setControlBodyOffset(0);
          setControlText(request.input?.initialValue ?? "");
        }),
    );
    return () => {
      const requestId = controlRequestId.current;
      if (requestId) {
        controlResolve.current?.({ requestId, cancelled: true });
        controlResolve.current = undefined;
        controlRequestId.current = undefined;
      }
    };
  }, [registerControlPresenter]);
  useEffect(() => {
    const animating =
      busy ||
      projection.phase === "running" ||
      projection.thinking.some((item) => item.status === "running") ||
      projection.tools.some(
        (tool) => tool.status === "requested" || tool.status === "running",
      );
    if (!animating) return;
    const timer = setInterval(
      () => setSpinnerFrame((frame) => (frame + 1) % SPINNER_CYCLE),
      100,
    );
    return () => clearInterval(timer);
  }, [busy, projection.phase, projection.thinking, projection.tools]);
  const working =
    busy || projection.phase === "running" || projection.phase === "cancelling";
  useEffect(() => {
    setWorkingSince((since) => (working ? (since ?? Date.now()) : undefined));
  }, [working]);
  useEffect(() => {
    if (externalStatus !== undefined) {
      dispatch({ type: "status.changed", status: externalStatus });
    }
  }, [externalStatus, externalStatusRevision]);
  useEffect(() => {
    onProjectionRef.current = onProjection;
  }, [onProjection]);
  useEffect(() => {
    const unsubscribe = controller.subscribe((nextProjection) => {
      setProjection(nextProjection);
      onProjectionRef.current?.(nextProjection);
    });
    const current = controller.getState();
    setProjection(current);
    onProjectionRef.current?.(current);
    return unsubscribe;
  }, [controller]);
  useEffect(() => {
    dispatch({ type: "session.changed" });
    setQueuedSubmissions([]);
    setAttachedFiles([]);
  }, [projection.sessionId]);
  useEffect(() => {
    dispatch({
      type: "focus.changed",
      focus: transcript.isFocused
        ? "transcript"
        : activity.isFocused
          ? "activity"
          : "composer",
    });
  }, [activity.isFocused, transcript.isFocused]);
  useEffect(() => {
    const picker = shell.picker;
    if (picker?.kind !== "files") return;
    const request = ++suggestionRequest.current;
    void loadFileSuggestions(picker.query)
      .then((items) => {
        if (request === suggestionRequest.current) {
          dispatch({ type: "picker.refreshed", items });
        }
      })
      .catch(onError);
  }, [loadFileSuggestions, onError, shell.picker?.kind, shell.picker?.query]);

  const textareaRows = rows >= 20 ? 4 : 2;
  const activityProjection = {
    ...projection,
    queuedMessages: queuedSubmissions.map((submission) => submission.text),
    activeQuestion:
      controlRequest?.kind === "question"
        ? controlRequest.body.at(-1)
        : undefined,
  };
  const activityItems = buildActivityShelfItems(activityProjection);
  const layout = shellLayout(
    rows,
    controlRequest
      ? controlRows(controlRequest)
      : composerRows(shell, textareaRows, attachedFiles.length > 0),
    activityItems.length,
    shell.expandedActivityIds.length > 0,
  );
  const transcriptRows = Math.max(1, layout.transcriptRows - 2);
  const transcriptWidth = Math.max(20, columns - 6);
  const transcriptItems = visibleTranscriptWindow(
    projection,
    shell,
    transcriptRows,
    transcriptWidth,
  );
  const transcriptMaxOffset = maxTranscriptOffset(
    projection,
    transcriptRows,
    transcriptWidth,
    shell.expandedToolTurnIds,
  );
  const selectedToolTurnId = [...transcriptItems]
    .reverse()
    .map((item) => item.message.turnId)
    .find(
      (turnId) =>
        turnId !== undefined &&
        projection.tools.some((tool) => tool.turnId === turnId),
    );
  const selectedActivity = activityItems[shell.activitySelectedIndex];
  const selected = selectedPickerItem(shell);

  useInput((input, key) => {
    if (key.ctrl && input === "z") {
      void suspendForShell(suspendTerminal, suspendProcess).catch(onError);
      return;
    }
    if (controlRequest) {
      const options = controlRequest.options ?? [];
      if (key.ctrl && input === "c") {
        completeControl({
          requestId: controlRequest.id,
          cancelled: true,
          terminate: true,
        });
        if (
          projection.phase === "running" ||
          projection.phase === "cancelling" ||
          projection.phase === "awaiting_approval"
        ) {
          void controller.cancel("Cancelled from TUI").catch(onError);
        } else {
          onExit();
          exit();
        }
      } else if (key.escape && controlRequest.cancellable !== false) {
        completeControl({ requestId: controlRequest.id, cancelled: true });
      } else if (key.pageUp) {
        setControlBodyOffset((offset) => Math.max(0, offset - 6));
      } else if (key.pageDown) {
        setControlBodyOffset((offset) =>
          Math.min(Math.max(0, controlRequest.body.length - 6), offset + 6),
        );
      } else if (key.upArrow && options.length > 0) {
        setControlSelection(
          (index) => (index - 1 + options.length) % options.length,
        );
      } else if (key.downArrow && options.length > 0) {
        setControlSelection((index) => (index + 1) % options.length);
      } else if (key.return) {
        const selectedOption = options[controlSelection];
        if (selectedOption || controlRequest.input) {
          completeControl({
            requestId: controlRequest.id,
            cancelled: false,
            ...(selectedOption ? { optionId: selectedOption.id } : {}),
            ...(controlRequest.input ? { text: controlText } : {}),
          });
        }
      } else if (controlRequest.input && !key.ctrl && !key.meta) {
        if (key.backspace || key.delete)
          setControlText((value) => value.slice(0, -1));
        else if (input) setControlText((value) => `${value}${input}`);
      }
      return;
    }
    if (key.ctrl && input === "o") {
      onOpenControlCenter?.();
      return;
    }
    if (key.ctrl && input === "t") {
      const todoIndex = activityItems.findIndex((item) => item.id === "tasks");
      if (todoIndex >= 0) {
        dispatch({
          type: "activity.toggled",
          itemId: "tasks",
          itemIndex: todoIndex,
        });
        activity.focus("activity");
      }
      return;
    }
    if (key.ctrl && input === "c") {
      if (
        projection.phase === "running" ||
        projection.phase === "cancelling" ||
        projection.phase === "awaiting_approval"
      ) {
        void controller.cancel("Cancelled from TUI").catch(onError);
      } else {
        onExit();
        exit();
      }
      return;
    }
    if (key.escape && shell.picker) {
      dispatch({ type: "picker.closed" });
      return;
    }
    if (shell.picker) {
      if (key.upArrow) dispatch({ type: "picker.moved", offset: -1 });
      else if (key.downArrow) dispatch({ type: "picker.moved", offset: 1 });
      else if (key.return && selected) {
        const value = acceptSuggestion(selected, shell);
        if (
          shell.picker.kind === "commands" &&
          isImmediateCommand(selected.id)
        ) {
          submit(value);
        } else if (shell.picker.kind === "files") {
          setAttachedFiles((files) =>
            files.some((file) => file.id === selected.id)
              ? files
              : [...files, selected],
          );
          dispatch({
            type: "composer.replaced",
            value: removeFileSuggestionQuery(shell.composer),
          });
        } else {
          dispatch({ type: "composer.replaced", value });
        }
      }
      return;
    }
    if (key.tab) return;
    if (activity.isFocused) {
      if (key.upArrow)
        dispatch({
          type: "activity.moved",
          offset: -1,
          itemCount: activityItems.length,
        });
      else if (key.downArrow)
        dispatch({
          type: "activity.moved",
          offset: 1,
          itemCount: activityItems.length,
        });
      else if (key.home) dispatch({ type: "activity.first" });
      else if (key.end)
        dispatch({ type: "activity.last", itemCount: activityItems.length });
      else if ((key.return || input === " ") && selectedActivity)
        dispatch({ type: "activity.toggled", itemId: selectedActivity.id });
      return;
    }
    if (transcript.isFocused) {
      if (key.upArrow)
        dispatch({
          type: "scroll.by",
          rows: 1,
          maxOffset: transcriptMaxOffset,
        });
      else if (key.downArrow)
        dispatch({
          type: "scroll.by",
          rows: -1,
          maxOffset: transcriptMaxOffset,
        });
      else if (key.pageUp)
        dispatch({
          type: "scroll.by",
          rows: transcriptRows,
          maxOffset: transcriptMaxOffset,
        });
      else if (key.pageDown)
        dispatch({
          type: "scroll.by",
          rows: -transcriptRows,
          maxOffset: transcriptMaxOffset,
        });
      else if (key.home)
        dispatch({ type: "scroll.top", maxOffset: transcriptMaxOffset });
      else if (key.end) dispatch({ type: "scroll.bottom" });
      else if (key.return && selectedToolTurnId)
        dispatch({
          type: "tool_group.toggled",
          turnId: selectedToolTurnId,
        });
    }
  });

  const completeControl = (response: TuiControlResponse) => {
    const resolve = controlResolve.current;
    controlResolve.current = undefined;
    controlRequestId.current = undefined;
    setControlRequest(undefined);
    setControlSelection(0);
    setControlBodyOffset(0);
    setControlText("");
    resolve?.(response);
  };

  const executeSubmission = (
    text: string,
    attachmentPaths: readonly string[] = [],
  ) => {
    busyRef.current = true;
    setBusy(true);
    const submitted =
      attachmentPaths.length > 0
        ? onSubmit(text, attachmentPaths)
        : onSubmit(text);
    void submitted
      .then((result) => {
        if (result?.status !== undefined) {
          dispatch({ type: "status.changed", status: result.status });
        }
        if (result?.exit) {
          onExit();
          exit();
        }
      })
      .catch((error) => {
        dispatch({
          type: "status.changed",
          status: error instanceof Error ? error.message : String(error),
        });
        onError(error);
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  const submit = (value: string) => {
    const trimmed = value.trim();
    const attachmentPaths = [
      ...new Set([
        ...attachedFiles.map((file) => file.insertText),
        ...attachmentPathsFromText(trimmed),
      ]),
    ];
    if (!trimmed && attachmentPaths.length === 0) return;
    dispatch({ type: "composer.submitted", value: trimmed });
    setAttachedFiles([]);
    if (busyRef.current || queuedSubmissions.length > 0) {
      setQueuedSubmissions((queue) => [
        ...queue,
        { id: nextSubmissionId.current++, text: trimmed, attachmentPaths },
      ]);
      return;
    }
    executeSubmission(trimmed, attachmentPaths);
  };
  useEffect(() => {
    const next = queuedSubmissions[0];
    if (!busy && next) {
      setQueuedSubmissions((queue) => queue.slice(1));
      executeSubmission(next.text, next.attachmentPaths);
    }
  }, [busy, queuedSubmissions]);

  const compact =
    projection.phase === "idle" &&
    projection.transcript.length === 0 &&
    projection.thinking.length === 0 &&
    projection.tools.length === 0 &&
    activityItems.length === 0 &&
    queuedSubmissions.length === 0 &&
    !busy &&
    !controlRequest;
  const footer = footerState({
    projection,
    working,
    elapsed: workingSince === undefined ? 0 : Date.now() - workingSince,
    spinner:
      STATUS_SPINNER_FRAMES[spinnerFrame % STATUS_SPINNER_FRAMES.length]!,
    queued: queuedSubmissions.length,
    focus: transcript.isFocused
      ? "transcript"
      : activity.isFocused
        ? "activity"
        : "composer",
    compact,
  });
  const releaseNotice =
    releaseUpdateState && hasVisibleReleaseUpdate(releaseUpdateState)
      ? `AgentLink ${releaseUpdateState.candidate!.version} available · /updates for details`
      : undefined;
  if (compact) {
    const compactWidth = Math.max(24, Math.min(76, columns - 4));
    return (
      <Box
        width={columns}
        height={rows}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <Wordmark columns={columns} rows={rows} />
        <Box
          marginTop={rows >= 24 ? 2 : 1}
          flexDirection="column"
          width={compactWidth}
        >
          <ComposerCard
            width={compactWidth}
            focused={composer.isFocused}
            padded={rows >= 20}
            header={<ComposerAttachments files={attachedFiles} />}
            footer={
              <>
                <Text> </Text>
                <SessionMeta projection={projection} />
              </>
            }
          >
            <TextArea
              focus={composer.isFocused}
              value={shell.composer}
              onChange={(value) =>
                dispatch({ type: "composer.changed", value })
              }
              onSubmit={submit}
              disableArrowNavigation={Boolean(shell.picker)}
              keybindings={selected ? { Enter: false } : undefined}
              placeholder="What would you like AgentLink to work on?"
              initialLineCount={2}
              viewportLines={textareaRows}
              labels={[{ pattern: /(?:^|\s)@[^\s]+/gu, label: "mention" }]}
              styles={{
                mention: { color: tuiTheme.accent },
                text: { color: tuiTheme.text },
              }}
            />
          </ComposerCard>
          <Picker state={shell} />
          <Box marginTop={1}>
            <ShellFooter
              width={compactWidth}
              tone={footer.tone}
              status={footer.status}
              hints={footer.hints}
            />
          </Box>
          {shell.status || releaseNotice ? (
            <Box marginTop={1} flexDirection="column" paddingX={1}>
              {shell.status ? (
                <Text color={tuiTheme.warn} wrap="truncate-end">
                  {singleLineStatus(shell.status)}
                </Text>
              ) : null}
              {releaseNotice ? (
                <Text color={tuiTheme.accent} wrap="truncate-end">
                  {releaseNotice}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box width={columns} height={rows} flexDirection="column">
      <ShellHeader projection={projection} columns={columns} />
      <Box
        borderStyle="round"
        borderColor={transcript.isFocused ? tuiTheme.accent : tuiTheme.border}
        flexDirection="column"
        height={layout.transcriptRows}
        overflow="hidden"
        paddingX={1}
      >
        {transcriptItems.length === 0 ? (
          <Text dimColor>Start a coding task below.</Text>
        ) : (
          transcriptItems.map((item) => (
            <Box
              key={item.message.id}
              flexDirection="column"
              flexShrink={0}
              height={item.visibleRows}
              overflow="hidden"
            >
              <Box
                flexDirection="column"
                flexShrink={0}
                marginTop={-item.contentOffsetRows}
              >
                <TranscriptMessage
                  role={item.message.role}
                  text={item.message.text}
                  streaming={item.message.streaming}
                  attachments={item.message.attachments}
                  width={transcriptWidth}
                />
                {item.message.role === "user" && item.message.turnId ? (
                  <TurnActivityBlocks
                    turnId={item.message.turnId}
                    projection={projection}
                    spinner={
                      SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!
                    }
                    expanded={shell.expandedToolTurnIds.includes(
                      item.message.turnId,
                    )}
                  />
                ) : null}
              </Box>
            </Box>
          ))
        )}
      </Box>
      {layout.activityRows > 0 ? (
        <ActivityShelf
          projection={activityProjection}
          selectedIndex={shell.activitySelectedIndex}
          expandedIds={shell.expandedActivityIds}
          focused={activity.isFocused}
          height={layout.activityRows}
        />
      ) : null}
      {controlRequest ? (
        <ControlPanel
          request={controlRequest}
          selectedIndex={controlSelection}
          bodyOffset={controlBodyOffset}
          text={controlText}
        />
      ) : (
        <Picker state={shell} />
      )}
      {releaseNotice ? (
        <Box height={1} overflow="hidden" flexShrink={0} paddingX={1}>
          <Text color={tuiTheme.accent} wrap="truncate-end">
            {releaseNotice}
          </Text>
        </Box>
      ) : null}
      {shell.status && !controlRequest ? (
        <Box height={1} overflow="hidden" flexShrink={0} paddingX={1}>
          <Text color={tuiTheme.warn} wrap="truncate-end">
            {singleLineStatus(shell.status)}
          </Text>
        </Box>
      ) : null}
      {!controlRequest ? (
        <ComposerCard
          width={columns}
          height={textareaRows + 2 + (attachedFiles.length > 0 ? 1 : 0)}
          focused={composer.isFocused && !activity.isFocused}
          header={<ComposerAttachments files={attachedFiles} />}
        >
          <TextArea
            focus={composer.isFocused && !activity.isFocused}
            value={shell.composer}
            onChange={(value) => dispatch({ type: "composer.changed", value })}
            onSubmit={submit}
            onFirstLineUp={() => {
              if (shell.composer.length === 0)
                dispatch({ type: "history.previous" });
            }}
            onLastLineDown={() => {
              if (shell.historyIndex !== undefined)
                dispatch({ type: "history.next" });
            }}
            disableArrowNavigation={Boolean(shell.picker)}
            keybindings={
              activity.isFocused || selected ? { Enter: false } : undefined
            }
            placeholder="Ask AgentLink, type / for commands or @ for files"
            initialLineCount={2}
            viewportLines={textareaRows}
            labels={[{ pattern: /(?:^|\s)@[^\s]+/gu, label: "mention" }]}
            styles={{
              mention: { color: tuiTheme.accent },
              text: { color: tuiTheme.text },
            }}
          />
        </ComposerCard>
      ) : null}
      {!controlRequest ? (
        <ShellFooter
          width={columns}
          tone={footer.tone}
          status={footer.status}
          hints={footer.hints}
        />
      ) : null}
    </Box>
  );
}

function footerState({
  projection,
  working,
  elapsed,
  spinner,
  queued,
  focus,
  compact,
}: {
  readonly projection: StandaloneSessionProjection;
  readonly working: boolean;
  readonly elapsed: number;
  readonly spinner: string;
  readonly queued: number;
  readonly focus: "composer" | "transcript" | "activity";
  readonly compact: boolean;
}): {
  readonly tone: FooterTone;
  readonly status: string;
  readonly hints: readonly KeyHint[];
} {
  const queuedSuffix = queued > 0 ? ` · ${queued} queued` : "";
  const [tone, label]: [FooterTone, string] =
    projection.phase === "awaiting_approval"
      ? ["waiting", "◆ waiting for you"]
      : projection.phase === "cancelling"
        ? ["waiting", `${spinner} stopping`]
        : working
          ? ["working", `${spinner} working ${formatElapsed(elapsed)}`]
          : ["ready", "ready"];
  const interruptible = working || projection.phase === "awaiting_approval";
  const exitHint: KeyHint = {
    key: "^c",
    label: interruptible ? "cancel" : "quit",
  };
  const hints: KeyHint[] =
    focus === "transcript"
      ? [
          { key: "↑↓", label: "scroll" },
          { key: "⏎", label: "tools" },
          { key: "pgup/pgdn", label: "page" },
          { key: "tab", label: "focus" },
          exitHint,
        ]
      : focus === "activity"
        ? [
            { key: "↑↓", label: "select" },
            { key: "⏎", label: "details" },
            { key: "tab", label: "focus" },
            exitHint,
          ]
        : compact
          ? [
              { key: "⏎", label: "send" },
              { key: "^j", label: "newline" },
              { key: "/", label: "commands" },
              { key: "@", label: "files" },
              { key: "^o", label: "controls" },
              exitHint,
            ]
          : [
              { key: "⏎", label: working ? "queue" : "send" },
              { key: "^j", label: "newline" },
              { key: "tab", label: "focus" },
              { key: "^o", label: "controls" },
              { key: "^t", label: "tasks" },
              { key: "^z", label: "suspend" },
              exitHint,
            ];
  return { tone, status: `${label}${queuedSuffix}`, hints };
}

function ComposerAttachments({
  files,
}: {
  readonly files: readonly TuiPickerItem[];
}): React.JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <Text color="#4EC9B0" wrap="truncate-end">
      {files.map((file) => `▣ ${sanitizeTerminalText(file.label)}`).join("  ")}
    </Text>
  );
}

function TranscriptMessage({
  role,
  text,
  streaming,
  attachments,
  width,
}: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly attachments?: readonly StandaloneTranscriptAttachment[];
  readonly width: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Text bold color={role === "user" ? "cyan" : "#4EC9B0"}>
        {role === "user" ? "You" : "AgentLink"}
      </Text>
      {role === "assistant" ? (
        <MarkdownText width={width}>{text}</MarkdownText>
      ) : (
        <Text>{sanitizeTerminalText(text)}</Text>
      )}
      {attachments?.map((attachment) => (
        <AttachmentBlock
          key={`${attachment.kind}:${attachment.name}`}
          attachment={attachment}
          width={width}
        />
      ))}
      {streaming ? <Text>▌</Text> : null}
    </Box>
  );
}

function TurnActivityBlocks({
  turnId,
  projection,
  spinner,
  expanded,
}: {
  readonly turnId: string;
  readonly projection: StandaloneSessionProjection;
  readonly spinner: string;
  readonly expanded: boolean;
}): React.JSX.Element {
  const thinking = projection.thinking
    .filter((item) => item.turnId === turnId)
    .sort((left, right) => left.sequence - right.sequence);
  const tools = projection.tools
    .filter((item) => item.turnId === turnId)
    .sort((left, right) => left.sequence - right.sequence);
  if (thinking.length === 0 && tools.length === 0) return <></>;
  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      {thinking.map((item) => (
        <ThinkingBlock
          key={`thinking:${item.thinkingId}`}
          thinking={item}
          spinner={spinner}
        />
      ))}
      {tools.length > 0 ? (
        <ToolGroup tools={tools} spinner={spinner} expanded={expanded} />
      ) : null}
    </Box>
  );
}

function AttachmentBlock({
  attachment,
  width,
}: {
  readonly attachment: StandaloneTranscriptAttachment;
  readonly width: number;
}): React.JSX.Element {
  const label = sanitizeTerminalText(attachment.name);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color="#4EC9B0">
        {attachment.kind === "image" ? "▣" : "▤"} {label}
      </Text>
      {attachment.kind === "image" && attachment.base64 ? (
        <Image
          src={Buffer.from(attachment.base64, "base64")}
          width={Math.min(32, width)}
          height={8}
          objectFit="contain"
          alt={label}
        />
      ) : null}
    </Box>
  );
}

function ThinkingBlock({
  thinking,
  spinner,
}: {
  readonly thinking: StandaloneThinkingActivity;
  readonly spinner: string;
}): React.JSX.Element {
  return (
    <Box flexShrink={0} paddingLeft={1}>
      <Text color="#4EC9B0" wrap="truncate-end">
        {thinking.status === "running" ? `${spinner} Thinking` : "✓ Thought"}
        {thinking.text ? ` · ${sanitizeTerminalText(thinking.text)}` : ""}
      </Text>
    </Box>
  );
}

function ToolGroup({
  tools,
  spinner,
  expanded,
}: {
  readonly tools: readonly StandaloneToolActivity[];
  readonly spinner: string;
  readonly expanded: boolean;
}): React.JSX.Element {
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const active = tools.filter(
    (tool) => tool.status === "requested" || tool.status === "running",
  ).length;
  const marker = active > 0 ? spinner : failed > 0 ? "✗" : "✓";
  const color = failed > 0 ? "red" : "#4EC9B0";
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <Text color={color} wrap="truncate-end">
        {expanded ? "▾" : "▸"} {marker} Tools · {toolGroupSummary(tools)} ·
        Enter {expanded ? "collapse" : "expand"}
      </Text>
      {expanded
        ? tools.flatMap((tool) => [
            <Text key={`${tool.toolCallId}:header`} bold>
              {toolStatusMarker(tool, spinner)}{" "}
              {sanitizeTerminalText(tool.toolName)} · {tool.status}
            </Text>,
            ...expandedToolDetails(tool).map(({ label, value }) => (
              <Text
                key={`${tool.toolCallId}:${label}`}
                dimColor
                wrap="truncate-end"
              >
                {label} · {value}
              </Text>
            )),
          ])
        : null}
    </Box>
  );
}

function toolGroupSummary(tools: readonly StandaloneToolActivity[]): string {
  const names = tools.map((tool) => sanitizeTerminalText(tool.toolName));
  const unique = [...new Set(names)];
  return unique.length === 1
    ? `${tools.length} ${unique[0]}`
    : `${tools.length} calls`;
}

function toolStatusMarker(
  tool: StandaloneToolActivity,
  spinner: string,
): string {
  if (tool.status === "requested" || tool.status === "running") return spinner;
  return tool.status === "completed" ? "✓" : "✗";
}

function expandedToolDetails(
  tool: StandaloneToolActivity,
): readonly { readonly label: string; readonly value: string }[] {
  if (tool.error)
    return [{ label: "Error", value: sanitizeTerminalText(tool.error) }];
  return [
    tool.displayInput === undefined
      ? undefined
      : { label: "Input", value: formatToolJson(tool.displayInput) },
    tool.displayContent === undefined
      ? undefined
      : { label: "Result", value: formatToolJson(tool.displayContent) },
  ].filter(
    (
      section,
    ): section is {
      readonly label: string;
      readonly value: string;
    } => section !== undefined,
  );
}

function formatToolJson(value: unknown): string {
  try {
    return sanitizeTerminalText(
      (typeof value === "string" ? value : JSON.stringify(value)).slice(
        0,
        4_000,
      ),
    );
  } catch {
    return "Details unavailable";
  }
}

function ControlPanel({
  request,
  selectedIndex,
  bodyOffset,
  text,
}: {
  readonly request: TuiControlRequest;
  readonly selectedIndex: number;
  readonly bodyOffset: number;
  readonly text: string;
}): React.JSX.Element {
  const visibleOptions = visibleControlOptions(
    request.options ?? [],
    selectedIndex,
    10,
  );
  return (
    <Box
      borderStyle="double"
      borderColor="yellow"
      flexDirection="column"
      height={controlRows(request)}
      overflow="hidden"
      paddingX={1}
    >
      <Text bold>{sanitizeTerminalText(request.title)}</Text>
      {request.body.slice(bodyOffset, bodyOffset + 6).map((line, index) => (
        <Text
          key={`${request.id}:body:${bodyOffset + index}`}
          wrap="truncate-end"
        >
          {sanitizeTerminalText(line)}
        </Text>
      ))}
      {visibleOptions.map(({ option, index }) => (
        <Text
          key={option.id}
          inverse={index === selectedIndex}
          color={option.tone === "danger" ? "red" : undefined}
        >
          {index === selectedIndex ? "› " : "  "}
          {sanitizeTerminalText(option.label)}
          {option.detail ? ` · ${sanitizeTerminalText(option.detail)}` : ""}
        </Text>
      ))}
      {request.input ? (
        <Text inverse>
          {text
            ? sanitizeTerminalText(text)
            : sanitizeTerminalText(request.input.placeholder)}
        </Text>
      ) : null}
      <Text dimColor>
        ↑↓ select · PgUp/PgDn details · Enter confirm
        {request.cancellable === false ? "" : " · Esc cancel"}
      </Text>
    </Box>
  );
}

export function visibleControlOptions(
  options: readonly import("./controlTypes.js").TuiControlOption[],
  selectedIndex: number,
  limit: number,
): readonly {
  readonly option: import("./controlTypes.js").TuiControlOption;
  readonly index: number;
}[] {
  const count = Math.max(1, limit);
  const selected = Math.min(
    Math.max(0, selectedIndex),
    Math.max(0, options.length - 1),
  );
  const start = Math.min(
    Math.max(0, selected - Math.floor(count / 2)),
    Math.max(0, options.length - count),
  );
  return options.slice(start, start + count).map((option, offset) => ({
    option,
    index: start + offset,
  }));
}

function controlRows(request: TuiControlRequest): number {
  return Math.min(
    18,
    4 +
      Math.min(6, request.body.length) +
      Math.min(10, request.options?.length ?? 0) +
      (request.input ? 1 : 0),
  );
}

function Picker({
  state,
}: {
  readonly state: TuiShellState;
}): React.JSX.Element | null {
  const picker = state.picker;
  if (!picker) return null;
  return (
    <Box
      borderStyle="round"
      borderColor={tuiTheme.border}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={tuiTheme.accent}>
        {picker.kind === "commands" ? "commands" : "files"}
      </Text>
      {picker.items.slice(0, 8).map((item, index) => {
        const active = index === picker.selectedIndex;
        return (
          <Text key={item.id} wrap="truncate-end">
            <Text color={active ? tuiTheme.accent : tuiTheme.faint}>
              {active ? "❯ " : "  "}
            </Text>
            <Text bold={active} color={active ? tuiTheme.text : tuiTheme.muted}>
              {sanitizeTerminalText(item.label)}
            </Text>
            <Text color={tuiTheme.faint}>
              {" · "}
              {sanitizeTerminalText(item.detail)}
            </Text>
          </Text>
        );
      })}
      {picker.items.length === 0 ? (
        <Text color={tuiTheme.faint}>No matches</Text>
      ) : null}
    </Box>
  );
}

function isImmediateCommand(command: string): boolean {
  return new Set([
    "/new",
    "/model",
    "/reasoning",
    "/mode",
    "/sessions",
    "/processes",
    "/agents",
    "/approvals",
    "/help",
    "/exit",
  ]).has(command);
}

function removeFileSuggestionQuery(composer: string): string {
  return composer.replace(/(?:^|\s)@[^\s]*$/u, "").trimEnd();
}

function acceptSuggestion(item: TuiPickerItem, state: TuiShellState): string {
  const insertText = sanitizeTerminalText(item.insertText);
  if (state.picker?.kind === "commands") return insertText;
  const match = /(?:^|\s)@([^\s]*)$/u.exec(state.composer);
  if (!match || match.index === undefined) return state.composer;
  const prefixLength = match[0].startsWith(" ") ? 1 : 0;
  const before = state.composer.slice(0, match.index + prefixLength);
  return `${before}@${insertText} `;
}

function singleLineStatus(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function composerRows(
  state: TuiShellState,
  textareaRows: number,
  hasAttachments = false,
): number {
  return (
    3 +
    textareaRows +
    (hasAttachments ? 1 : 0) +
    (state.picker ? Math.min(8, state.picker.items.length) + 3 : 0) +
    (state.status ? 1 : 0)
  );
}

export function shellLayout(
  terminalRows: number,
  composerHeight: number,
  activityItemCount?: number,
  activityExpanded = false,
): { readonly transcriptRows: number; readonly activityRows: number } {
  const available = Math.max(2, terminalRows - composerHeight - 1);
  const minimumTranscriptRows = available >= 8 ? 4 : Math.max(1, available - 3);
  const idealActivityRows =
    activityItemCount === undefined
      ? Math.max(3, Math.floor(terminalRows * 0.3))
      : activityItemCount === 0
        ? 0
        : activityExpanded
          ? Math.max(5, Math.min(10, activityItemCount + 3))
          : 4;
  const activityRows = Math.min(
    idealActivityRows,
    Math.max(0, available - minimumTranscriptRows),
  );
  return {
    transcriptRows: Math.max(1, available - activityRows),
    activityRows,
  };
}

export async function suspendForShell(
  suspendTerminal: SuspendTerminal,
  suspendProcess: (signal: NodeJS.Signals) => void,
): Promise<void> {
  await suspendTerminal(async () => suspendProcess("SIGTSTP"));
}

export function controllerStatus(result: AgentTurnResult): string | undefined {
  if (result.status === "failed") return `Error: ${result.error.message}`;
  if (result.status === "cancelled") return "Cancelled";
  return undefined;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
// Shared frame counter; a multiple of every spinner's frame count.
const SPINNER_CYCLE = 120;

export { TUI_COMMANDS };
