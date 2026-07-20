import {
  evaluateTerminalOsc,
  type TerminalOutputPolicyDecision,
} from "./terminalOutputPolicy.js";

const DEFAULT_MAX_OSC_CHARACTERS = 8_192;

type ParserState =
  | "ground"
  | "escape"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

export interface TerminalOutputFilterResult {
  readonly data: string;
  readonly decisions: readonly TerminalOutputPolicyDecision[];
  readonly suppressedCharacters: number;
}

export interface TerminalOutputFilter {
  push(data: string): TerminalOutputFilterResult;
  finish(): TerminalOutputFilterResult;
  reset(): void;
}

export interface TerminalOutputFilterOptions {
  maxOscCharacters?: number;
}

function isStringControl(code: number): boolean {
  return code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

class StreamingTerminalOutputFilter implements TerminalOutputFilter {
  private readonly maxOscCharacters: number;
  private state: ParserState = "ground";
  private pendingEscape = "";
  private oscFrame = "";
  private oscPayload = "";
  private oscCharacters = 0;
  private oscOverflow = false;
  private suppressedOscCharacters = 0;

  constructor(options: TerminalOutputFilterOptions) {
    const maxOscCharacters =
      options.maxOscCharacters ?? DEFAULT_MAX_OSC_CHARACTERS;
    if (!Number.isSafeInteger(maxOscCharacters) || maxOscCharacters <= 0) {
      throw new Error("maxOscCharacters must be a positive safe integer");
    }
    this.maxOscCharacters = maxOscCharacters;
  }

  push(data: string): TerminalOutputFilterResult {
    let output = "";
    const decisions: TerminalOutputPolicyDecision[] = [];
    let suppressedCharacters = 0;

    const finishOsc = (terminator: string): void => {
      const decision = evaluateTerminalOsc(this.oscPayload, this.oscOverflow);
      decisions.push(decision);
      const frameCharacters = this.oscOverflow
        ? this.suppressedOscCharacters + terminator.length
        : this.oscFrame.length + terminator.length;
      if (decision.recommendedAction === "allow") {
        output += this.oscFrame + terminator;
      } else {
        suppressedCharacters += frameCharacters;
      }
      this.clearOsc();
      this.state = "ground";
    };

    const cancelOsc = (cancel: string): void => {
      if (this.oscOverflow) {
        decisions.push(evaluateTerminalOsc(this.oscPayload, true));
        suppressedCharacters += this.suppressedOscCharacters + cancel.length;
      } else {
        output += this.oscFrame + cancel;
      }
      this.clearOsc();
      this.state = "ground";
    };

    for (let index = 0; index < data.length; index += 1) {
      const character = data[index];
      const code = data.charCodeAt(index);

      if (this.state === "osc") {
        if (code === 0x07 || code === 0x9c) {
          finishOsc(character);
        } else if (code === 0x1b) {
          this.appendOscFrame(character, false);
          this.state = "osc-escape";
        } else if (code === 0x18 || code === 0x1a) {
          cancelOsc(character);
        } else {
          this.appendOscFrame(character, true);
        }
        continue;
      }

      if (this.state === "osc-escape") {
        if (character === "\\" || code === 0x07 || code === 0x9c) {
          finishOsc(character);
        } else if (code === 0x1b) {
          this.appendOscFrame(character, false);
        } else if (code === 0x18 || code === 0x1a) {
          cancelOsc(character);
        } else {
          this.appendOscFrame(character, true);
          this.state = "osc";
        }
        continue;
      }

      if (this.state === "string") {
        output += character;
        if (code === 0x9c || code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-escape";
        }
        continue;
      }

      if (this.state === "string-escape") {
        output += character;
        if (
          character === "\\" ||
          code === 0x9c ||
          code === 0x18 ||
          code === 0x1a
        ) {
          this.state = "ground";
        } else if (code !== 0x1b) {
          this.state = "string";
        }
        continue;
      }

      if (this.state === "escape") {
        const escape = this.pendingEscape;
        this.pendingEscape = "";
        if (character === "]") {
          this.startOsc(`${escape}]`);
        } else if (code === 0x1b) {
          output += escape;
          this.pendingEscape = character;
          this.state = "escape";
        } else if (code === 0x9d) {
          output += escape;
          this.startOsc(character);
        } else {
          output += escape + character;
          this.state = isStringControl(code) ? "string" : "ground";
        }
        continue;
      }

      if (code === 0x1b) {
        this.pendingEscape = character;
        this.state = "escape";
      } else if (code === 0x9d) {
        this.startOsc(character);
      } else {
        output += character;
        if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.state = "string";
        }
      }
    }

    return { data: output, decisions, suppressedCharacters };
  }

  finish(): TerminalOutputFilterResult {
    const incompleteOsc = this.state === "osc" || this.state === "osc-escape";
    const data = incompleteOsc ? "" : this.pendingData();
    const decision = incompleteOsc
      ? this.oscOverflow
        ? evaluateTerminalOsc(this.oscPayload, true)
        : {
            ...evaluateTerminalOsc(this.oscPayload),
            recommendedAction: "suppress" as const,
            reason: "incomplete" as const,
          }
      : undefined;
    const result: TerminalOutputFilterResult = {
      data,
      decisions: decision ? [decision] : [],
      suppressedCharacters: incompleteOsc
        ? this.oscOverflow
          ? this.suppressedOscCharacters
          : this.oscFrame.length
        : 0,
    };
    this.reset();
    return result;
  }

  reset(): void {
    this.state = "ground";
    this.pendingEscape = "";
    this.clearOsc();
  }

  private startOsc(prefix: string): void {
    this.state = "osc";
    this.oscFrame = prefix;
    this.oscPayload = "";
    this.oscCharacters = 0;
    this.oscOverflow = false;
    this.suppressedOscCharacters = 0;
  }

  private appendOscFrame(value: string, payload: boolean): void {
    if (this.oscOverflow) {
      this.suppressedOscCharacters += value.length;
      return;
    }
    if (payload) {
      this.oscCharacters += value.length;
      if (this.oscCharacters > this.maxOscCharacters) {
        this.oscOverflow = true;
        this.suppressedOscCharacters = this.oscFrame.length + value.length;
        this.oscFrame = "";
        this.oscPayload = "";
        return;
      }
      this.oscPayload += value;
    }
    this.oscFrame += value;
  }

  private clearOsc(): void {
    this.oscFrame = "";
    this.oscPayload = "";
    this.oscCharacters = 0;
    this.oscOverflow = false;
    this.suppressedOscCharacters = 0;
  }

  private pendingData(): string {
    if (this.state === "escape") return this.pendingEscape;
    if (this.state === "osc" || this.state === "osc-escape") {
      return this.oscOverflow ? "" : this.oscFrame;
    }
    return "";
  }
}

export function createTerminalOutputFilter(
  options: TerminalOutputFilterOptions = {},
): TerminalOutputFilter {
  return new StreamingTerminalOutputFilter(options);
}
