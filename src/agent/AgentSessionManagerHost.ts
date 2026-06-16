import * as vscode from "vscode";

import { ActivityTraceRecorder } from "./ActivityTraceRecorder.js";
import type { ActivityTraceRecorderOptions } from "./ActivityTraceRecorder.js";
import { AgentEngine } from "./AgentEngine.js";
import { AgentSession } from "./AgentSession.js";
import {
  CheckpointManager,
  type Checkpoint,
  type RevertPreview,
} from "./CheckpointManager.js";
import {
  getConfiguredBaseThresholdForModel,
  getEffectiveAutoCondenseThreshold,
} from "./modelCondenseThresholds.js";
import { resolveModelForMode } from "./modeModelPreferences.js";
import { providerRegistry, type ProviderRegistry } from "./providers/index.js";
import type { WorkspaceFolderInfo } from "./systemPrompt.js";
import {
  createAgentToolRuntime,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import type { SessionStore } from "./SessionStore.js";
import type { AgentToolRuntime } from "../core/tools/types.js";
import { createVscodeSemanticSearchProvider } from "../adapters/vscode/readSearchCapabilities.js";
import type { AgentEvent } from "./types.js";

export interface AgentWorkspaceHost {
  getWorkspaceFolders(): WorkspaceFolderInfo[];
}

export type BgSummaryMode = "agent" | "openai" | "heuristic";

export interface AgentSessionConfigHost {
  getCondenseThresholdForModel(model: string): number;
  resolveModelForMode(mode: string, fallbackModel: string): string;
  getBgSummaryMode(): BgSummaryMode;
}

export interface CheckpointManagerLike {
  readonly baseCommit: string | null;
  initialize(): Promise<unknown>;
  createCheckpoint(turnIndex: number): Promise<Checkpoint | null>;
  previewRevert(checkpoint: Checkpoint): Promise<RevertPreview | null>;
  revertToCheckpoint(checkpoint: Checkpoint): Promise<boolean>;
  getDiffBetween(fromHash: string, toHash: string): Promise<string>;
}

export interface ActivityTraceRecorderLike {
  appendAgentEvent(
    sessionId: string,
    event: AgentEvent,
    source: "foreground_agent" | "background_agent",
  ): void;
}

export interface TimerHost {
  setInterval(
    handler: () => void,
    timeoutMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setTimeout(
    handler: () => void,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface CheckpointManagerOptions {
  workspaceDir: string;
  taskId: string;
  log?: (msg: string) => void;
}

export interface AgentSessionManagerHost {
  workspace: AgentWorkspaceHost;
  config: AgentSessionConfigHost;
  providers: ProviderRegistry;
  createEngine: (
    registry: ProviderRegistry,
    log?: (msg: string) => void,
  ) => AgentEngine;
  createSession: typeof AgentSession.create;
  createCheckpointManager: (
    opts: CheckpointManagerOptions,
  ) => CheckpointManagerLike;
  createActivityTraceRecorder: (
    opts: ActivityTraceRecorderOptions,
  ) => ActivityTraceRecorderLike;
  createToolRuntime: (ctx: ToolDispatchContext) => AgentToolRuntime;
  persistence?: SessionStore;
  timers: TimerHost;
}

export interface AgentSessionManagerOptions {
  host?: Partial<AgentSessionManagerHost>;
}

export function createDefaultAgentSessionManagerHost(args: {
  cwd: string;
  log?: (msg: string) => void;
  store?: SessionStore;
}): AgentSessionManagerHost {
  return {
    workspace: {
      getWorkspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          name: folder.name,
          path: folder.uri.fsPath,
        })),
    },
    config: {
      getCondenseThresholdForModel: (model) =>
        getConfiguredBaseThresholdForModel(
          vscode.workspace.getConfiguration("agentlink"),
          model,
        ) ?? getEffectiveAutoCondenseThreshold(model),
      resolveModelForMode: (mode, fallbackModel) =>
        resolveModelForMode(
          vscode.workspace.getConfiguration("agentlink"),
          mode,
          fallbackModel,
        ),
      getBgSummaryMode: () => {
        const value = vscode.workspace
          .getConfiguration("agentlink")
          .get<string>("bgSummary.mode", "agent");
        if (value === "agent" || value === "openai" || value === "heuristic") {
          return value;
        }
        return "agent";
      },
    },
    providers: providerRegistry,
    createEngine: (registry, log) => new AgentEngine(registry, log),
    createSession: (opts) => AgentSession.create(opts),
    createCheckpointManager: (opts) => new CheckpointManager(opts),
    createActivityTraceRecorder: (opts) => new ActivityTraceRecorder(opts),
    createToolRuntime: (ctx) =>
      createAgentToolRuntime({
        ...ctx,
        semanticSearchProvider:
          ctx.semanticSearchProvider ?? createVscodeSemanticSearchProvider(),
      }),
    persistence: args.store,
    timers: {
      setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
      clearInterval: (timer) => clearInterval(timer),
      setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  };
}

export function mergeAgentSessionManagerHost(
  base: AgentSessionManagerHost,
  overrides?: Partial<AgentSessionManagerHost>,
): AgentSessionManagerHost {
  return {
    ...base,
    ...overrides,
    workspace: overrides?.workspace ?? base.workspace,
    config: overrides?.config ?? base.config,
    providers: overrides?.providers ?? base.providers,
    createEngine: overrides?.createEngine ?? base.createEngine,
    createSession: overrides?.createSession ?? base.createSession,
    createCheckpointManager:
      overrides?.createCheckpointManager ?? base.createCheckpointManager,
    createActivityTraceRecorder:
      overrides?.createActivityTraceRecorder ??
      base.createActivityTraceRecorder,
    createToolRuntime: overrides?.createToolRuntime ?? base.createToolRuntime,
    persistence:
      overrides && "persistence" in overrides
        ? overrides.persistence
        : base.persistence,
    timers: overrides?.timers ?? base.timers,
  };
}
