import type {
  SandboxCommandIdentity,
  SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";

import type { SandboxViolation } from "../../core/sandboxPolicy.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";

export interface SandboxCommandReady {
  pid: number;
  pgid: number;
  backend: string;
  backendVersion?: string;
}

export interface SandboxCommandExit {
  exitCode?: number;
  signal?: number;
  timedOut: boolean;
}

export type SandboxCommandEvent =
  | { type: "data"; data: string }
  | { type: "cwd"; cwd: string; nonce: string }
  | { type: "violation"; violation: SandboxViolation };

export interface SandboxCommandDisposable {
  dispose(): void;
}

export interface SandboxCommandProcess {
  readonly identity: SandboxCommandIdentity;
  readonly ready: Promise<SandboxCommandReady>;
  readonly completion: Promise<SandboxCommandExit>;
  onEvent(
    listener: (event: SandboxCommandEvent) => void,
  ): SandboxCommandDisposable;
  write(data: string): boolean;
  resize(dimensions: TerminalDimensions): boolean;
  interrupt(): boolean;
  terminate(): boolean;
  dispose(): void;
}

export interface SandboxRuntimeProvider {
  launch(request: SandboxHelperLaunchRequest): SandboxCommandProcess;
  dispose(): void;
}
