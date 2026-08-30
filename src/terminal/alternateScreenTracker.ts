import type { AlternateScreenTransition } from "@agentlink/protocol/terminal-surface";

export type { AlternateScreenTransition } from "@agentlink/protocol/terminal-surface";

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);
const MAX_CSI_PARAMETER_BYTES = 128;

export interface AlternateScreenScanResult {
  readonly data: string;
  readonly alternateScreen: boolean;
  readonly transitions: readonly AlternateScreenTransition[];
}

export interface AlternateScreenTransitionBoundary {
  /** UTF-16 offset immediately after the control sequence that changed modes. */
  readonly offset: number;
  readonly transition: AlternateScreenTransition;
}

export interface AlternateScreenReplaySegment {
  readonly data: string;
  /** Plain ground-state text may be trimmed at any UTF-8 character boundary. */
  readonly splittable: boolean;
  /** Whether the parser returned to ground at the end of this segment. */
  readonly endsAtGround: boolean;
}

export interface AlternateScreenDetailedScanResult extends AlternateScreenScanResult {
  readonly transitionBoundaries: readonly AlternateScreenTransitionBoundary[];
  readonly replaySegments: readonly AlternateScreenReplaySegment[];
}

export interface AlternateScreenTracker {
  readonly alternateScreen: boolean;
  readonly atGround: boolean;
  push(data: string): AlternateScreenScanResult;
  scan(data: string): AlternateScreenDetailedScanResult;
  reset(): void;
}

type ParserState =
  | "ground"
  | "escape"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isStringControl(code: number): boolean {
  return code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function parseAlternateScreenModes(parameters: string): number[] {
  if (!parameters.startsWith("?")) return [];
  const values = parameters.slice(1).split(";");
  if (values.some((value) => value !== "" && !/^(?:0|[1-9]\d*)$/.test(value))) {
    return [];
  }
  return [
    ...new Set(
      values
        .map((value) => (value === "" ? 0 : Number(value)))
        .filter((value) => ALTERNATE_SCREEN_MODES.has(value)),
    ),
  ];
}

class StreamingAlternateScreenTracker implements AlternateScreenTracker {
  private state: ParserState = "ground";
  private csiParameters = "";
  private csiOverflow = false;
  private readonly activeModes = new Set<number>();

  get alternateScreen(): boolean {
    return this.activeModes.size > 0;
  }

  get atGround(): boolean {
    return this.state === "ground";
  }

  push(data: string): AlternateScreenScanResult {
    const result = this.scan(data);
    return {
      data: result.data,
      alternateScreen: result.alternateScreen,
      transitions: result.transitions,
    };
  }

  scan(data: string): AlternateScreenDetailedScanResult {
    const transitions: AlternateScreenTransition[] = [];
    const transitionBoundaries: AlternateScreenTransitionBoundary[] = [];
    const replaySegments: AlternateScreenReplaySegment[] = [];
    let segmentStart = 0;
    let segmentSplittable: boolean | undefined;
    let previousEndsAtGround = this.atGround;

    const flushReplaySegment = (end: number): void => {
      if (segmentSplittable === undefined || end <= segmentStart) return;
      replaySegments.push({
        data: data.slice(segmentStart, end),
        splittable: segmentSplittable,
        endsAtGround: previousEndsAtGround,
      });
      segmentStart = end;
    };

    for (let index = 0; index < data.length; index += 1) {
      const wasAtGround = this.atGround;
      const code = data.charCodeAt(index);
      const character = data[index];

      if (this.state === "osc") {
        if (code === 0x07 || code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "osc-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        }
      } else if (this.state === "osc-escape") {
        if (character === "\\" || code === 0x07 || code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "osc-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else {
          this.state = "osc";
        }
      } else if (this.state === "string") {
        if (code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        }
      } else if (this.state === "string-escape") {
        if (character === "\\" || code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else {
          this.state = "string";
        }
      } else if (this.state === "escape") {
        if (character === "[") {
          this.startCsi();
        } else if (character === "]") {
          this.state = "osc";
        } else if (isStringControl(code)) {
          this.state = "string";
        } else if (code === 0x1b) {
          this.state = "escape";
        } else {
          this.state = "ground";
        }
      } else if (this.state === "csi") {
        if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "escape";
        } else if (isCsiFinal(code)) {
          if (!this.csiOverflow && (character === "h" || character === "l")) {
            const modes = parseAlternateScreenModes(this.csiParameters);
            if (modes.length > 0) {
              const wasActive = this.activeModes.size > 0;
              if (character === "h") {
                for (const mode of modes) this.activeModes.add(mode);
              } else {
                for (const mode of modes) this.activeModes.delete(mode);
              }
              const active = this.activeModes.size > 0;
              if (active !== wasActive) {
                const transition: AlternateScreenTransition = {
                  type: active ? "enter" : "exit",
                  modes,
                };
                transitions.push(transition);
                transitionBoundaries.push({
                  offset: index + 1,
                  transition,
                });
              }
            }
          }
          this.state = "ground";
        } else if (!this.csiOverflow) {
          this.csiParameters += character;
          if (this.csiParameters.length > MAX_CSI_PARAMETER_BYTES) {
            this.csiOverflow = true;
            this.csiParameters = "";
          }
        }
      } else if (code === 0x1b) {
        this.state = "escape";
      } else if (code === 0x9b) {
        this.startCsi();
      } else if (code === 0x9d) {
        this.state = "osc";
      } else if (
        code === 0x90 ||
        code === 0x98 ||
        code === 0x9e ||
        code === 0x9f
      ) {
        this.state = "string";
      }

      const endsAtGround = this.atGround;
      const splittable = wasAtGround && endsAtGround;
      if (segmentSplittable !== undefined && splittable !== segmentSplittable) {
        flushReplaySegment(index);
      }
      segmentSplittable = splittable;
      previousEndsAtGround = endsAtGround;
    }
    flushReplaySegment(data.length);

    return {
      data,
      alternateScreen: this.alternateScreen,
      transitions,
      transitionBoundaries,
      replaySegments,
    };
  }

  reset(): void {
    this.state = "ground";
    this.csiParameters = "";
    this.csiOverflow = false;
    this.activeModes.clear();
  }

  private startCsi(): void {
    this.state = "csi";
    this.csiParameters = "";
    this.csiOverflow = false;
  }
}

export function createAlternateScreenTracker(): AlternateScreenTracker {
  return new StreamingAlternateScreenTracker();
}
