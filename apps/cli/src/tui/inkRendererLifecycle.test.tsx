import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import React from "react";
import { render, Text, useApp, useInput } from "ink";
import type { SuspendTerminal } from "ink";

class FixtureStdin extends PassThrough {
  readonly isTTY = true;
  rawMode = false;

  setRawMode(value: boolean): this {
    this.rawMode = value;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

class FixtureStdout extends Writable {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  readonly chunks: string[] = [];

  override _write(
    chunk: Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  output(): string {
    return this.chunks.join("");
  }
}

describe("Ink renderer lifecycle", () => {
  it("restores terminal modes after normal exit", async () => {
    const stdin = new FixtureStdin();
    const stdout = new FixtureStdout();
    const screen = render(<InteractiveProbe />, {
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: stdout as never,
      interactive: true,
      alternateScreen: true,
      patchConsole: false,
    });

    await screen.waitUntilRenderFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stdin.rawMode).toBe(true);
    screen.unmount();
    await screen.waitUntilExit();

    expect(stdin.rawMode).toBe(false);
    expect(stdout.output()).toContain("\u001b[?1049l");
  });

  it("releases and restores terminal ownership around suspension", async () => {
    const stdin = new FixtureStdin();
    const stdout = new FixtureStdout();
    let suspendTerminal: SuspendTerminal | undefined;
    const screen = render(
      <SuspendProbe register={(suspend) => (suspendTerminal = suspend)} />,
      {
        stdin: stdin as never,
        stdout: stdout as never,
        stderr: stdout as never,
        interactive: true,
        alternateScreen: true,
        patchConsole: false,
      },
    );
    await screen.waitUntilRenderFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(suspendTerminal).toBeDefined();

    const suspension = await suspendTerminal!();
    expect(stdin.rawMode).toBe(false);
    expect(stdout.output()).toContain("\u001b[?1049l");

    await suspension.resume();
    expect(stdin.rawMode).toBe(true);
    expect(
      stdout.output().split("\u001b[?1049h").length - 1,
    ).toBeGreaterThanOrEqual(2);
    screen.unmount();
    await screen.waitUntilExit();
  });

  it("restores terminal modes after an injected render failure", async () => {
    const stdin = new FixtureStdin();
    const stdout = new FixtureStdout();
    const screen = render(<InteractiveProbe />, {
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: stdout as never,
      interactive: true,
      alternateScreen: true,
      patchConsole: false,
    });
    await screen.waitUntilRenderFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    screen.rerender(<InjectedFailure />);
    await expect(screen.waitUntilExit()).rejects.toThrow(
      "injected fixture failure",
    );

    expect(stdin.rawMode).toBe(false);
    expect(stdout.output()).toContain("\u001b[?1049l");
  });
});

function InteractiveProbe(): React.JSX.Element {
  useInput(() => undefined);
  return <Text>Lifecycle probe ready</Text>;
}

function SuspendProbe({
  register,
}: {
  readonly register: (suspend: SuspendTerminal) => void;
}): React.JSX.Element {
  const { suspendTerminal } = useApp();
  React.useLayoutEffect(
    () => register(suspendTerminal),
    [register, suspendTerminal],
  );
  useInput(() => undefined);
  return <Text>Suspend probe ready</Text>;
}

function InjectedFailure(): React.JSX.Element {
  throw new Error("injected fixture failure");
}
