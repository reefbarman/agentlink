import React, { useState } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";

import { Box } from "ink";
import { TextArea } from "./TextArea.js";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const originalColorLevel = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  return previous;
});

afterEach(cleanup);
afterAll(() => {
  if (originalColorLevel === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalColorLevel;
});

function Editor({
  initialValue,
  focused = true,
  columns = 12,
  lines = 3,
}: {
  readonly initialValue: string;
  readonly focused?: boolean;
  readonly columns?: number;
  readonly lines?: number;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  return (
    <Box width={columns} flexDirection="column">
      <TextArea
        isFocused={focused}
        value={value}
        onChange={setValue}
        onSubmit={() => undefined}
        viewportColumns={columns}
        viewportLines={lines}
        labels={[{ pattern: /@\S+/u, label: "mention" }]}
        styles={{ text: { color: "white" }, mention: { color: "cyan" } }}
      />
    </Box>
  );
}

function cursors(frame: string | undefined): string[] {
  return (frame ?? "")
    .split("\u001b[7m")
    .slice(1)
    .map((part) => stripAnsi(part.split("\u001b[27m")[0]!));
}

async function input(
  screen: ReturnType<typeof render>,
  key: string,
): Promise<void> {
  // Ink commits input listeners and cursor updates concurrently.
  await new Promise((resolve) => setTimeout(resolve, 20));
  screen.stdin.write(key);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("TextArea rendering", () => {
  it("renders exactly one cursor across multiline end and character positions", async () => {
    const screen = render(<Editor initialValue={"first\nsecond\nlast"} />);
    expect(cursors(screen.lastFrame())).toEqual([" "]);
    expect(stripAnsi(screen.lastFrame()!)).toContain("first\nsecond\nlast");

    await input(screen, "\u001b[H");
    expect(cursors(screen.lastFrame())).toEqual(["l"]);
    await input(screen, "\u001b[A");
    expect(cursors(screen.lastFrame())).toEqual(["s"]);
    await input(screen, "\u001b[A");
    expect(cursors(screen.lastFrame())).toEqual(["f"]);
    await input(screen, "\u001b[F");
    expect(cursors(screen.lastFrame())).toEqual([" "]);
  });

  it("renders no cursor when unfocused, at either a line end or a character", async () => {
    const screen = render(
      <Editor initialValue={"first\nlast"} focused={false} />,
    );
    expect(cursors(screen.lastFrame())).toEqual([]);
    screen.rerender(<Editor initialValue={"first\nlast"} />);
    await input(screen, "\u001b[H");
    expect(cursors(screen.lastFrame())).toEqual(["l"]);
    screen.rerender(<Editor initialValue={"first\nlast"} focused={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cursors(screen.lastFrame())).toEqual([]);
  });

  it("keeps the newest text and cursor visible through horizontal navigation", async () => {
    const screen = render(
      <Editor initialValue="0123456789ABCDEFGHIJ" columns={8} />,
    );
    const expectViewport = (text: string, cursor: string) => {
      const frame = screen.lastFrame()!;
      expect(stripAnsi(frame)).toBe(text);
      expect(stringWidth(frame)).toBeLessThanOrEqual(8);
      expect(cursors(frame)).toEqual([cursor]);
    };
    expectViewport("DEFGHIJ ", " ");
    await input(screen, "\u001b[H");
    expectViewport("01234567", "0");
    for (let index = 1; index <= 8; index += 1) {
      await input(screen, "\u001b[C");
      expect(cursors(screen.lastFrame())).toEqual([String(index)]);
      expect(stringWidth(screen.lastFrame()!)).toBeLessThanOrEqual(8);
    }
    expectViewport("12345678", "8");
    for (let index = 7; index >= 0; index -= 1) {
      await input(screen, "\u001b[D");
      expect(cursors(screen.lastFrame())).toEqual([String(index)]);
      expect(stringWidth(screen.lastFrame()!)).toBeLessThanOrEqual(8);
    }
    expectViewport("01234567", "0");
    await input(screen, "\u001b[F");
    expectViewport("DEFGHIJ ", " ");
    await input(screen, "!");
    expectViewport("EFGHIJ! ", " ");
  });

  it("refills the tail when the viewport grows or the value is replaced", async () => {
    const editor = (value: string, columns: number) => (
      <Box width={columns} flexDirection="column">
        <TextArea
          isFocused
          value={value}
          onChange={() => undefined}
          onSubmit={() => undefined}
          viewportColumns={columns}
        />
      </Box>
    );
    const screen = render(editor("0123456789ABCDEFGHIJ", 8));
    screen.rerender(editor("0123456789ABCDEFGHIJ", 12));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stripAnsi(screen.lastFrame()!)).toBe("9ABCDEFGHIJ ");
    expect(cursors(screen.lastFrame())).toEqual([" "]);
    screen.rerender(editor("short", 8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stripAnsi(screen.lastFrame()!)).toBe("short ");
    expect(cursors(screen.lastFrame())).toEqual([" "]);
  });

  it("keeps a cursor cell when a wide character cannot fit the viewport", async () => {
    const screen = render(<Editor initialValue="界" columns={1} />);
    expect(cursors(screen.lastFrame())).toEqual([" "]);
    await input(screen, "\u001b[H");
    expect(cursors(screen.lastFrame())).toEqual([" "]);
    expect(stringWidth(screen.lastFrame()!)).toBe(1);
  });

  it("bounds wide Unicode text without losing clipped mention styling", async () => {
    const screen = render(
      <Editor initialValue="prefix界界 @mention界界" columns={10} />,
    );
    expect(stripAnsi(screen.lastFrame()!)).toBe("ntion界界 ");
    expect(screen.lastFrame()).toContain("\u001b[36mntion界界\u001b[39m");
    expect(cursors(screen.lastFrame())).toEqual([" "]);
    expect(stringWidth(screen.lastFrame()!)).toBe(10);
    await input(screen, "\u001b[D");
    expect(cursors(screen.lastFrame())).toEqual(["界"]);
    expect(stringWidth(screen.lastFrame()!)).toBeLessThanOrEqual(10);
    await input(screen, "\u001b[H");
    expect(stripAnsi(screen.lastFrame()!)).toBe("prefix界界");
    expect(cursors(screen.lastFrame())).toEqual(["p"]);
    await input(screen, "\u001b[F");
    expect(stripAnsi(screen.lastFrame()!)).toBe("ntion界界 ");
    expect(screen.lastFrame()).toContain("\u001b[36mntion界界\u001b[39m");
    expect(cursors(screen.lastFrame())).toEqual([" "]);
  });
});
