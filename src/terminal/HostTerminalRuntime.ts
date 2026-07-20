import { Buffer } from "node:buffer";

import {
  createAlternateScreenTracker,
  type AlternateScreenTracker,
} from "./alternateScreenTracker.js";
import {
  createHostTerminalBlockState,
  reduceHostTerminalBlocks,
  type HostTerminalBlock,
  type HostTerminalBlockState,
  type HostTerminalBlockStateOptions,
} from "./hostTerminalBlocks.js";
import {
  createHostTerminalPresentationState,
  isHostTerminalUserActionAllowed,
  reduceHostTerminalPresentation,
  type HostTerminalPresentationState,
} from "./hostTerminalPresentation.js";
import type {
  ShellIntegrationEvent,
  ShellIntegrationParseResult,
  ShellIntegrationParser,
  ShellIntegrationSegment,
} from "./shellIntegration.js";
import {
  createTerminalOutputFilter,
  type TerminalOutputFilter,
} from "./terminalOutputFilter.js";
import { terminalTextToPlainText } from "./terminalPlainText.js";
import {
  MAX_TERMINAL_INPUT_BYTES,
  type HostTerminalBlockBoundary,
  type HostTerminalRenderBatch,
  type HostTerminalRenderOperation,
  type HostTerminalReplaySnapshot,
  type HostTerminalSurfaceAction,
  type HostTerminalSurfaceBlockPresentation,
  type HostTerminalSurfacePresentation,
} from "./terminalSurfaceProtocol.js";

const DEFAULT_MAX_RENDER_REPLAY_BYTES = 1024 * 1024;
const DEFAULT_RENDER_HIGH_WATER_BYTES = 256 * 1024;
const DEFAULT_RENDER_LOW_WATER_BYTES = 128 * 1024;
const MAX_COPY_TEXT_BYTES = 256 * 1024;
const PHASE_1_ACTIONS = new Set<HostTerminalSurfaceAction>([
  "rerun-command",
  "interrupt-command",
]);

export interface HostTerminalRuntimeOptions {
  terminalId: string;
  terminalInstanceId: string;
  parser: ShellIntegrationParser;
  initialCwd: string;
  outputFilter?: TerminalOutputFilter;
  alternateScreenTracker?: AlternateScreenTracker;
  maxRenderReplayBytes?: number;
  renderHighWaterBytes?: number;
  renderLowWaterBytes?: number;
  blockStateOptions?: Omit<HostTerminalBlockStateOptions, "initialCwd">;
}

export interface HostTerminalRuntimeUpdate {
  batch?: HostTerminalRenderBatch;
  /** Deliver this batch first. False then tells the PTY listener to pause before
   * any later output; dropping this batch would create a render gap. */
  continueOutput: boolean;
}

export interface HostTerminalRuntimeDelivery {
  accepted: boolean;
  shouldPause: boolean;
}

export interface HostTerminalRuntimeDeliveryFailure {
  accepted: boolean;
  shouldResume: boolean;
}

export interface HostTerminalRuntimeAcknowledgment {
  accepted: boolean;
  shouldResume: boolean;
}

export type HostTerminalActionAuthorization =
  | {
      authorized: false;
      reason?: "copy-output-truncated" | "copy-text-too-large";
    }
  | {
      authorized: true;
      action: "copy-command" | "copy-output" | "copy-command-and-output";
      clipboardText: string;
    }
  | {
      authorized: true;
      action: "rerun-command";
      command: string;
    }
  | { authorized: true; action: "interrupt-command"; data: "\x03" };

interface ReplayUnit {
  data: string;
  byteLength: number;
  splittable: boolean;
}

interface RenderReplayState {
  units: ReplayUnit[];
  byteLength: number;
  droppedBytes: number;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function trimUtf8Prefix(data: string, bytesToDrop: number): string {
  const buffer = Buffer.from(data, "utf8");
  let start = Math.min(bytesToDrop, buffer.byteLength);
  while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function boundaryFor(
  event: ShellIntegrationEvent,
): HostTerminalBlockBoundary | null {
  return event.type === "cwd" ? null : event.type;
}

export class HostTerminalRuntime {
  private readonly terminalId: string;
  private readonly terminalInstanceId: string;
  private readonly parser: ShellIntegrationParser;
  private readonly outputFilter: TerminalOutputFilter;
  private readonly alternateScreenTracker: AlternateScreenTracker;
  private readonly maxRenderReplayBytes: number;
  private readonly renderHighWaterBytes: number;
  private readonly renderLowWaterBytes: number;
  private readonly unacknowledgedWrites = new Map<number, number>();
  private readonly batchWriteBytes = new Map<number, number>();
  private blocks: HostTerminalBlockState;
  private presentation: HostTerminalPresentationState;
  private replay: RenderReplayState = {
    units: [],
    byteLength: 0,
    droppedBytes: 0,
  };
  private replayControlPending = "";
  private replayControlPendingBytes = 0;
  private replayControlOverflow = false;
  private nextSequence = 1;
  private lastDeliveredSequence = 0;
  private lastAcknowledgedSequence = 0;
  private unacknowledgedBytes = 0;
  private rendererEpoch: string | undefined;
  private backpressured = false;
  private promptPristine = false;
  private activityRevision = 0;
  private finished = false;

  constructor(options: HostTerminalRuntimeOptions) {
    if (!options.terminalId || options.terminalId.includes("\0")) {
      throw new Error("terminalId must be a non-empty string without NUL");
    }
    if (
      !options.terminalInstanceId ||
      options.terminalInstanceId.includes("\0")
    ) {
      throw new Error(
        "terminalInstanceId must be a non-empty string without NUL",
      );
    }
    const maxRenderReplayBytes =
      options.maxRenderReplayBytes ?? DEFAULT_MAX_RENDER_REPLAY_BYTES;
    const renderHighWaterBytes =
      options.renderHighWaterBytes ?? DEFAULT_RENDER_HIGH_WATER_BYTES;
    const renderLowWaterBytes =
      options.renderLowWaterBytes ?? DEFAULT_RENDER_LOW_WATER_BYTES;
    assertPositiveSafeInteger(maxRenderReplayBytes, "maxRenderReplayBytes");
    assertPositiveSafeInteger(renderHighWaterBytes, "renderHighWaterBytes");
    assertPositiveSafeInteger(renderLowWaterBytes, "renderLowWaterBytes");
    if (renderLowWaterBytes >= renderHighWaterBytes) {
      throw new Error(
        "renderLowWaterBytes must be less than renderHighWaterBytes",
      );
    }

    this.terminalId = options.terminalId;
    this.terminalInstanceId = options.terminalInstanceId;
    this.parser = options.parser;
    this.outputFilter = options.outputFilter ?? createTerminalOutputFilter();
    this.alternateScreenTracker =
      options.alternateScreenTracker ?? createAlternateScreenTracker();
    this.maxRenderReplayBytes = maxRenderReplayBytes;
    this.renderHighWaterBytes = renderHighWaterBytes;
    this.renderLowWaterBytes = renderLowWaterBytes;
    this.blocks = createHostTerminalBlockState({
      initialCwd: options.initialCwd,
      ...options.blockStateOptions,
    });
    this.presentation = createHostTerminalPresentationState(this.blocks);
  }

  attachRenderer(rendererEpoch: string): HostTerminalReplaySnapshot {
    if (!rendererEpoch || rendererEpoch.includes("\0")) {
      throw new Error("rendererEpoch must be a non-empty string without NUL");
    }
    if (
      this.rendererEpoch !== undefined &&
      this.rendererEpoch !== rendererEpoch
    ) {
      throw new Error("A different terminal renderer is already attached");
    }
    if (this.rendererEpoch === undefined) {
      this.rendererEpoch = rendererEpoch;
      this.clearDeliveryAccounting();
    }
    return this.snapshot();
  }

  detachRenderer(
    terminalInstanceId: string,
    rendererEpoch: string,
  ): HostTerminalRuntimeAcknowledgment {
    if (
      terminalInstanceId !== this.terminalInstanceId ||
      rendererEpoch !== this.rendererEpoch
    ) {
      return { accepted: false, shouldResume: false };
    }
    const shouldResume = this.backpressured;
    this.rendererEpoch = undefined;
    this.clearDeliveryAccounting();
    return { accepted: true, shouldResume };
  }

  processData(data: string): HostTerminalRuntimeUpdate {
    if (this.finished) return { continueOutput: true };
    if (data) this.activityRevision += 1;
    return this.processParseResult(this.parser.push(data));
  }

  resetProcessBoundary(): HostTerminalRuntimeUpdate {
    if (this.finished) return { continueOutput: true };
    this.parser.finish();
    this.outputFilter.finish();
    if (this.replayControlPendingBytes > 0) {
      this.replay.droppedBytes += this.replayControlPendingBytes;
      this.clearPendingReplayControl();
    }
    const wasAlternateScreen = this.alternateScreenTracker.alternateScreen;
    this.alternateScreenTracker.reset();
    this.activityRevision += 1;
    if (!wasAlternateScreen) return { continueOutput: !this.backpressured };

    const transition = { type: "exit" as const, modes: [1049] };
    this.presentation = reduceHostTerminalPresentation(this.presentation, {
      type: "alternate-screen",
      transition,
    });
    const operations: HostTerminalRenderOperation[] = [
      { type: "write", data: "\x1b[?1049l" },
      { type: "alternate-screen", transition },
      this.presentationOperation(),
    ];
    this.appendReplayUnit("\x1b[?1049l", false);
    return this.createUpdate(
      operations,
      [],
      0,
      Buffer.byteLength("\x1b[?1049l", "utf8"),
    );
  }

  noteUserInput(terminalInstanceId: string): boolean {
    if (terminalInstanceId !== this.terminalInstanceId) return false;
    this.activityRevision += 1;
    this.promptPristine = false;
    return true;
  }

  finish(): HostTerminalRuntimeUpdate {
    if (this.finished) return { continueOutput: true };
    const parsed = this.parser.finish();
    const operations: HostTerminalRenderOperation[] = [];
    const decisions: HostTerminalRenderBatch["outputPolicyDecisions"][number][] =
      [];
    let suppressedOutputCharacters = 0;
    let writtenBytes = 0;
    const initialPresentation = this.presentation;

    ({ suppressedOutputCharacters, writtenBytes } = this.processSegments(
      parsed.segments,
      operations,
      decisions,
      suppressedOutputCharacters,
      writtenBytes,
    ));
    const filtered = this.outputFilter.finish();
    decisions.push(...filtered.decisions);
    suppressedOutputCharacters += filtered.suppressedCharacters;
    writtenBytes += this.processRenderableData(filtered.data, operations);
    if (this.replayControlPendingBytes > 0) {
      this.replay.droppedBytes += this.replayControlPendingBytes;
      this.clearPendingReplayControl();
    }
    this.presentation = reduceHostTerminalPresentation(this.presentation, {
      type: "terminal-exited",
    });
    this.activityRevision += 1;
    this.promptPristine = false;
    this.finished = true;
    if (this.presentation !== initialPresentation) {
      operations.push(this.presentationOperation());
    }
    return this.createUpdate(
      operations,
      decisions,
      suppressedOutputCharacters,
      writtenBytes,
    );
  }

  markBatchDelivered(
    terminalInstanceId: string,
    rendererEpoch: string,
    sequence: number,
  ): HostTerminalRuntimeDelivery {
    if (
      terminalInstanceId !== this.terminalInstanceId ||
      rendererEpoch !== this.rendererEpoch ||
      !Number.isSafeInteger(sequence) ||
      sequence !== this.lastDeliveredSequence + 1 ||
      sequence >= this.nextSequence ||
      this.unacknowledgedWrites.has(sequence)
    ) {
      return { accepted: false, shouldPause: false };
    }
    const bytes = this.batchWriteBytes.get(sequence);
    if (bytes === undefined) return { accepted: false, shouldPause: false };
    this.batchWriteBytes.delete(sequence);
    this.lastDeliveredSequence = sequence;
    this.unacknowledgedWrites.set(sequence, bytes);
    this.unacknowledgedBytes += bytes;
    const shouldPause =
      !this.backpressured &&
      this.unacknowledgedBytes >= this.renderHighWaterBytes;
    if (shouldPause) this.backpressured = true;
    return { accepted: true, shouldPause };
  }

  markBatchDeliveryFailed(
    terminalInstanceId: string,
    rendererEpoch: string,
    sequence: number,
  ): HostTerminalRuntimeDeliveryFailure {
    if (
      terminalInstanceId !== this.terminalInstanceId ||
      rendererEpoch !== this.rendererEpoch ||
      !Number.isSafeInteger(sequence) ||
      sequence <= this.lastAcknowledgedSequence ||
      sequence >= this.nextSequence
    ) {
      return { accepted: false, shouldResume: false };
    }
    this.batchWriteBytes.delete(sequence);
    const shouldResume = this.backpressured;
    this.rendererEpoch = undefined;
    this.clearDeliveryAccounting();
    return { accepted: true, shouldResume };
  }

  acknowledge(
    terminalInstanceId: string,
    rendererEpoch: string,
    sequence: number,
  ): HostTerminalRuntimeAcknowledgment {
    if (
      terminalInstanceId !== this.terminalInstanceId ||
      rendererEpoch !== this.rendererEpoch ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      sequence > this.lastDeliveredSequence
    ) {
      return { accepted: false, shouldResume: false };
    }
    if (sequence <= this.lastAcknowledgedSequence) {
      return { accepted: true, shouldResume: false };
    }
    for (const [candidate, bytes] of this.unacknowledgedWrites) {
      if (candidate > sequence) continue;
      this.unacknowledgedWrites.delete(candidate);
      this.unacknowledgedBytes -= bytes;
    }
    this.lastAcknowledgedSequence = sequence;
    const shouldResume =
      this.backpressured &&
      this.unacknowledgedBytes <= this.renderLowWaterBytes;
    if (shouldResume) this.backpressured = false;
    return { accepted: true, shouldResume };
  }

  get currentCwd(): string {
    return this.blocks.currentCwd;
  }

  get terminalRunning(): boolean {
    return this.presentation.terminalRunning;
  }

  get closeRequiresConfirmation(): boolean {
    if (!this.presentation.terminalRunning) return false;
    return (
      this.presentation.alternateScreen ||
      this.blocks.mode !== "integrated" ||
      this.blocks.activeCommandBlockId !== undefined
    );
  }

  get interactionStateKey(): string {
    return [
      this.presentation.terminalRunning ? "running" : "exited",
      this.presentation.alternateScreen ? "alternate" : "primary",
      this.blocks.mode,
      this.blocks.activeCommandBlockId ?? "no-command",
      this.blocks.activePromptBlockId ?? "no-prompt",
      this.activityRevision,
    ].join(":");
  }

  snapshot(): HostTerminalReplaySnapshot {
    return {
      terminalId: this.terminalId,
      terminalInstanceId: this.terminalInstanceId,
      sequence: this.nextSequence - 1,
      data: this.replay.units.map((unit) => unit.data).join(""),
      byteLength: this.replay.byteLength,
      droppedBytes: this.replay.droppedBytes,
      replayTruncated: this.replay.droppedBytes > 0,
      replayPendingControl: this.replayControlPendingBytes > 0,
      blocks: this.blocks,
      presentation: this.surfacePresentation(),
    };
  }

  getBlock(blockId: string): HostTerminalBlock | undefined {
    return this.blocks.blocks.find((block) => block.id === blockId);
  }

  isActionAllowed(
    terminalInstanceId: string,
    blockId: string,
    action: HostTerminalSurfaceAction,
  ): boolean {
    if (
      terminalInstanceId !== this.terminalInstanceId ||
      !isHostTerminalUserActionAllowed(this.presentation, blockId, action)
    ) {
      return false;
    }
    return action !== "rerun-command" || this.promptPristine;
  }

  authorizeAction(
    terminalInstanceId: string,
    blockId: string,
    action: HostTerminalSurfaceAction,
  ): HostTerminalActionAuthorization {
    if (!this.isActionAllowed(terminalInstanceId, blockId, action)) {
      return { authorized: false };
    }
    const block = this.getBlock(blockId);
    if (!block) return { authorized: false };

    if (action === "copy-output") {
      return this.authorizeCopy(action, block.output, block.droppedOutputBytes);
    }
    if (block.kind !== "command") return { authorized: false };
    if (action === "copy-command") {
      return this.authorizeCopy(action, block.command, 0);
    }
    if (action === "copy-command-and-output") {
      // Shell integration accepts command metadata only from one complete,
      // bounded nonce-scoped frame, so command text is never a retained tail.
      return this.authorizeCopy(
        action,
        `${block.command}\n${block.output}`,
        block.droppedOutputBytes,
      );
    }
    if (action === "rerun-command") {
      if (
        !block.command ||
        Buffer.byteLength(`${block.command}\r`, "utf8") >
          MAX_TERMINAL_INPUT_BYTES
      ) {
        return { authorized: false };
      }
      this.promptPristine = false;
      return { authorized: true, action, command: block.command };
    }
    return { authorized: true, action, data: "\x03" };
  }

  private authorizeCopy(
    action: "copy-command" | "copy-output" | "copy-command-and-output",
    value: string,
    droppedOutputBytes: number,
  ): HostTerminalActionAuthorization {
    if (droppedOutputBytes > 0) {
      return { authorized: false, reason: "copy-output-truncated" };
    }
    const clipboardText = terminalTextToPlainText(value);
    if (!clipboardText) return { authorized: false };
    if (Buffer.byteLength(clipboardText, "utf8") > MAX_COPY_TEXT_BYTES) {
      return { authorized: false, reason: "copy-text-too-large" };
    }
    return { authorized: true, action, clipboardText };
  }

  private processParseResult(
    result: ShellIntegrationParseResult,
  ): HostTerminalRuntimeUpdate {
    const operations: HostTerminalRenderOperation[] = [];
    const decisions: HostTerminalRenderBatch["outputPolicyDecisions"][number][] =
      [];
    const initialPresentation = this.presentation;
    const processed = this.processSegments(
      result.segments,
      operations,
      decisions,
      0,
      0,
    );
    if (this.presentation !== initialPresentation) {
      operations.push(this.presentationOperation());
    }
    return this.createUpdate(
      operations,
      decisions,
      processed.suppressedOutputCharacters,
      processed.writtenBytes,
    );
  }

  private processSegments(
    segments: readonly ShellIntegrationSegment[],
    operations: HostTerminalRenderOperation[],
    decisions: HostTerminalRenderBatch["outputPolicyDecisions"][number][],
    suppressedOutputCharacters: number,
    writtenBytes: number,
  ): { suppressedOutputCharacters: number; writtenBytes: number } {
    for (const segment of segments) {
      if (segment.type === "data") {
        const filtered = this.outputFilter.push(segment.data);
        decisions.push(...filtered.decisions);
        suppressedOutputCharacters += filtered.suppressedCharacters;
        writtenBytes += this.processRenderableData(filtered.data, operations);
        continue;
      }

      const previousBlocks = this.blocks;
      this.blocks = reduceHostTerminalBlocks(this.blocks, {
        type: "shell-event",
        event: segment.event,
      });
      if (
        segment.event.type === "prompt-start" &&
        this.blocks.activePromptBlockId !== previousBlocks.activePromptBlockId
      ) {
        this.promptPristine = true;
      }
      if (
        segment.event.type === "prompt-end" ||
        segment.event.type === "command-start"
      ) {
        this.promptPristine = false;
      }
      this.presentation = reduceHostTerminalPresentation(this.presentation, {
        type: "blocks-changed",
        state: this.blocks,
      });
      const boundary = boundaryFor(segment.event);
      const blockId = this.blockIdForBoundary(
        segment.event,
        previousBlocks,
        this.blocks,
      );
      if (boundary && blockId) {
        operations.push({ type: "block-boundary", boundary, blockId });
      }
    }
    return { suppressedOutputCharacters, writtenBytes };
  }

  private processRenderableData(
    data: string,
    operations: HostTerminalRenderOperation[],
  ): number {
    if (!data) return 0;
    this.blocks = reduceHostTerminalBlocks(this.blocks, { type: "data", data });
    this.presentation = reduceHostTerminalPresentation(this.presentation, {
      type: "blocks-changed",
      state: this.blocks,
    });

    let pendingWrite = "";
    for (const character of data) {
      pendingWrite += character;
      const wasAtGround = this.alternateScreenTracker.atGround;
      const tracked = this.alternateScreenTracker.push(character);
      const isAtGround = this.alternateScreenTracker.atGround;
      this.appendReplayCharacter(character, wasAtGround, isAtGround);
      if (tracked.transitions.length === 0) continue;
      operations.push({ type: "write", data: pendingWrite });
      pendingWrite = "";
      for (const transition of tracked.transitions) {
        this.presentation = reduceHostTerminalPresentation(this.presentation, {
          type: "alternate-screen",
          transition,
        });
        operations.push({ type: "alternate-screen", transition });
      }
    }
    if (pendingWrite) operations.push({ type: "write", data: pendingWrite });
    return Buffer.byteLength(data, "utf8");
  }

  private appendReplayCharacter(
    character: string,
    wasAtGround: boolean,
    isAtGround: boolean,
  ): void {
    if (wasAtGround && isAtGround) {
      this.appendReplayUnit(character, true);
      return;
    }
    const characterBytes = Buffer.byteLength(character, "utf8");
    this.replayControlPendingBytes += characterBytes;
    if (!this.replayControlOverflow) {
      if (this.replayControlPendingBytes <= this.maxRenderReplayBytes) {
        this.replayControlPending += character;
      } else {
        this.replayControlPending = "";
        this.replayControlOverflow = true;
      }
    }
    if (isAtGround) {
      if (this.replayControlOverflow) {
        this.replay.droppedBytes += this.replayControlPendingBytes;
      } else {
        this.appendReplayUnit(this.replayControlPending, false);
      }
      this.clearPendingReplayControl();
    }
  }

  private appendReplayUnit(data: string, splittable: boolean): void {
    const byteLength = Buffer.byteLength(data, "utf8");
    const last = this.replay.units.at(-1);
    if (splittable && last?.splittable) {
      last.data += data;
      last.byteLength += byteLength;
    } else {
      this.replay.units.push({ data, byteLength, splittable });
    }
    this.replay.byteLength += byteLength;

    while (this.replay.byteLength > this.maxRenderReplayBytes) {
      const first = this.replay.units[0];
      if (!first) break;
      const excess = this.replay.byteLength - this.maxRenderReplayBytes;
      if (!first.splittable || first.byteLength <= excess) {
        this.replay.units.shift();
        this.replay.byteLength -= first.byteLength;
        this.replay.droppedBytes += first.byteLength;
        continue;
      }
      const retained = trimUtf8Prefix(first.data, excess);
      const retainedBytes = Buffer.byteLength(retained, "utf8");
      const dropped = first.byteLength - retainedBytes;
      first.data = retained;
      first.byteLength = retainedBytes;
      this.replay.byteLength -= dropped;
      this.replay.droppedBytes += dropped;
    }
  }

  private blockIdForBoundary(
    event: ShellIntegrationEvent,
    previous: HostTerminalBlockState,
    next: HostTerminalBlockState,
  ): string | undefined {
    if (event.type === "prompt-start") return next.activePromptBlockId;
    if (event.type === "prompt-end") return previous.activePromptBlockId;
    if (event.type === "command-start") return next.activeCommandBlockId;
    if (event.type === "command-end") return previous.activeCommandBlockId;
    return undefined;
  }

  private surfaceBlocks(): HostTerminalSurfaceBlockPresentation[] {
    return this.presentation.blocks.map((block) => {
      const source = this.getBlock(block.blockId);
      const completeOutput = source?.droppedOutputBytes === 0;
      return {
        blockId: block.blockId,
        decoration: block.decoration,
        actions: block.actions.filter(
          (action): action is HostTerminalSurfaceAction =>
            PHASE_1_ACTIONS.has(action as HostTerminalSurfaceAction) &&
            (action !== "rerun-command" ||
              (this.promptPristine &&
                source?.kind === "command" &&
                source.command.length > 0 &&
                Buffer.byteLength(`${source.command}\r`, "utf8") <=
                  MAX_TERMINAL_INPUT_BYTES)) &&
            (completeOutput ||
              (action !== "copy-output" &&
                action !== "copy-command-and-output")),
        ),
      };
    });
  }

  private surfacePresentation(): HostTerminalSurfacePresentation {
    return {
      alternateScreen: this.presentation.alternateScreen,
      terminalRunning: this.presentation.terminalRunning,
      blocks: this.surfaceBlocks(),
    };
  }

  private presentationOperation(): HostTerminalRenderOperation {
    return {
      type: "presentation",
      alternateScreen: this.presentation.alternateScreen,
      blocks: this.surfaceBlocks(),
    };
  }

  private createUpdate(
    operations: HostTerminalRenderOperation[],
    decisions: HostTerminalRenderBatch["outputPolicyDecisions"][number][],
    suppressedOutputCharacters: number,
    writtenBytes: number,
  ): HostTerminalRuntimeUpdate {
    if (
      operations.length === 0 &&
      decisions.length === 0 &&
      suppressedOutputCharacters === 0
    ) {
      return { continueOutput: !this.backpressured };
    }
    const sequence = this.nextSequence++;
    const batch: HostTerminalRenderBatch = {
      type: "terminal-view/render-batch",
      terminalId: this.terminalId,
      terminalInstanceId: this.terminalInstanceId,
      sequence,
      operations,
      droppedRenderBytes: this.replay.droppedBytes,
      replayTruncated: this.replay.droppedBytes > 0,
      replayPendingControl: this.replayControlPendingBytes > 0,
      suppressedOutputCharacters,
      outputPolicyDecisions: decisions,
    };
    if (this.rendererEpoch !== undefined) {
      this.batchWriteBytes.set(sequence, writtenBytes);
    }
    return { batch, continueOutput: !this.backpressured };
  }

  private clearPendingReplayControl(): void {
    this.replayControlPending = "";
    this.replayControlPendingBytes = 0;
    this.replayControlOverflow = false;
  }

  private clearDeliveryAccounting(): void {
    this.unacknowledgedWrites.clear();
    this.batchWriteBytes.clear();
    this.unacknowledgedBytes = 0;
    this.lastDeliveredSequence = this.nextSequence - 1;
    this.lastAcknowledgedSequence = this.lastDeliveredSequence;
    this.backpressured = false;
  }
}
