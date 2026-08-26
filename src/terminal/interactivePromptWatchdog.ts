import {
  INTERACTIVE_PROMPT_MAX_INPUT_CHARS,
  detectInteractivePrompt,
} from "./interactivePromptDetector.js";

import type { TerminalInteractivePromptDetection } from "../core/capabilities/terminal.js";

export const INTERACTIVE_PROMPT_GRACE_MS = 1_500;

export interface InteractivePromptWatchdog {
  outputTail: string;
  timer?: ReturnType<typeof setTimeout>;
}

export function createInteractivePromptWatchdog(): InteractivePromptWatchdog {
  return { outputTail: "" };
}

export function observeInteractivePrompt(
  watchdog: InteractivePromptWatchdog,
  data: string,
  onPrompt: (detection: TerminalInteractivePromptDetection) => void,
): void {
  clearInteractivePromptWatchdog(watchdog);
  watchdog.outputTail = `${watchdog.outputTail}${data}`.slice(
    -INTERACTIVE_PROMPT_MAX_INPUT_CHARS,
  );
  const detection = detectInteractivePrompt(watchdog.outputTail);
  if (detection?.confidence !== "high") return;

  watchdog.timer = setTimeout(() => {
    watchdog.timer = undefined;
    onPrompt(detection);
  }, INTERACTIVE_PROMPT_GRACE_MS);
  watchdog.timer.unref();
}

export function clearInteractivePromptWatchdog(
  watchdog: InteractivePromptWatchdog | undefined,
): void {
  if (!watchdog?.timer) return;
  clearTimeout(watchdog.timer);
  watchdog.timer = undefined;
}
