import type {
  HostPty,
  HostPtyDisposable,
  HostPtyExitEvent,
  HostPtyFactory,
  HostPtySpawnOptions,
} from "./TerminalSessionService.js";

const DEFAULT_TERMINAL_NAME = "xterm-256color";

export interface NodePtyForkOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  encoding: "utf8";
  handleFlowControl: false;
}

export interface NodePtyProcess {
  onData(listener: (data: string) => void): HostPtyDisposable;
  onExit(listener: (event: HostPtyExitEvent) => void): HostPtyDisposable;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: NodePtyForkOptions,
  ): NodePtyProcess;
}

export interface NodePtyFactoryOptions {
  terminalName?: string;
}

class NodePtyHostPty implements HostPty {
  constructor(private readonly pty: NodePtyProcess) {}

  onData(listener: (data: string) => void): HostPtyDisposable {
    return this.pty.onData(listener);
  }

  onExit(listener: (event: HostPtyExitEvent) => void): HostPtyDisposable {
    return this.pty.onExit(listener);
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(columns: number, rows: number): void {
    this.pty.resize(columns, rows);
  }

  kill(): void {
    this.pty.kill();
  }

  pause(): void {
    this.pty.pause();
  }

  resume(): void {
    this.pty.resume();
  }
}

export function createNodePtyFactory(
  nodePty: NodePtyModule,
  options: NodePtyFactoryOptions = {},
): HostPtyFactory {
  const terminalName = options.terminalName?.trim() || DEFAULT_TERMINAL_NAME;

  return {
    spawn(spawnOptions: HostPtySpawnOptions): HostPty {
      const pty = nodePty.spawn(
        spawnOptions.shellPath,
        [...spawnOptions.shellArgs],
        {
          name: terminalName,
          cols: spawnOptions.dimensions.columns,
          rows: spawnOptions.dimensions.rows,
          cwd: spawnOptions.cwd,
          env: { ...spawnOptions.environment },
          encoding: "utf8",
          handleFlowControl: false,
        },
      );
      return new NodePtyHostPty(pty);
    },
  };
}
