import type { NodePtyModule, NodePtyProcess } from "../nodePtyFactory.js";
import { describe, expect, it, vi } from "vitest";

import { NodePtyNativeAgentRuntimeProvider } from "./NativeAgentRuntimeProvider.js";
import type { SandboxCommandEvent } from "../sandbox/SandboxRuntimeProvider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const nonce = "native_shell_nonce_1234";
const artifactDispatch = expect.stringMatching(
  /^builtin eval "\$\(<'[^']*\/agentlink-native-command-[^/]+\/command\.sh'\)"\r$/,
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function dispatchedArtifactPath(pty: FakeNodePtyProcess): string {
  const dispatch = pty.writes.at(-1) ?? "";
  const match = dispatch.match(/^builtin eval "\$\(<'(.+)'\)"\r$/);
  if (!match?.[1])
    throw new Error(`Unexpected native command dispatch: ${dispatch}`);
  return match[1];
}

function nativeStartMarker(pty: FakeNodePtyProcess): string {
  const content = fs.readFileSync(dispatchedArtifactPath(pty), "utf8");
  const marker = content.match(
    /AgentLink;[^;]+;C;(agentlink_native_start_[A-Za-z0-9]+)/,
  );
  if (!marker?.[1]) throw new Error("Native artifact has no start marker");
  return marker[1];
}

function scriptStartFrame(pty: FakeNodePtyProcess): string {
  return frame("C", nativeStartMarker(pty));
}

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
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "typeset -g NATIVE_STATE=ready",
    });
    const firstEvents: SandboxCommandEvent[] = [];
    first.process.onEvent((event) => firstEvents.push(event));
    first.start();
    expect(pty.writes).toEqual([artifactDispatch]);
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
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-2",
      generation: 2,
      command: "printf $NATIVE_STATE",
    });
    const secondEvents: SandboxCommandEvent[] = [];
    second.process.onEvent((event) => secondEvents.push(event));
    second.start();
    pty.emitData(
      `${frame("C", "printf $NATIVE_STATE")}${scriptStartFrame(pty)}ready${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}➜  workspace ${frame("B")}`,
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

    const third = runtime.createCommand({
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-3",
      generation: 3,
      command: "printf 'triage-output\\r'",
    });
    const thirdEvents: SandboxCommandEvent[] = [];
    third.process.onEvent((event) => thirdEvents.push(event));
    third.start();
    const outputEndFrame = frame("O");
    pty.emitData(
      `${frame("C", "printf triage-output")}triage-output\r${outputEndFrame.slice(0, -1)}`,
    );
    pty.emitData(
      `${outputEndFrame.slice(-1)}                                    \r\r${frame("D", "7")}${frame("P", "/workspace")}${frame("A")}➜  workspace ${frame("B")}`,
    );

    await expect(third.process.completion).resolves.toEqual({
      exitCode: 7,
      timedOut: false,
    });
    expect(thirdEvents).toContainEqual({
      type: "data",
      data: "triage-output\r",
    });
    expect(thirdEvents).not.toContainEqual({
      type: "data",
      data: "                                    \r\r",
    });
    expect(thirdEvents).toContainEqual({
      type: "cwd",
      cwd: "/workspace",
      nonce,
    });
    expect(channel.rawData.join("")).toContain(
      "                                    \r\r➜  workspace ",
    );

    channel.rawData.length = 0;
    expect(runtime.write("native-agent-1", "\x1b[A")).toBe(true);
    expect(pty.writes.at(-1)).toBe("\x1b[A");
    pty.emitData("\r\x1b[2K➜  workspace printf $NATIVE_STATE");
    expect(channel.rawData.join("")).toContain(
      "\r\x1b[2K➜  workspace printf $NATIVE_STATE",
    );
  });

  it("isolates shell evaluation without changing the visible command", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    const command = runtime.createCommand({
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "export NATIVE_STATE=ready",
      isolateShellState: true,
    });
    command.process.onEvent(() => undefined);
    command.start();

    expect(pty.writes).toEqual([artifactDispatch]);
    expect(channel.rawData.join("")).toContain(
      "➜  workspace export NATIVE_STATE=ready\r\n",
    );
    expect(channel.rawData.join("")).not.toContain(
      "➜  workspace (\nexport NATIVE_STATE=ready\n)",
    );
  });

  it("dispatches complex commands through a verified private artifact and removes it", async () => {
    const artifactRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-native-artifact-test-"),
    );
    try {
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider(
        { spawn: vi.fn(() => pty) },
        { commandFileRoot: artifactRoot },
      );
      const channel = launch(runtime);
      await emitInitialPrompt(pty, channel.ready);
      const commandText = [
        "curl -w 'status=%{http_code}\\n' http://127.0.0.1:18888/config; docker inspect service --format '{{.State.Status}}'",
        "git push --atomic --force-with-lease=refs/heads/main:2a0cb3f120d76fb5fe378c92d50202d4c4de7241 origin refs/heads/main",
        "",
      ].join("\n");
      const command = runtime.createCommand({
        cwd: "/workspace",
        channelId: "native-agent-1",
        commandId: "native-command-complex",
        generation: 1,
        command: commandText,
        isolateShellState: true,
      });
      command.process.onEvent(() => undefined);
      command.start();

      const artifactPath = dispatchedArtifactPath(pty);
      expect(fs.statSync(path.dirname(artifactPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(artifactPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(artifactPath, "utf8")).toBe(
        `builtin printf '\\033]697;AgentLink;${nonce};C;${nativeStartMarker(pty)}\\007' >/dev/tty\n{ builtin test . -ef '/workspace' || builtin cd -L -- '/workspace'; } && builtin eval ${shellQuote(` (\n${commandText}\n)`)}\n`,
      );

      pty.emitData(
        `${frame("C", "builtin eval")}${scriptStartFrame(pty)}${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}${frame("B")}`,
      );
      await command.process.completion;
      expect(fs.existsSync(path.dirname(artifactPath))).toBe(false);
      runtime.dispose();
    } finally {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "keeps the artifact after disposal until shell completion (started: %s)",
    async (shellStarted) => {
      const artifactRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-native-dispose-test-"),
      );
      try {
        const pty = new FakeNodePtyProcess();
        const runtime = new NodePtyNativeAgentRuntimeProvider(
          { spawn: vi.fn(() => pty) },
          { commandFileRoot: artifactRoot },
        );
        const channel = launch(runtime);
        await emitInitialPrompt(pty, channel.ready);
        const command = runtime.createCommand({
          cwd: "/workspace",
          channelId: "native-agent-1",
          commandId: "native-command-disposed",
          generation: 1,
          command: "gh pr view",
        });
        command.start();
        const artifactPath = dispatchedArtifactPath(pty);

        if (shellStarted) {
          pty.emitData(`${frame("C", "builtin eval")}${scriptStartFrame(pty)}`);
          await expect(command.process.ready).resolves.toMatchObject({
            pid: 42,
            backend: "native-pty",
          });
        }
        command.process.dispose();

        expect(fs.existsSync(artifactPath)).toBe(true);
        expect(pty.kill).not.toHaveBeenCalled();
        if (!shellStarted) pty.emitData(frame("C", "builtin eval"));
        pty.emitData(
          `${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}➜  workspace ${frame("B")}`,
        );
        await expect(command.process.completion).resolves.toEqual({
          exitCode: 0,
          timedOut: false,
        });
        expect(fs.existsSync(artifactPath)).toBe(false);
        expect(runtime.hasChannel("native-agent-1")).toBe(true);
        runtime.dispose();
      } finally {
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["output callback", "PTY write"])(
    "releases the channel and artifact when dispatch fails in %s",
    async (failure) => {
      const artifactRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-native-dispatch-failure-"),
      );
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider(
        { spawn: vi.fn(() => pty) },
        { commandFileRoot: artifactRoot },
      );
      try {
        const channel = launch(runtime);
        await emitInitialPrompt(pty, channel.ready);
        const command = runtime.createCommand({
          cwd: "/workspace",
          channelId: "native-agent-1",
          commandId: "failed-dispatch",
          generation: 1,
          command: "gh pr view",
        });
        const dispatchFailure = () => {
          throw new Error("dispatch failed");
        };
        if (failure === "output callback") {
          vi.spyOn(channel.rawData, "push").mockImplementationOnce(
            dispatchFailure,
          );
        } else {
          vi.spyOn(pty, "write").mockImplementationOnce(dispatchFailure);
        }
        expect(() => command.start()).toThrow("dispatch failed");
        await expect(command.process.completion).resolves.toEqual({
          timedOut: false,
        });
        expect(fs.readdirSync(artifactRoot)).toEqual([]);
        const next = runtime.createCommand({
          cwd: "/workspace",
          channelId: "native-agent-1",
          commandId: "after-failed-dispatch",
          generation: 2,
          command: "pwd",
        });
        next.process.dispose();
        expect(pty.kill).not.toHaveBeenCalled();
      } finally {
        runtime.dispose();
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["/bin/bash", "/bin/zsh"])(
    "preserves top-level eval semantics through the artifact in %s",
    async (shell) => {
      const artifactRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-native-semantics-test-"),
      );
      try {
        const pty = new FakeNodePtyProcess();
        const runtime = new NodePtyNativeAgentRuntimeProvider(
          { spawn: vi.fn(() => pty) },
          { commandFileRoot: artifactRoot },
        );
        const channel = launch(runtime);
        await emitInitialPrompt(pty, channel.ready);
        const command = runtime.createCommand({
          cwd: artifactRoot,
          channelId: "native-agent-1",
          commandId: "native-command-semantics",
          generation: 1,
          command: "return 0; printf reached\n\n",
          isolateShellState: false,
        });
        command.process.onEvent(() => undefined);
        command.start();

        const commandText = "return 0; printf reached\n\n";
        const direct = spawnSync(
          shell,
          ["-c", `builtin eval ${shellQuote(` ${commandText}`)}`],
          { encoding: "utf8" },
        );
        const artifact = spawnSync(shell, ["-c", pty.writes.at(-1)!.trim()], {
          encoding: "utf8",
        });
        expect({ status: artifact.status, stdout: artifact.stdout }).toEqual({
          status: direct.status,
          stdout: direct.stdout,
        });
        runtime.dispose();
      } finally {
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      }
    },
  );

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
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "printf first\\nprintf second",
    });
    command.process.onEvent(() => undefined);
    command.start();
    expect(pty.writes).toEqual([artifactDispatch]);
    pty.emitData(
      `${frame("C", "builtin eval")}${scriptStartFrame(pty)}firstsecond${frame("D", "0")}${frame("P", "/workspace")}${frame("A")}${frame("B")}`,
    );
    await expect(command.process.completion).resolves.toEqual({
      exitCode: 0,
      timedOut: false,
    });
  });

  it.each([
    ["/bin/bash", false],
    ["/bin/bash", true],
    ["/bin/zsh", false],
    ["/bin/zsh", true],
  ] as const)(
    "re-enters recreated directories and skips payloads for missing cwd in %s (isolated: %s)",
    async (shell, isolateShellState) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-native-cwd-"),
      );
      const cwd = path.join(root, "fixture's directory");
      fs.mkdirSync(cwd);
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider({
        spawn: vi.fn(() => pty),
      });
      try {
        const channel = launch(runtime);
        await emitInitialPrompt(pty, channel.ready);
        const command = runtime.createCommand({
          channelId: "native-agent-1",
          commandId: "native-command-cwd",
          generation: 1,
          cwd,
          command: "printf 'payload:%s' \"$PWD\"",
          isolateShellState,
        });
        command.start();
        const dispatch = pty.writes.at(-1)!.trim();
        const enterAndRemove = `builtin cd -P -- ${shellQuote(cwd)}\nrmdir -- ${shellQuote(cwd)}\n`;
        const recreated = spawnSync(
          shell,
          ["-c", `${enterAndRemove}mkdir -- ${shellQuote(cwd)}\n${dispatch}`],
          { encoding: "utf8" },
        );
        expect(recreated.status).toBe(0);
        expect(recreated.stdout).toBe(`payload:${cwd}`);
        const missing = spawnSync(
          shell,
          ["-c", `${enterAndRemove}${dispatch}`],
          { encoding: "utf8" },
        );
        expect(missing.status).not.toBe(0);
        expect(missing.stdout).not.toContain("payload:");
        expect(missing.stderr).toContain("fixture's directory");
      } finally {
        runtime.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["/bin/bash", "/bin/zsh"])(
    "preserves a matching logical cwd, OLDPWD, and directory hooks in %s",
    async (shell) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentlink-native-cwd-state-"),
      );
      const target = path.join(root, "target");
      const cwd = path.join(root, "logical link");
      fs.mkdirSync(target);
      fs.symlinkSync(target, cwd);
      const pty = new FakeNodePtyProcess();
      const runtime = new NodePtyNativeAgentRuntimeProvider({
        spawn: vi.fn(() => pty),
      });
      try {
        const channel = launch(runtime);
        await emitInitialPrompt(pty, channel.ready);
        const command = runtime.createCommand({
          channelId: "native-agent-1",
          commandId: "native-command-cwd-state",
          generation: 1,
          cwd,
          command: "printf 'payload:%s\\n' \"$PWD\"",
        });
        command.start();
        const dispatch = pty.writes.at(-1)!.trim();
        const zshSetup = shell.endsWith("zsh") ? "setopt AUTO_PUSHD\n" : "";
        const zshSnapshot = shell.endsWith("zsh")
          ? "saved_depth=${#dirstack}\n"
          : "";
        const zshCheck = shell.endsWith("zsh")
          ? ' && builtin test "${#dirstack}" = "$saved_depth"'
          : "";
        const script = `${zshSetup}builtin cd -L -- ${shellQuote(cwd)}\nsaved_oldpwd=$OLDPWD\n${zshSnapshot}chpwd() { printf unexpected-hook; }\n${dispatch}\n${dispatch}\nbuiltin test "$PWD" = ${shellQuote(cwd)} && builtin test "$OLDPWD" = "$saved_oldpwd"${zshCheck}\n`;
        const result = spawnSync(shell, ["-c", script], { encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`payload:${cwd}\npayload:${cwd}\n`);
      } finally {
        runtime.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("completes from the exit marker when cwd metadata is absent", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);
    const command = runtime.createCommand({
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "true",
    });
    command.process.onEvent(() => undefined);
    command.start();
    pty.emitData(
      `${frame("C", "builtin eval")}${scriptStartFrame(pty)}${frame("D", "0")}`,
    );
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
      cwd: "/workspace",
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
    await expect(command.process.ready).rejects.toThrow(
      "Native Agent shell ended before confirming whether the user command started",
    );
    await flush();
    expect(channel.closed).toHaveBeenCalledOnce();
    expect(channel.cleanup).toHaveBeenCalledOnce();
  });

  it("terminates only the active command and preserves the persistent shell", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    const onShellCommandEnd = vi.fn();
    const command = runtime.createCommand({
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "interactive-command",
      onShellCommandEnd,
    });
    command.process.onEvent(() => undefined);
    command.start();
    pty.emitData(`${frame("B")}${frame("C", "interactive-command")}`);

    expect(command.process.terminate()).toBe(true);
    expect(pty.writes).toEqual([artifactDispatch, "\x03"]);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(channel.closed).not.toHaveBeenCalled();

    pty.emitData(`^C\r\n${frame("D", "130")}`);
    expect(onShellCommandEnd).toHaveBeenCalledOnce();
    pty.emitData(`${frame("P", "/workspace")}${frame("A")}${frame("B")}`);
    await expect(command.process.completion).resolves.toEqual({
      exitCode: 130,
      timedOut: false,
    });
    expect(runtime.hasChannel("native-agent-1")).toBe(true);
    expect(channel.closed).not.toHaveBeenCalled();
  });

  it("reports the shell marker exit after Ctrl+C", async () => {
    const pty = new FakeNodePtyProcess();
    const runtime = new NodePtyNativeAgentRuntimeProvider({
      spawn: vi.fn(() => pty),
    });
    const channel = launch(runtime);
    await emitInitialPrompt(pty, channel.ready);

    const command = runtime.createCommand({
      cwd: "/workspace",
      channelId: "native-agent-1",
      commandId: "native-command-1",
      generation: 1,
      command: "sleep 30",
    });
    command.process.onEvent(() => undefined);
    command.start();
    pty.emitData(`${frame("B")}${frame("C", "sleep 30")}`);

    expect(command.process.interrupt()).toBe(true);
    expect(pty.writes).toEqual([artifactDispatch, "\x03"]);
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
        cwd: "/workspace",
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
        cwd: "/workspace",
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
