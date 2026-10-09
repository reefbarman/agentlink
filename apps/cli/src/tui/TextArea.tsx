import React, { useEffect, useRef, useState } from "react";
import { Text, useInput, usePaste } from "ink";

import stringWidth from "string-width";

interface TextAreaProps {
  readonly isFocused: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly onFirstLineUp?: () => void;
  readonly onLastLineDown?: () => void;
  readonly disableArrowNavigation?: boolean;
  readonly keybindings?: { readonly Enter?: boolean };
  readonly placeholder?: string;
  readonly initialLineCount?: number;
  readonly viewportLines?: number;
  readonly viewportColumns: number;
  readonly labels?: readonly {
    readonly pattern: RegExp;
    readonly label: string;
  }[];
  readonly styles?: Readonly<Record<string, { readonly color?: string }>>;
}

export function TextArea({
  isFocused,
  value,
  onChange,
  onSubmit,
  onFirstLineUp,
  onLastLineDown,
  disableArrowNavigation = false,
  keybindings,
  placeholder,
  initialLineCount = 1,
  viewportLines = initialLineCount,
  viewportColumns,
  labels = [],
  styles = {},
}: TextAreaProps): React.JSX.Element {
  const cursor = useRef(value.length);
  const horizontalViewport = useRef({ line: -1, start: 0 });
  const [, renderCursor] = useState(0);
  const previousValue = useRef(value);
  const setCursor = (next: number) => {
    cursor.current = next;
    renderCursor((revision) => revision + 1);
  };

  useEffect(() => {
    if (previousValue.current !== value) {
      setCursor(value.length);
      previousValue.current = value;
    }
  }, [value]);

  const change = (next: string, nextCursor: number) => {
    setCursor(nextCursor);
    previousValue.current = next;
    onChange(next);
  };

  useInput(
    (input, key) => {
      if (!isFocused) return;
      if (key.return) {
        if (keybindings?.Enter === false) return;
        if (key.shift || key.meta || key.ctrl) {
          change(
            `${value.slice(0, cursor.current)}\n${value.slice(cursor.current)}`,
            cursor.current + 1,
          );
        } else {
          onSubmit(value);
        }
        return;
      }
      if (key.ctrl && input === "j") {
        change(
          `${value.slice(0, cursor.current)}\n${value.slice(cursor.current)}`,
          cursor.current + 1,
        );
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (disableArrowNavigation) return;
        const lines = value.split("\n");
        const lineStart = value.lastIndexOf("\n", cursor.current - 1) + 1;
        const column = cursor.current - lineStart;
        const lineIndex = value.slice(0, cursor.current).split("\n").length - 1;
        const targetIndex = lineIndex + (key.upArrow ? -1 : 1);
        if (targetIndex < 0) {
          onFirstLineUp?.();
          return;
        }
        if (targetIndex >= lines.length) {
          onLastLineDown?.();
          return;
        }
        const targetStart = lines
          .slice(0, targetIndex)
          .reduce((length, line) => length + line.length + 1, 0);
        setCursor(targetStart + Math.min(column, lines[targetIndex]!.length));
        return;
      }
      if (key.leftArrow) {
        setCursor(previousCodePointOffset(value, cursor.current));
        return;
      }
      if (key.rightArrow) {
        setCursor(nextCodePointOffset(value, cursor.current));
        return;
      }
      if (key.home) {
        setCursor(value.lastIndexOf("\n", cursor.current - 1) + 1);
        return;
      }
      if (key.end) {
        const nextLine = value.indexOf("\n", cursor.current);
        setCursor(nextLine < 0 ? value.length : nextLine);
        return;
      }
      if (key.backspace || key.delete) {
        if (key.backspace && cursor.current > 0) {
          const previous = previousCodePointOffset(value, cursor.current);
          change(
            `${value.slice(0, previous)}${value.slice(cursor.current)}`,
            previous,
          );
        } else if (key.delete && cursor.current < value.length) {
          const next = nextCodePointOffset(value, cursor.current);
          change(
            `${value.slice(0, cursor.current)}${value.slice(next)}`,
            cursor.current,
          );
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        change(
          `${value.slice(0, cursor.current)}${input}${value.slice(cursor.current)}`,
          cursor.current + input.length,
        );
      }
    },
    { isActive: isFocused },
  );
  usePaste(
    (text) => {
      if (!isFocused) return;
      change(
        `${value.slice(0, cursor.current)}${text}${value.slice(cursor.current)}`,
        cursor.current + text.length,
      );
    },
    { isActive: isFocused },
  );

  const lines = value.split("\n");
  const activeLine = value.slice(0, cursor.current).split("\n").length - 1;
  const firstVisibleLine = Math.max(0, activeLine - viewportLines + 1);
  const visibleLines = lines.slice(
    firstVisibleLine,
    firstVisibleLine + viewportLines,
  );
  const displayLines =
    value.length === 0 && placeholder ? [placeholder] : visibleLines;
  let consumed = lines
    .slice(0, firstVisibleLine)
    .reduce((length, line) => length + line.length + 1, 0);

  return (
    <>
      {displayLines.map((line, lineOffset) => {
        const sourceLine = firstVisibleLine + lineOffset;
        const lineStart = consumed;
        consumed += lines[sourceLine]?.length ?? 0;
        if (sourceLine < lines.length - 1) consumed += 1;
        const lineCursor = cursor.current - lineStart;
        const isPlaceholder = value.length === 0 && Boolean(placeholder);
        const pieces = isPlaceholder
          ? [{ text: line, label: undefined }]
          : tokenizeLine(line, labels);
        const active = isFocused && !isPlaceholder && sourceLine === activeLine;
        const viewport = lineViewport(
          line,
          viewportColumns,
          active ? lineCursor : undefined,
          active && horizontalViewport.current.line === sourceLine
            ? horizontalViewport.current.start
            : 0,
        );
        if (active) {
          horizontalViewport.current = {
            line: sourceLine,
            start: viewport.start,
          };
        }
        let position = 0;
        const rendered = pieces.map((piece, pieceIndex) => {
          const start = position;
          position += piece.text.length;
          const visibleStart = Math.max(start, viewport.start);
          const visibleEnd = Math.min(position, viewport.end);
          if (visibleStart >= visibleEnd) return null;
          const text = line.slice(visibleStart, visibleEnd);
          const cursorHere =
            isFocused &&
            !isPlaceholder &&
            lineCursor >= visibleStart &&
            lineCursor < visibleEnd;
          const color = piece.label
            ? styles[piece.label]?.color
            : styles.text?.color;
          if (!cursorHere) {
            return (
              <Text key={pieceIndex} color={color} dimColor={isPlaceholder}>
                {text}
              </Text>
            );
          }
          const cursorOffset = lineCursor - visibleStart;
          const cursorEnd = nextCodePointOffset(text, cursorOffset);
          return (
            <React.Fragment key={pieceIndex}>
              <Text color={color}>{text.slice(0, cursorOffset)}</Text>
              <Text color={color} inverse>
                {text.slice(cursorOffset, cursorEnd)}
              </Text>
              <Text color={color}>{text.slice(cursorEnd)}</Text>
            </React.Fragment>
          );
        });
        const cursorAtEnd =
          isFocused && !isPlaceholder && lineCursor === line.length;
        // A wide character cannot fit a one-column viewport. Show its cursor
        // cell rather than letting Ink truncate the cursor along with the text.
        const clippedCursor =
          active && lineCursor < line.length && lineCursor >= viewport.end;
        return (
          <Text key={lineOffset} wrap="truncate-end">
            {rendered}
            {cursorAtEnd || clippedCursor ? <Text inverse> </Text> : null}
          </Text>
        );
      })}
    </>
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function lineViewport(
  line: string,
  columns: number,
  cursor: number | undefined,
  previousStart: number,
): { start: number; end: number } {
  const cells = Array.from(graphemes.segment(line), ({ segment, index }) => ({
    start: index,
    end: index + segment.length,
    width: stringWidth(segment),
  }));
  const width = Math.max(1, columns);
  const cursorIndex =
    cursor === undefined ? 0 : cells.findIndex((cell) => cursor < cell.end);
  const target = cursorIndex < 0 ? cells.length : cursorIndex;
  let start = cells.findIndex((cell) => cell.start >= previousStart);
  if (start < 0) start = cells.length;
  start = Math.min(start, target);
  if (cursor !== undefined) {
    // Include the cursor character, or its extra cell at the end of the line.
    let used = cells
      .slice(start, target + 1)
      .reduce((sum, cell) => sum + cell.width, target === cells.length ? 1 : 0);
    while (used > width && start < target) used -= cells[start++]!.width;
    // Refill the tail after deletion, replacement, or a wider terminal.
    if (cursor === line.length) {
      while (start > 0 && used + cells[start - 1]!.width <= width) {
        used += cells[--start]!.width;
      }
    }
  }
  let end = start;
  let used = cursor === line.length ? 1 : 0;
  while (end < cells.length && used + cells[end]!.width <= width) {
    used += cells[end++]!.width;
  }
  return {
    start: cells[start]?.start ?? line.length,
    end: cells[end - 1]?.end ?? 0,
  };
}

function previousCodePointOffset(value: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = value.charCodeAt(offset - 1);
  return previous >= 0xdc00 && previous <= 0xdfff ? offset - 2 : offset - 1;
}

function nextCodePointOffset(value: string, offset: number): number {
  if (offset >= value.length) return value.length;
  const current = value.charCodeAt(offset);
  return current >= 0xd800 && current <= 0xdbff ? offset + 2 : offset + 1;
}

function tokenizeLine(
  line: string,
  labels: readonly { readonly pattern: RegExp; readonly label: string }[],
): { text: string; label?: string }[] {
  const tokens: { text: string; label?: string }[] = [];
  let offset = 0;
  while (offset < line.length) {
    let matchStart = line.length;
    let matchEnd = line.length;
    let matchLabel: string | undefined;
    for (const { pattern, label } of labels) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line.slice(offset));
      if (match && match.index < matchStart - offset) {
        matchStart = offset + match.index;
        matchEnd = matchStart + match[0].length;
        matchLabel = label;
      }
    }
    if (matchStart > offset)
      tokens.push({ text: line.slice(offset, matchStart) });
    tokens.push({
      text: line.slice(matchStart, matchEnd),
      ...(matchLabel ? { label: matchLabel } : {}),
    });
    offset = matchEnd;
  }
  if (tokens.length === 0) tokens.push({ text: "" });
  return tokens;
}
