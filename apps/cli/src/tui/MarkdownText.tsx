import { marked, type Token, type Tokens } from "marked";
import { Box, Text } from "ink";
import React, { useMemo } from "react";

import { sanitizeTerminalText } from "./terminalText.js";

const MAX_MARKDOWN_BYTES = 256 * 1024;

export function MarkdownText({
  children,
  width,
}: {
  readonly children: string;
  readonly width: number;
}): React.JSX.Element {
  const tokens = useMemo(
    () => marked.lexer(boundMarkdown(sanitizeTerminalText(children))),
    [children],
  );
  return <BlockTokens tokens={tokens} width={width} />;
}

function BlockTokens({
  tokens,
  width,
}: {
  readonly tokens: readonly Token[];
  readonly width: number;
}): React.JSX.Element {
  const blocks = tokens.flatMap((token, index) => {
    if (token.type === "space") return [];
    const following = tokens[index + 1];
    return [
      {
        token,
        blankLines:
          following?.type === "space"
            ? Math.max(1, (following.raw.match(/\n/gu)?.length ?? 1) - 1)
            : 0,
      },
    ];
  });

  return (
    <Box flexDirection="column" width={width}>
      {blocks.map(({ token, blankLines }, index) => (
        <Box
          key={`${token.type}:${index}`}
          flexDirection="column"
          marginBottom={blankLines}
        >
          <BlockToken token={token} width={width} />
        </Box>
      ))}
    </Box>
  );
}

function BlockToken({
  token,
  width,
}: {
  readonly token: Token;
  readonly width: number;
}): React.JSX.Element | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      return (
        <Text bold color="cyan">
          {inlineTokens(heading.tokens)}
        </Text>
      );
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return <Text wrap="wrap">{inlineTokens(paragraph.tokens)}</Text>;
    }
    case "code":
      return (
        <Box borderStyle="single" borderColor="gray" paddingX={1} width={width}>
          <Text color="yellow">{token.text}</Text>
        </Box>
      );
    case "blockquote": {
      const blockquote = token as Tokens.Blockquote;
      return (
        <Box borderStyle="single" borderLeft paddingLeft={1} width={width}>
          <BlockTokens
            tokens={blockquote.tokens}
            width={Math.max(10, width - 3)}
          />
        </Box>
      );
    }
    case "list": {
      const list = token as Tokens.List;
      return (
        <Box flexDirection="column">
          {list.items.map((item, index) => (
            <Box key={`${item.type}:${index}`}>
              <Text>
                {list.ordered
                  ? `${Number(list.start || 1) + index}.`
                  : "•"}{" "}
              </Text>
              <Box flexDirection="column" flexGrow={1}>
                <BlockTokens
                  tokens={item.tokens}
                  width={Math.max(10, width - 3)}
                />
              </Box>
            </Box>
          ))}
        </Box>
      );
    }
    case "hr":
      return <Text dimColor>{"─".repeat(Math.max(1, width))}</Text>;
    case "html":
      return <Text dimColor>{token.text}</Text>;
    case "table":
      return <MarkdownTable token={token as Tokens.Table} width={width} />;
    case "text": {
      const text = token as Tokens.Text;
      return <Text>{inlineTokens(text.tokens ?? [text])}</Text>;
    }
    default:
      return <Text>{token.raw.trimEnd()}</Text>;
  }
}

function inlineTokens(tokens: readonly Token[]): React.ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.type}:${index}`;
    switch (token.type) {
      case "strong":
        return (
          <Text key={key} bold>
            {inlineTokens((token as Tokens.Strong).tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={key} italic>
            {inlineTokens((token as Tokens.Em).tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={key} strikethrough>
            {inlineTokens((token as Tokens.Del).tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={key} color="yellow">
            {token.text}
          </Text>
        );
      case "link":
        return (
          <Text key={key} color="blue" underline>
            {inlineTokens((token as Tokens.Link).tokens)}
          </Text>
        );
      case "br":
        return "\n";
      case "escape":
        return (token as Tokens.Escape).text;
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens
          ? inlineTokens(text.tokens)
          : text.text.replace(/\n/gu, " ");
      }
      case "image":
        return `[image: ${token.text || token.href}]`;
      default:
        return token.raw;
    }
  });
}

function MarkdownTable({
  token,
  width,
}: {
  readonly token: Tokens.Table;
  readonly width: number;
}): React.JSX.Element {
  const rows = [token.header, ...token.rows];
  const columnCount = token.header.length;
  const separatorWidth = 3 * columnCount + 1;
  const columnWidth = Math.max(
    1,
    Math.floor(
      (Math.max(separatorWidth + columnCount, width) - separatorWidth) /
        columnCount,
    ),
  );

  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      {rows.map((row, rowIndex) => (
        <Box key={`row:${rowIndex}`} flexShrink={0}>
          <Text>{"| "}</Text>
          {row.map((cell, cellIndex) => (
            <React.Fragment key={`cell:${cellIndex}`}>
              <Box width={columnWidth} flexShrink={0} overflow="hidden">
                <Text bold={rowIndex === 0} wrap="truncate-end">
                  {inlineTokens(cell.tokens)}
                </Text>
              </Box>
              <Text>{cellIndex === columnCount - 1 ? " |" : " | "}</Text>
            </React.Fragment>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function boundMarkdown(markdown: string): string {
  if (Buffer.byteLength(markdown) <= MAX_MARKDOWN_BYTES) return markdown;
  return `${Buffer.from(markdown).subarray(0, MAX_MARKDOWN_BYTES).toString("utf8")}\n\n[message truncated]`;
}
