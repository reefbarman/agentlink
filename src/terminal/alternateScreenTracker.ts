const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);
const MAX_CSI_PARAMETER_BYTES = 128;

export type AlternateScreenTransition =
  | { type: "enter"; modes: readonly number[] }
  | { type: "exit"; modes: readonly number[] };

export interface AlternateScreenScanResult {
  readonly data: string;
  readonly alternateScreen: boolean;
  readonly transitions: readonly AlternateScreenTransition[];
}

export interface AlternateScreenTracker {
  readonly alternateScreen: boolean;
  push(data: string): AlternateScreenScanResult;
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
  private inAlternateScreen = false;

  get alternateScreen(): boolean {
    return this.inAlternateScreen;
  }

  push(data: string): AlternateScreenScanResult {
    const transitions: AlternateScreenTransition[] = [];
    for (let index = 0; index < data.length; index += 1) {
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
        continue;
      }

      if (this.state === "osc-escape") {
        if (character === "\\" || code === 0x07 || code === 0x9c) {
          this.state = "ground";
        } else if (code === 0x1b) {
          this.state = "osc-escape";
        } else if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
        } else {
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
        continue;
      }

      if (this.state === "csi") {
        if (code === 0x18 || code === 0x1a) {
          this.state = "ground";
          continue;
        }
        if (code === 0x1b) {
          this.state = "escape";
          continue;
        }
        if (isCsiFinal(code)) {
          if (!this.csiOverflow && (character === "h" || character === "l")) {
            const modes = parseAlternateScreenModes(this.csiParameters);
            if (modes.length > 0) {
              const next = character === "h";
              if (next !== this.inAlternateScreen) {
                this.inAlternateScreen = next;
                transitions.push({
                  type: next ? "enter" : "exit",
                  modes,
                });
              }
            }
          }
          this.state = "ground";
          continue;
        }
        if (!this.csiOverflow) {
          this.csiParameters += character;
          if (this.csiParameters.length > MAX_CSI_PARAMETER_BYTES) {
            this.csiOverflow = true;
            this.csiParameters = "";
          }
        }
        continue;
      }

      if (code === 0x1b) {
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
    }

    return {
      data,
      alternateScreen: this.inAlternateScreen,
      transitions,
    };
  }

  reset(): void {
    this.state = "ground";
    this.csiParameters = "";
    this.csiOverflow = false;
    this.inAlternateScreen = false;
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
