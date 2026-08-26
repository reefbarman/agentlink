import type {
  SandboxCommandIdentity,
  SandboxHelperLaunchRequest,
  SandboxManagedNetworkDestination,
  SandboxPreCommandFailureDetails,
} from "./sandboxHelperProtocol.js";

import type { SandboxViolation } from "../../core/sandboxPolicy.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";

export class SandboxPreCommandLaunchError extends Error {
  readonly code = "sandbox_environment_too_large" as const;
  readonly details: SandboxPreCommandFailureDetails;

  constructor(message: string, details: SandboxPreCommandFailureDetails) {
    super(message);
    this.name = "SandboxPreCommandLaunchError";
    this.details = details;
  }
}

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
  | { type: "violation"; violation: SandboxViolation }
  | { type: "network-request"; request: SandboxManagedNetworkDestination };

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
  respondToNetworkRequest?(
    requestId: string,
    decision: "allow-once" | "reject",
  ): boolean;
  terminate(): boolean;
  dispose(): void;
}

export interface SandboxRuntimeProvider {
  launch(request: SandboxHelperLaunchRequest): SandboxCommandProcess;
  dispose(): void;
}
