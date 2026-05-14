import * as vscode from "vscode";

import type { ModelProvider } from "./providers/types.js";
import {
  QUESTION_DETECTION_JSON_SCHEMA,
  buildQuestionDetectionMessages,
  parseQuestionDetectionJson,
  type DetectedQuestion,
} from "../shared/questionDetection.js";
import {
  callOpenAiCompatibleChat,
  getOpenAiCompatibleEndpoint,
  type OpenAiCompatibleEndpoint,
} from "./openaiCompatibleClient.js";

export type QuestionDetectionMode = "heuristic" | "agent" | "openai";

/**
 * Resolve the question-detection mode, honoring the legacy boolean
 * `agentlink.questionDetection.llmEnabled` if the new `mode` has not been
 * explicitly configured.
 */
export function getQuestionDetectionMode(): QuestionDetectionMode {
  const cfg = vscode.workspace.getConfiguration("agentlink");
  const modeInspect = cfg.inspect<QuestionDetectionMode>(
    "questionDetection.mode",
  );
  const explicitMode =
    modeInspect?.globalValue ??
    modeInspect?.workspaceValue ??
    modeInspect?.workspaceFolderValue ??
    modeInspect?.globalLanguageValue ??
    modeInspect?.workspaceLanguageValue ??
    modeInspect?.workspaceFolderLanguageValue;
  if (
    explicitMode === "heuristic" ||
    explicitMode === "agent" ||
    explicitMode === "openai"
  ) {
    return explicitMode;
  }

  const legacyEnabled = cfg.get<boolean>(
    "questionDetection.llmEnabled",
    false,
  );
  if (legacyEnabled) return "openai";

  return "heuristic";
}

export interface QuestionDetectionAgentContext {
  provider: ModelProvider;
  model: string;
}

export interface DetectQuestionOptions {
  mode?: QuestionDetectionMode;
  endpoint?: OpenAiCompatibleEndpoint;
  agent?: QuestionDetectionAgentContext;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface DetectQuestionOutcome {
  detected: DetectedQuestion | null;
  /** True when the caller should fall back to the regex heuristic. */
  fallback: boolean;
  error?: string;
  mode: QuestionDetectionMode;
}

export async function detectQuestion(
  assistantText: string,
  options: DetectQuestionOptions = {},
): Promise<DetectQuestionOutcome> {
  const mode = options.mode ?? getQuestionDetectionMode();

  if (mode === "heuristic") {
    return { detected: null, fallback: true, mode };
  }

  if (!assistantText.trim()) {
    return { detected: null, fallback: false, mode };
  }

  if (mode === "openai") {
    return runOpenAiDetection(assistantText, options, mode);
  }

  return runAgentDetection(assistantText, options, mode);
}

async function runOpenAiDetection(
  assistantText: string,
  options: DetectQuestionOptions,
  mode: QuestionDetectionMode,
): Promise<DetectQuestionOutcome> {
  const endpoint = options.endpoint ?? getOpenAiCompatibleEndpoint();
  const [systemMsg, userMsg] = buildQuestionDetectionMessages(assistantText);
  try {
    const result = await callOpenAiCompatibleChat({
      endpoint,
      systemPrompt: systemMsg.content,
      userContent: userMsg.content,
      jsonSchema: QUESTION_DETECTION_JSON_SCHEMA,
      maxTokens: 300,
      temperature: 0,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    const detected = parseQuestionDetectionJson(result.content);
    return { detected, fallback: false, mode };
  } catch (err) {
    return {
      detected: null,
      fallback: true,
      error: err instanceof Error ? err.message : String(err),
      mode,
    };
  }
}

async function runAgentDetection(
  assistantText: string,
  options: DetectQuestionOptions,
  mode: QuestionDetectionMode,
): Promise<DetectQuestionOutcome> {
  const agent = options.agent;
  if (!agent) {
    return {
      detected: null,
      fallback: true,
      error: "no active agent provider",
      mode,
    };
  }

  const [systemMsg, userMsg] = buildQuestionDetectionMessages(assistantText);

  try {
    const result = await agent.provider.complete({
      model: agent.model,
      systemPrompt: systemMsg.content,
      messages: [{ role: "user", content: userMsg.content }],
      maxTokens: 300,
      temperature: 0,
      signal: options.signal,
    });
    const detected = parseQuestionDetectionJson(result.text);
    return { detected, fallback: false, mode };
  } catch (err) {
    return {
      detected: null,
      fallback: true,
      error: err instanceof Error ? err.message : String(err),
      mode,
    };
  }
}
