import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createNodePtyFactory,
  type NodePtyForkOptions,
  type NodePtyModule,
  type NodePtyProcess,
} from "./nodePtyFactory.js";
import type {
  HostPtyDisposable,
  HostPtyExitEvent,
  HostPtySpawnOptions,
} from "./TerminalSessionService.js";

class FakeNodePtyProcess implements NodePtyProcess {
  readonly write = vi.fn<(data: string) => void>();
  readonly resize = vi.fn<(columns: number, rows: number) => void>();
  readonly kill = vi.fn<() => void>();
  readonly pause = vi.fn<() => void>();
  readonly resume = vi.fn<() => void>();
  private dataListener?: (data: string) => void;
  private exitListener?: (event: HostPtyExitEvent) => void;
  readonly dataDisposable: HostPtyDisposable = { dispose: vi.fn() };
  readonly exitDisposable: HostPtyDisposable = { dispose: vi.fn() };

  onData(listener: (data: string) => void): HostPtyDisposable {
    this.dataListener = listener;
    return this.dataDisposable;
  }

  onExit(listener: (event: HostPtyExitEvent) => void): HostPtyDisposable {
    this.exitListener = listener;
    return this.exitDisposable;
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(event: HostPtyExitEvent): void {
    this.exitListener?.(event);
  }
}

function spawnOptions(): HostPtySpawnOptions {
  return {
    shellPath: "/bin/zsh",
    shellArgs: ["-l"],
    cwd: "/workspace",
    environment: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    dimensions: { columns: 120, rows: 40 },
  };
}

function createHarness(factoryOptions?: { terminalName?: string }) {
  const process = new FakeNodePtyProcess();
  const calls: Array<{
    file: string;
    args: string[];
    options: NodePtyForkOptions;
  }> = [];
  const nodePty: NodePtyModule = {
    spawn(file, args, options) {
      calls.push({ file, args, options });
      return process;
    },
  };
  return {
    process,
    calls,
    factory: createNodePtyFactory(nodePty, factoryOptions),
  };
}

describe("createNodePtyFactory", () => {
  it("remains structurally compatible with the installed node-pty module", () => {
    expectTypeOf<typeof import("node-pty")>().toExtend<NodePtyModule>();
  });

  it("maps resolved host-shell options to a UTF-8 node-pty launch", () => {
    const { factory, calls } = createHarness();

    factory.spawn(spawnOptions());

    expect(calls).toEqual([
      {
        file: "/bin/zsh",
        args: ["-l"],
        options: {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd: "/workspace",
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
          encoding: "utf8",
          handleFlowControl: false,
        },
      },
    ]);
  });

  it("copies mutable launch arguments before passing them to node-pty", () => {
    const { factory, calls } = createHarness();
    const options = spawnOptions();

    factory.spawn(options);
    options.shellArgs.push("--no-rcs");
    options.environment.PATH = "/changed";
    options.dimensions.columns = 1;

    expect(calls[0].args).toEqual(["-l"]);
    expect(calls[0].options.env.PATH).toBe("/usr/bin:/bin");
    expect(calls[0].options.cols).toBe(120);
  });

  it("forwards events, subscriptions, and process controls", () => {
    const { factory, process } = createHarness();
    const pty = factory.spawn(spawnOptions());
    const data = vi.fn<(value: string) => void>();
    const exit = vi.fn<(event: HostPtyExitEvent) => void>();

    expect(pty.onData(data)).toBe(process.dataDisposable);
    expect(pty.onExit(exit)).toBe(process.exitDisposable);
    process.emitData("hello 🙂");
    process.emitExit({ exitCode: 130, signal: 2 });
    pty.write("echo hello\r");
    pty.resize(80, 24);
    pty.pause();
    pty.resume();
    pty.kill();

    expect(data).toHaveBeenCalledWith("hello 🙂");
    expect(exit).toHaveBeenCalledWith({ exitCode: 130, signal: 2 });
    expect(process.write).toHaveBeenCalledWith("echo hello\r");
    expect(process.resize).toHaveBeenCalledWith(80, 24);
    expect(process.pause).toHaveBeenCalledOnce();
    expect(process.resume).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("uses a trimmed custom terminal name and defaults blank names", () => {
    const custom = createHarness({ terminalName: "  agentlink-host  " });
    custom.factory.spawn(spawnOptions());
    expect(custom.calls[0].options.name).toBe("agentlink-host");

    const blank = createHarness({ terminalName: "   " });
    blank.factory.spawn(spawnOptions());
    expect(blank.calls[0].options.name).toBe("xterm-256color");
  });

  it("propagates node-pty spawn failures without wrapping them", () => {
    const failure = new Error("native spawn failed");
    const nodePty: NodePtyModule = {
      spawn() {
        throw failure;
      },
    };
    const factory = createNodePtyFactory(nodePty);

    expect(() => factory.spawn(spawnOptions())).toThrow(failure);
  });
});
