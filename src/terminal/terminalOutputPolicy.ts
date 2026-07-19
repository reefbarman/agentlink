const MAX_OSC_CHARACTERS = 8_192;

export type TerminalOutputPolicyAction = "allow" | "suppress";

export type TerminalOutputPolicyReason =
  | "terminal-control"
  | "clipboard"
  | "notification"
  | "proprietary-host-integration"
  | "private-shell-integration"
  | "incomplete"
  | "oversized";

export interface TerminalOutputPolicyDecision {
  readonly type: "osc";
  readonly command: number | null;
  readonly recommendedAction: TerminalOutputPolicyAction;
  readonly reason: TerminalOutputPolicyReason;
}

export interface TerminalOutputPolicyScanResult {
  /** Exact input bytes decoded as text; no recommendation is enforced here. */
  readonly data: string;
  readonly decisions: readonly TerminalOutputPolicyDecision[];
}

export interface TerminalOutputPolicyScanner {
  push(data: string): TerminalOutputPolicyScanResult;
  reset(): void;
}

type ParserState =
  | "ground"
  | "escape"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

function isStringControl(code: number): boolean {
  return code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function parseOscCommand(payload: string): number | null {
  const separator = payload.indexOf(";");
  const value = separator === -1 ? payload : payload.slice(0, separator);
  if (!/^\d+$/.test(value)) return null;
  const command = Number(value);
  return Number.isSafeInteger(command) ? command : null;
}

export function evaluateTerminalOsc(
  payload: string,
  overflow = false,
): TerminalOutputPolicyDecision {
  const command = parseOscCommand(payload);
  if (overflow) {
    return {
      type: "osc",
      command,
      recommendedAction: "suppress",
      reason: "oversized",
    };
  }
  if (command === 52) {
    return {
      type: "osc",
      command,
      recommendedAction: "suppress",
      reason: "clipboard",
    };
  }
  if (command === 9) {
    const parameters = payload.split(";");
    if (parameters[1] !== "4" && parameters[1] !== "9") {
      return {
        type: "osc",
        command,
        recommendedAction: "suppress",
        reason: "notification",
      };
    }
  }
  if (command === 777) {
    return {
      type: "osc",
      command,
      recommendedAction: "suppress",
      reason: "notification",
    };
  }
  if (command === 697) {
    return {
      type: "osc",
      command,
      recommendedAction: "suppress",
      reason: "private-shell-integration",
    };
  }
  if (command === 1337) {
    return {
      type: "osc",
      command,
      recommendedAction: "suppress",
      reason: "proprietary-host-integration",
    };
  }
  return {
    type: "osc",
    command,
    recommendedAction: "allow",
    reason: "terminal-control",
  };
}

class StreamingTerminalOutputPolicyScanner implements TerminalOutputPolicyScanner {
  private state: ParserState = "ground";
  private oscPayload = "";
  private oscCharacters = 0;
  private oscOverflow = false;

  push(data: string): TerminalOutputPolicyScanResult {
    const decisions: TerminalOutputPolicyDecision[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      const character = data[index];

      if (this.state === "osc") {
        if (code === 0x07 || code === 0x9c) {
          decisions.push(this.finishOsc());
        } else if (code === 0x1b) {
          this.state = "osc-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.cancelOsc();
        } else {
          this.appendOsc(character);
        }
        continue;
      }

      if (this.state === "osc-escape") {
        if (character === "\\" || code === 0x07 || code === 0x9c) {
          decisions.push(this.finishOsc());
        } else if (code === 0x1b) {
          this.appendOsc("\x1b");
        } else if (code === 0x18 || code === 0x1a) {
          this.cancelOsc();
        } else {
          this.appendOsc("\x1b");
          this.appendOsc(character);
          this.state = "osc";
        }
        continue;
      }

      if (this.state === "string") {
        if (code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        }
        continue;
      }

      if (this.state === "string-escape") {
        if (character === "\\" || code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "string-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else {
          this.state = "string";
        }
        continue;
      }

      if (this.state === "escape") {
        if (character === "]") {
          this.startOsc();
        } else if (isStringControl(code)) {
          this.state = "string";
        } else if (code === 0x1b) {
          this.state = "escape";
        } else if (code === 0x9d) {
          this.startOsc();
        } else {
          this.state = "ground";
        }
        continue;
      }

      if (code === 0x1b) {
        this.state = "escape";
      } else if (code === 0x9d) {
        this.startOsc();
      } else if (
        code === 0x90 ||
        code === 0x98 ||
        code === 0x9e ||
        code === 0x9f
      ) {
        this.state = "string";
      }
    }

    return { data, decisions };
  }

  reset(): void {
    this.state = "ground";
    this.oscPayload = "";
    this.oscCharacters = 0;
    this.oscOverflow = false;
  }

  private startOsc(): void {
    this.state = "osc";
    this.oscPayload = "";
    this.oscCharacters = 0;
    this.oscOverflow = false;
  }

  private appendOsc(value: string): void {
    if (this.oscOverflow) return;
    this.oscCharacters += value.length;
    if (this.oscCharacters > MAX_OSC_CHARACTERS) {
      this.oscOverflow = true;
      return;
    }
    this.oscPayload += value;
  }

  private finishOsc(): TerminalOutputPolicyDecision {
    const decision = evaluateTerminalOsc(this.oscPayload, this.oscOverflow);
    this.startOsc();
    this.state = "ground";
    return decision;
  }

  private cancelOsc(): void {
    this.startOsc();
    this.state = "ground";
  }
}

export function createTerminalOutputPolicyScanner(): TerminalOutputPolicyScanner {
  return new StreamingTerminalOutputPolicyScanner();
}
