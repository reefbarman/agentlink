import type { NodePtyModule, NodePtyProcess } from "../nodePtyFactory.js";
import { describe, expect, it, vi } from "vitest";

import { NodePtyNativeAgentRuntimeProvider } from "./NativeAgentRuntimeProvider.js";
import type { SandboxCommandEvent } from "../sandbox/SandboxRuntimeProvider.js";

const nonce = "native_shell_nonce_1234";

function frame(kind: string, value?: string): string {
  return `\x1b]697;AgentLink;${nonce};${kind}${value === undefined ? "" : `;${value}`}\x07`;
}

class FakeNodePtyProcess implements NodePtyProcess {
  readonly pid = 42;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly kill = vi.fn();
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  private dataListener: ((data: string) => void) | undefined;
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | undefined;

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = undefined) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = undefined) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

function launch(
  runtime: NodePtyNativeAgentRuntimeProvider,
  shell: "bash" | "zsh" = "zsh",
) {
  const cleanup = vi.fn(async () => undefined);
  const closed = vi.fn();
  const cwdEvents: string[] = [];
  const rawData: string[] = [];
  const ready = runtime.prepareChannel({
    channelId: "native-agent-1",
    launch: {
      shell,
      nonce,
      cleanup,
      profile: {
        profileName: "zsh",
        provenance: "configured",
        shellPath: "/bin/zsh",
        shellArgs: ["-l", "-i"],
        cwd: "/workspace",
        environment: { PATH: "/usr/bin:/bin", ZDOTDIR: "/bootstrap" },
      },
    },
    dimensions: { columns: 100, rows: 30 },
    onData: (data) => rawData.push(data),
    onCwd: (cwd) => cwdEvents.push(cwd),
    onClosed: closed,
  });
  return { cleanup, closed, cwdEvents, rawData, ready };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function emitInitialPrompt(
  pty: FakeNodePtyProcess,
  ready: Promise<void>,
): Promise<void> {
  pty.emitData(
    `${frame("P", "/workspace")}${frame("A")}➜  workspace ${frame("B")}`,
  );
  await ready;
}

describe("NodePtyNativeAgentRuntimeProvider", () => {
  it("keeps one interactive shell and resolves commands from integration markers", async () => {
    const pty = new FakeNodePtyProcess();
    const nodePty: NodePtyModule = { spawn: vi.fn(() => pty) };
    const runtime = new NodePtyNativeAgentRuntimeProvider(nodePty);
    const channel = launch(runtime);

    expect(nodePty.spawn).toHaveBeenCalledWith("/bin/zsh", ["-l", "-i"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: "/workspace",
      env: { PATH: "/usr/bin:/bin", ZDOTDIR: "/bootstrap" },
      encoding: "utf8",
      handleFlowControl: false,
    });
    await emitInitialPrompt(pty, channel.ready);

    const first = runtime.createCommand({
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "typeset -g NATIVE_STATE=ready",
    });
    const firstEvents: SandboxCommandEvent[] = [];
    first.process.onEvent((event) => firstEvents.push(event));
    first.start();
    expect(pty.writes).toEqual([
      "builtin eval ' typeset -g NATIVE_STATE=ready'\r",
    ]);
    expect(channel.rawData.join("")).toContain(
      "➜  workspace typeset -g NATIVE_STATE=ready\r\n",
    );

    pty.emitData("builtin eval ' typeset -g NATIVE_STATE=ready'\r\n");
    expect(channel.rawData).not.toContain(
      "builtin eval ' typeset -g NATIVE_STATE=ready'\r\n",
    );
    pty.emitData(
      `${frame("C", "typeset -g NATIVE_STATE=ready")}${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}➜  workspace ${frame("B")}`,
    );
    await expect(first.process.completion).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
    });
    expect(firstEvents).not.toContainEqual({
      type: "data",
      data: "➜  workspace ",
    });

    const second = runtime.createCommand({
      channelId: "native-agent-1",
      commandId: "native-command-2",
      generation: 2,
      command: "printf $NATIVE_STATE",
    });
    const secondEvents: SandboxCommandEvent[] = [];
    second.process.onEvent((event) => secondEvents.push(event));
    second.start();
    pty.emitData(
      `${frame("C", "printf $NATIVE_STATE")}ready${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}➜  workspace ${frame("B")}`,
    );

    await expect(second.process.ready).resolves.toMatchObject({
      pid: 42,
      backend: "native-pty",
    });
    await expect(second.process.completion).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
    });
    expect(secondEvents).toContainEqual({ type: "data", data: "ready" });
    expect(channel.rawData).toContain("ready");
    expect(channel.cwdEvents).toContain("/workspace");
    expect(nodePty.spawn).toHaveBeenCalledOnce();

    channel.rawData.length = 0;
    expect(runtime.write("native-agent-1", "\x1b[A")).toBe(true);
    expect(pty.writes.at(-1)).toBe("\x1b[A");
    pty.emitData("\r\x1b[2K➜  workspace printf $NATIVE_STATE");
    expect(channel.rawData.join("")).toContain(
      "\r\x1b[2K➜  workspace printf $NATIVE_STATE",
    );
  });

  it("waits for the zsh prompt-end marker after delayed async prompt segments", async () => {
    vi.useFakeTimers();
    try {
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider({
        spawn: vi.fn(() => pty),
      });
      const channel = launch(runtime);
      pty.emitData(`${frame("P", "/workspace")}${frame("A")}➜  workspace`);
      await vi.advanceTimersByTimeAsync(100);
      let ready = false;
      void channel.ready.then(() => (ready = true));
      await flush();
      expect(ready).toBe(false);

      pty.emitData(" git:(main) ✗ ");
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(ready).toBe(false);

      pty.emitData(frame("B"));
      await channel.ready;
      expect(channel.rawData.join("")).toContain("➜  workspace git:(main) ✗ ");
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts an intentionally empty zsh initial prompt", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    pty.emitData(`${frame("P", "/workspace")}${frame("A")}${frame("B")}`);
    await expect(channel.ready).resolves.toBeUndefined();
    expect(channel.rawData).toEqual([]);
  });

  it("keeps the bash split-prompt idle fallback", async () => {
    vi.useFakeTimers();
    try {
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider({
        spawn: vi.fn(() => pty),
      });
      const channel = launch(runtime, "bash");
      pty.emitData(`${frame("P", "/workspace")}${frame("A")}bash`);
      await vi.advanceTimersByTimeAsync(20);
      let ready = false;
      void channel.ready.then(() => (ready = true));
      await flush();
      expect(ready).toBe(false);

      pty.emitData("$ ");
      await vi.advanceTimersByTimeAsync(24);
      await flush();
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await channel.ready;
      expect(channel.rawData.join("")).toContain("bash$ ");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the intentionally empty bash prompt fallback", async () => {
    vi.useFakeTimers();
    try {
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider({
        spawn: vi.fn(() => pty),
      });
      const channel = launch(runtime, "bash");
      pty.emitData(`${frame("P", "/workspace")}${frame("A")}`);
      await vi.advanceTimersByTimeAsync(25);
      await expect(channel.ready).resolves.toBeUndefined();
      expect(channel.rawData).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes a multiline script as one interactive-shell command cycle", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    const command = runtime.createCommand({
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "printf first\\nprintf second",
    });
    command.process.onEvent(() => undefined);
    command.start();
    expect(pty.writes).toEqual([
      "builtin eval ' printf first\\nprintf second'\r",
    ]);
    pty.emitData(
      `${frame("C", "builtin eval")}firstsecond${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}${frame("B")}`,
    );
    await expect(command.process.completion).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
    });
  });

  it("completes from the exit marker when cwd metadata is absent", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);
    const command = runtime.createCommand({
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "true",
    });
    command.process.onEvent(() => undefined);
    command.start();
    pty.emitData(`${frame("C", "builtin eval")}${frame("D", "0")}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pty.emitData(`${frame("P", "/workspace")}${frame("A")}${frame("B")}`);
    await expect(command.process.completion).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
    });
  });

  it("completes if the shell exits before the command-start marker", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    const command = runtime.createCommand({
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "exit 7",
    });
    command.process.onEvent(() => undefined);
    command.start();
    pty.emitExit(7);

    await expect(command.process.completion).resolves.toEqual({
      exitCode: 7,
      timedOut: false,
    });
    await expect(command.process.ready).resolves.toMatchObject({
      pid: 42,
      backend: "native-pty",
    });
    await flush();
    expect(channel.closed).toHaveBeenCalledOnce();
    expect(channel.cleanup).toHaveBeenCalledOnce();
  });

  it("reports the shell marker exit after Ctrl+C", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    const command = runtime.createCommand({
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "sleep 30",
    });
    command.process.onEvent(() => undefined);
    command.start();
    pty.emitData(`${frame("B")}${frame("C", "sleep 30")}`);

    expect(command.process.interrupt()).toBe(true);
    expect(pty.writes).toEqual(["builtin eval ' sleep 30'\r", "\x03"]);
    pty.emitData(
      `^C\r\n${frame("D", "130")}${frame("P", "/workspace")}${frame("A")}${frame("B")}`,
    );
    await expect(command.process.completion).resolves.toEqual({
      exitCode: 130,
      timedOut: false,
    });
  });

  it("rejects agent commands until an active user command reaches its prompt", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    pty.emitData(`${frame("B")}${frame("C", "sleep 1")}`);
    expect(() =>
      runtime.createCommand({
        channelId: "native-agent-1",
        commandId: "native-command-1",
        generation: 1,
        command: "pwd",
      }),
    ).toThrow("Native Agent terminal native-agent-1 is busy");

    pty.emitData(
      `${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}${frame("B")}`,
    );
    expect(() =>
      runtime.createCommand({
        channelId: "native-agent-1",
        commandId: "native-command-1",
        generation: 1,
        command: "pwd",
      }),
    ).not.toThrow();
  });

  it("forwards multiline user input to the PTY in one write", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    expect(
      runtime.write(
        "native-agent-1",
        "\x1b[200~printf one\nprintf two\n\x1b[201~",
      ),
    ).toBe(true);
    expect(pty.writes).toEqual(["\x1b[200~printf one\nprintf two\n\x1b[201~"]);
  });

  it("publishes cwd changes from idle user commands", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    pty.emitData(
      `${frame("C", "cd /other")}${frame("D", "0")}${frame("P", "/other")}${frame("A")}${frame("B")}`,
    );
    expect(channel.cwdEvents).toEqual(["/workspace", "/other"]);
  });

  it("closes and cleans a shell whose integration startup times out", async () => {
    vi.useFakeTimers();
    try {
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider(
        { spawn: vi.fn(() => pty) },
        { startupTimeoutMs: 25 },
      );
      const channel = launch(runtime);
      const rejection = expect(channel.ready).rejects.toThrow(
        "Native Agent shell integration startup timed out",
      );

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(pty.kill).toHaveBeenCalledOnce();
      await flush();
      expect(channel.cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resizes, closes, and cleans only its owned persistent shell", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    expect(runtime.resize("native-agent-1", { columns: 120, rows: 40 })).toBe(
      true,
    );
    expect(pty.resizes).toEqual([[120, 40]]);
    expect(runtime.closeChannel("host-terminal-1")).toBe(false);
    expect(runtime.closeChannel("native-agent-1")).toBe(true);
    expect(pty.kill).toHaveBeenCalledOnce();
    await flush();
    expect(channel.closed).toHaveBeenCalledOnce();
    expect(channel.cleanup).toHaveBeenCalledOnce();
  });
});
