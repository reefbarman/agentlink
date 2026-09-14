import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Text,
  useFocus,
  useFocusManager,
  useInput,
  usePaste,
  useWindowSize,
} from "ink";

import {
  approvalDiff,
  type RendererBakeoffFixture,
  type RendererFixtureAction,
  type RendererFixtureFocus,
} from "./rendererBakeoffFixture.js";

export interface InkRendererFixtureProps {
  readonly fixture: RendererBakeoffFixture;
  readonly width?: number;
  readonly height?: number;
  readonly onAction?: (action: RendererFixtureAction) => void;
}

const ignoreRendererFixtureAction = () => undefined;

export function InkRendererFixture({
  fixture,
  width,
  height,
  onAction = ignoreRendererFixtureAction,
}: InkRendererFixtureProps): React.JSX.Element {
  const terminal = useWindowSize();
  const columns = width ?? terminal.columns ?? 100;
  const rows = height ?? terminal.rows ?? 30;
  const [composer, setComposer] = useState(fixture.composer);
  const composerRef = useRef(fixture.composer);
  const [commandPickerOpen, setCommandPickerOpen] = useState(
    fixture.commandPickerOpen,
  );
  const { focusNext, focusPrevious } = useFocusManager();
  const updateComposer = (value: string) => {
    composerRef.current = value;
    setComposer(value);
    onAction({ type: "composer.changed", value });
  };

  useInput((input, key) => {
    if (key.tab) {
      if (key.shift) focusPrevious();
      else focusNext();
      return;
    }
    if (key.escape) {
      if (commandPickerOpen) {
        setCommandPickerOpen(false);
        onAction({ type: "command-picker.toggled", open: false });
      } else {
        onAction({ type: "turn.cancelled" });
      }
      return;
    }
    if (input === "/") {
      setCommandPickerOpen(true);
      onAction({ type: "command-picker.toggled", open: true });
      return;
    }
    if (key.return && (key.meta || key.shift)) {
      updateComposer(`${composerRef.current}\n`);
      return;
    }
    if (key.return) {
      onAction({ type: "composer.submitted", value: composerRef.current });
      return;
    }
    if (key.backspace || key.delete) {
      updateComposer(composerRef.current.slice(0, -1));
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      updateComposer(`${composerRef.current}${input}`);
    }
  });
  usePaste((text) => updateComposer(`${composerRef.current}${text}`));

  const wide = columns >= 96;
  const activityWidth = wide
    ? Math.max(30, Math.floor(columns * 0.32))
    : columns;
  const mainWidth = wide ? columns - activityWidth : columns;
  const bodyHeight = Math.max(12, rows - 7);
  const viewportMessages = fixture.projection.transcript.slice(
    -Math.max(4, bodyHeight - 7),
  );

  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="#4EC9B0">
          AgentLink · {fixture.projection.sessionId}
        </Text>
        <Text>
          {fixture.projection.phase} · {columns}×{rows} ·{" "}
          {fixture.commandOutput.split("\n").at(-1)}
        </Text>
      </Box>
      <Box flexDirection={wide ? "row" : "column"} flexGrow={1}>
        <FocusablePane
          id="transcript"
          title={`Transcript (${fixture.projection.transcript.length})`}
          initialFocus={fixture.focus === "transcript"}
          width={mainWidth}
          height={wide ? bodyHeight : Math.max(7, bodyHeight - 8)}
          onAction={onAction}
        >
          {viewportMessages.map((message) => (
            <Text key={message.id} wrap="truncate-end">
              {message.role === "user" ? "you" : "agent"}:{" "}
              {message.streaming
                ? message.text.slice(-64)
                : message.text.replace(/\s+/gu, " ")}
              {message.streaming ? "▌" : ""}
            </Text>
          ))}
          <Text color="gray">
            $ {fixture.commandOutput.split("\n").slice(-2).join(" · ")}
          </Text>
        </FocusablePane>
        <FocusablePane
          id="activity"
          title="Activity shelf"
          initialFocus={fixture.focus === "activity"}
          width={activityWidth}
          height={wide ? bodyHeight : 8}
          onAction={onAction}
        >
          {fixture.todos.map((todo) => (
            <Text key={todo.id}>
              {todo.status === "completed"
                ? "✓"
                : todo.status === "in_progress"
                  ? "●"
                  : "○"}{" "}
              {todo.label}
            </Text>
          ))}
          <Text>Question: {fixture.question}</Text>
          <Text>
            Process: {fixture.projection.commands[0]?.command} ·{" "}
            {fixture.projection.commands[0]?.state}
          </Text>
          {fixture.projection.backgroundAgents.map((agent) => (
            <Text key={agent.childSessionId}>
              Agent: {agent.task} · {agent.phase}
            </Text>
          ))}
        </FocusablePane>
      </Box>
      <FocusablePane
        id="approval"
        title={fixture.projection.pendingInteraction?.summary ?? "Approval"}
        initialFocus={fixture.focus === "approval"}
        width={columns}
        height={Math.min(8, Math.max(5, rows - bodyHeight - 4))}
        onAction={onAction}
      >
        <Text>{approvalDiff(fixture)}</Text>
        <Text color="yellow">[a] Approve once [d] Deny</Text>
      </FocusablePane>
      <FocusablePane
        id="composer"
        title="Composer · Enter send · Alt+Enter newline · Tab focus · / commands"
        initialFocus={fixture.focus === "composer"}
        width={columns}
        height={4}
        onAction={onAction}
      >
        <Text>{composer.length > 0 ? composer : "Ask AgentLink…"}</Text>
        {commandPickerOpen ? (
          <Text color="cyan">/new /model /sessions /help</Text>
        ) : null}
      </FocusablePane>
    </Box>
  );
}

interface FocusablePaneProps {
  readonly id: RendererFixtureFocus;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly initialFocus: boolean;
  readonly onAction: (action: RendererFixtureAction) => void;
  readonly children: React.ReactNode;
}

export function FocusablePane({
  id,
  title,
  width,
  height,
  initialFocus,
  onAction,
  children,
}: FocusablePaneProps): React.JSX.Element {
  const { isFocused } = useFocus({ id, autoFocus: initialFocus });
  useEffect(() => {
    if (isFocused) onAction({ type: "focus.changed", focus: id });
  }, [id, isFocused, onAction]);
  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "gray"}
      flexDirection="column"
      overflow="hidden"
      paddingX={1}
    >
      <Text bold inverse={isFocused}>
        {title}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
