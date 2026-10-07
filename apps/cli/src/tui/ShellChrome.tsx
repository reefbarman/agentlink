import {
  BRAND_GRADIENT,
  formatTokenCount,
  gradientColors,
  tuiTheme,
} from "./theme.js";
import { Box, Text } from "ink";

import React from "react";
import type { StandaloneSessionProjection } from "../sessionProjection.js";
import path from "node:path";
import { sanitizeTerminalText } from "./terminalText.js";

export const STATUS_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Thin brand-gradient edge drawn across the top of a composer card. */
export function GradientStrip({
  width,
  active,
}: {
  readonly width: number;
  readonly active: boolean;
}): React.JSX.Element {
  const cells = Math.max(1, width);
  if (!active) {
    return <Text color={tuiTheme.border}>{"▔".repeat(cells)}</Text>;
  }
  // A few coloured runs read as a smooth gradient and keep the node count low.
  const segments = Math.min(cells, MAX_GRADIENT_SEGMENTS);
  const colors = gradientColors(segments, BRAND_GRADIENT);
  return (
    <Text>
      {colors.map((color, index) => {
        const start = Math.floor((index * cells) / segments);
        const end = Math.floor(((index + 1) * cells) / segments);
        return (
          <Text key={index} color={color}>
            {"▔".repeat(end - start)}
          </Text>
        );
      })}
    </Text>
  );
}

const MAX_GRADIENT_SEGMENTS = 16;

/**
 * Filled composer surface: gradient top edge, a `❯` gutter beside the editor,
 * and optional rows (attachments above, meta below) inside the card.
 */
export function ComposerCard({
  width,
  height,
  focused,
  header,
  footer,
  children,
}: {
  readonly width: number;
  readonly height?: number;
  readonly focused: boolean;
  readonly header?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      width={width}
      {...(height !== undefined ? { height, overflow: "hidden" as const } : {})}
      flexShrink={0}
      backgroundColor={tuiTheme.surface}
    >
      <GradientStrip width={width} active={focused} />
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text bold color={focused ? tuiTheme.accent : tuiTheme.faint}>
              ❯
            </Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {children}
          </Box>
        </Box>
        {footer}
      </Box>
    </Box>
  );
}

/** `code · provider / model · reasoning high` line shown inside the welcome card. */
export function SessionMeta({
  projection,
}: {
  readonly projection: StandaloneSessionProjection;
}): React.JSX.Element {
  const separator = <Text color={tuiTheme.faint}> · </Text>;
  return (
    <Box paddingLeft={2}>
      <Text wrap="truncate-end">
        <Text color={tuiTheme.accent}>{projection.mode}</Text>
        {separator}
        {projection.model ? (
          <>
            <Text color={tuiTheme.muted}>
              {sanitizeTerminalText(projection.model.providerId)}
            </Text>
            <Text color={tuiTheme.faint}> / </Text>
            <Text bold color={tuiTheme.text}>
              {sanitizeTerminalText(projection.model.modelId)}
            </Text>
          </>
        ) : (
          <Text color={tuiTheme.muted}>default model</Text>
        )}
        {separator}
        <Text color={tuiTheme.faint}>
          reasoning {projection.reasoningEffort ?? "default"}
        </Text>
      </Text>
    </Box>
  );
}

export interface KeyHint {
  readonly key: string;
  readonly label: string;
}

export type FooterTone = "ready" | "working" | "waiting";

const HINT_GAP = 3;

/** Keep hints from the left until they no longer fit; drop the rest. */
export function fitKeyHints(
  hints: readonly KeyHint[],
  width: number,
): KeyHint[] {
  const fitted: KeyHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const size =
      hint.key.length + 1 + hint.label.length + (fitted.length ? HINT_GAP : 0);
    if (used + size > width) break;
    fitted.push(hint);
    used += size;
  }
  return fitted;
}

/** Status on the left (ready / working / waiting) and width-aware key hints on the right. */
export function ShellFooter({
  width,
  tone,
  status,
  hints,
}: {
  readonly width: number;
  readonly tone: FooterTone;
  readonly status: string;
  readonly hints: readonly KeyHint[];
}): React.JSX.Element {
  const statusText = singleLine(status);
  const fitted = fitKeyHints(hints, Math.max(0, width - statusText.length - 4));
  const toneColor =
    tone === "working"
      ? tuiTheme.accent
      : tone === "waiting"
        ? tuiTheme.warn
        : tuiTheme.faint;
  return (
    <Box
      width={width}
      height={1}
      flexShrink={0}
      justifyContent="space-between"
      paddingX={1}
      overflow="hidden"
    >
      <Text color={toneColor} wrap="truncate-end">
        {statusText}
      </Text>
      <Text wrap="truncate-end">
        {fitted.map((hint, index) => (
          <React.Fragment key={hint.key}>
            {index > 0 ? " ".repeat(HINT_GAP) : ""}
            <Text color={tuiTheme.muted}>{hint.key}</Text>
            <Text color={tuiTheme.faint}> {hint.label}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}

/**
 * One-row session header: brand, project and session on the left; mode,
 * model and usage on the right, dropping lower-priority fields when narrow.
 */
export function ShellHeader({
  projection,
  columns,
}: {
  readonly projection: StandaloneSessionProjection;
  readonly columns: number;
}): React.JSX.Element {
  const project = sanitizeTerminalText(
    path.basename(projection.projectRoot) || projection.projectRoot,
  );
  const session = projection.sessionId?.slice(0, 12) ?? "starting";
  const brand = "agentlink";
  const brandColors = gradientColors(brand.length, BRAND_GRADIENT);
  const leftWidth = 2 + brand.length + 3 + project.length + 3 + session.length;

  const model = projection.model
    ? sanitizeTerminalText(projection.model.modelId)
    : "default model";
  const usage = projection.usage
    ? `↑${formatTokenCount(projection.usage.inputTokens)} ↓${formatTokenCount(projection.usage.outputTokens)}`
    : undefined;
  // Ordered by display position; `priority` decides what survives when narrow.
  const fields = [
    { text: projection.mode, color: tuiTheme.accent, priority: 2 },
    {
      text: `${projection.writePolicy} writes`,
      color: tuiTheme.muted,
      priority: 3,
    },
    { text: model, color: tuiTheme.text, priority: 0 },
    {
      text: `${projection.reasoningEffort ?? "default"} reasoning`,
      color: tuiTheme.muted,
      priority: 1,
    },
    ...(usage ? [{ text: usage, color: tuiTheme.faint, priority: 4 }] : []),
  ];
  const budget = Math.max(0, columns - leftWidth - 4);
  const kept = new Set(fields);
  const widthOf = (items: typeof fields) =>
    items.reduce((sum, item) => sum + item.text.length, 0) +
    Math.max(0, items.length - 1) * 3;
  for (const field of [...fields].sort((a, b) => b.priority - a.priority)) {
    if (widthOf(fields.filter((item) => kept.has(item))) <= budget) break;
    kept.delete(field);
  }
  const visible = fields.filter((item) => kept.has(item));

  return (
    <Box
      justifyContent="space-between"
      paddingX={1}
      height={1}
      flexShrink={0}
      overflow="hidden"
    >
      <Text wrap="truncate-end">
        <Text color={tuiTheme.accent}>◆ </Text>
        {[...brand].map((char, index) => (
          <Text key={index} bold color={brandColors[index]}>
            {char}
          </Text>
        ))}
        <Text color={tuiTheme.faint}> ▏ </Text>
        <Text color={tuiTheme.text}>{project}</Text>
        <Text color={tuiTheme.faint}> ▸ </Text>
        <Text color={tuiTheme.muted}>{session}</Text>
      </Text>
      <Text wrap="truncate-end">
        {visible.map((field, index) => (
          <React.Fragment key={field.text}>
            {index > 0 ? <Text color={tuiTheme.faint}> · </Text> : null}
            <Text color={field.color}>{field.text}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}

function singleLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}
