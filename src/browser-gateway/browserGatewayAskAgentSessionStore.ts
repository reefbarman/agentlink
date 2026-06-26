import type {
  ChatMessage,
  QuestionRequest,
  ReasoningEffort,
  SessionSummary,
  TodoItem,
  WebviewModelInfo,
} from "../agent/webview/types.js";
import type {
  CoreCapabilityStatusDto,
  CoreOwnerRegistrationDto,
  CoreSessionSummaryDto,
} from "../core/sessionProtocol.js";

import type { ApprovalRequest } from "../approvals/webview/types.js";
import type { BrowserGatewayAskAgentPreferencesSnapshot } from "./browserGatewayAskAgentPreferences.js";
import type { BrowserGatewayCoreOwnerRegistry } from "./coreOwnerRegistry.js";
import type { BrowserGatewayModelCredentialStatus } from "./browserGatewayModelCredentialCache.js";
import type { BrowserGatewayThemeSnapshot } from "../shared/types.js";
import type { FinalMessageMarker } from "../shared/finalStatus.js";
import type { MemoryCandidateKind } from "../shared/memoryCandidates.js";
import { completeTodos } from "../agent/todoTool.js";
import { normalizeBrowserGatewayModelCredentialProviderId } from "./browserGatewayModelProviderIds.js";
import { randomUUID } from "crypto";

export const BROWSER_GATEWAY_ASK_AGENT_OWNER_ID = "browser-gateway:ask-agent";
export const BROWSER_GATEWAY_ASK_AGENT_SESSION_ID =
  "browser-gateway:ask-agent:default";
export const BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID =
  "browser-gateway:ask-agent:default-generation";
export const BROWSER_GATEWAY_ASK_AGENT_SCOPE_ID = "default-ask-agent";
export const BROWSER_GATEWAY_ASK_AGENT_DEFAULT_MODEL = "gpt-5.3-codex";
export const BROWSER_GATEWAY_ASK_AGENT_MODEL_SCOPE = "chat";
const BROWSER_GATEWAY_ASK_AGENT_FALLBACK_MODELS: WebviewModelInfo[] = [
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    provider: "browser-gateway",
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
    defaultReasoningEffort: "low",
    authenticated: true,
  },
  {
    id: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    provider: "browser-gateway",
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
    defaultReasoningEffort: "low",
    authenticated: true,
  },
  {
    id: "gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    provider: "browser-gateway",
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high"],
    defaultReasoningEffort: "low",
    authenticated: true,
  },
];

export interface BrowserGatewayAskAgentMemoryCandidateNudge {
  id: string;
  sessionId: string;
  createdAt: number;
  kind: MemoryCandidateKind;
  matchedPhrase: string;
  suggestedScope: "global";
  suggestedTier: "memory";
  title: string;
  rationale: string;
  content: string;
}

export interface BrowserGatewayAskAgentQuestionProgress {
  id: string;
  step: number;
  answers: Record<string, string | string[] | number | boolean | undefined>;
  notes: Record<string, string>;
  origin: string;
}

export interface BrowserGatewayAskAgentProjectHandoff {
  id: string;
  sessionId: string;
  createdAt: number;
  targetInstanceId: string;
  targetWorkspaceName: string;
  targetWorkspacePath: string;
  mode: string;
  instruction: string;
  status: "pending" | "launching" | "completed" | "cancelled" | "failed";
  error?: string;
}

export interface BrowserGatewayAskAgentReadGrant {
  id: string;
  createdAt: number;
  rootPath: string;
  label: string;
  kind: "file" | "directory";
}

export interface BrowserGatewayAskAgentSnapshot {
  ui: {
    approval: ApprovalRequest | null;
    question: QuestionRequest | null;
    questionProgress: BrowserGatewayAskAgentQuestionProgress | null;
    urlElicitation: null;
    recentEvents: [];
    mcpStatusInfos: [];
    memoryCandidateNudge: BrowserGatewayAskAgentMemoryCandidateNudge | null;
    projectHandoff: BrowserGatewayAskAgentProjectHandoff | null;
    readGrants: BrowserGatewayAskAgentReadGrant[];
  };
  session: {
    repository: null;
    sessions: Array<{
      id: string;
      mode: "ask";
      model: string;
      title: string;
      messageCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      createdAt: number;
      lastActiveAt: number;
    }>;
    foreground: {
      sessionId: string;
      title: string;
      mode: "ask";
      model: string;
      status: "idle" | "streaming";
      streaming: boolean;
      messages: [];
      projectedMessages: ChatMessage[];
      statusOverride: string | null;
      thinkingEnabled: boolean;
      reasoningEffort: ReasoningEffort;
      lastInputTokens: 0;
      lastOutputTokens: 0;
      lastCacheReadTokens: 0;
      estimatedTotalUsed: 0;
      messageQueue: [];
      questionRequest: QuestionRequest | null;
      detectedQuestion: null;
      todos: TodoItem[];
      debugInfo: null;
      systemPrompt: null;
      loadedInstructions: null;
      restoringSession: false;
      revertRecoveryNotice: null;
      condenseThreshold: number;
      agentWriteApproval: "prompt";
    };
  };
  background: [];
  diffs: [];
  theme: BrowserGatewayThemeSnapshot;
  modelsVersion: 0;
}

export interface BrowserGatewayAskAgentSessionResponse {
  ok: true;
  ownerRegistration: CoreOwnerRegistrationDto;
  session: CoreSessionSummaryDto;
  snapshot: BrowserGatewayAskAgentSnapshot;
}

export type BrowserGatewayAskAgentSessionSummary = SessionSummary & {
  mode: "ask";
};

export interface BrowserGatewayAskAgentPersistedSession {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  messages: ChatMessage[];
  nextMessageSequence: number;
}

export interface BrowserGatewayAskAgentHistorySnapshot {
  activeSessionId?: string;
  sessions: BrowserGatewayAskAgentPersistedSession[];
}

export interface BrowserGatewayAskAgentMediaItem {
  name: string;
  mimeType: string;
  base64: string;
}

export type BrowserGatewayAskAgentDisplayMedia = NonNullable<
  ChatMessage["displayMedia"]
>;

export interface BrowserGatewayAskAgentSendRequest {
  text: string;
  id?: string;
  now: number;
  theme: BrowserGatewayThemeSnapshot;
  modelCredentialStatus: BrowserGatewayModelCredentialStatus;
  assistantText?: string;
  media?: {
    images?: BrowserGatewayAskAgentMediaItem[];
    documents?: BrowserGatewayAskAgentMediaItem[];
  };
}

export function askAgentMediaToDisplayMedia(media?: {
  images?: BrowserGatewayAskAgentMediaItem[];
  documents?: BrowserGatewayAskAgentMediaItem[];
}): BrowserGatewayAskAgentDisplayMedia | undefined {
  if (!media?.images?.length && !media?.documents?.length) return undefined;
  return {
    images:
      media.images?.map((image) => ({
        name: image.name,
        mimeType: image.mimeType,
        src: `data:${image.mimeType};base64,${image.base64}`,
      })) ?? [],
    documents:
      media.documents?.map((document) => ({
        name: document.name,
        mimeType: document.mimeType,
      })) ?? [],
  };
}

function getAskAgentCapabilities(
  modelCredentialStatus: BrowserGatewayModelCredentialStatus,
): CoreCapabilityStatusDto[] {
  if (modelCredentialStatus.state === "ready") {
    return [
      {
        capabilityId: "model-auth",
        state: "enabled",
        reason: `Browser gateway has cached ${modelCredentialStatus.providerId} credentials.`,
      },
    ];
  }
  return [
    {
      capabilityId: "model-auth",
      state: "unavailable",
      reason: modelCredentialStatus.reason,
    },
  ];
}

export class BrowserGatewayAskAgentSessionStore {
  private sessions: BrowserGatewayAskAgentPersistedSession[] = [];
  private activeSessionId: string | undefined;
  private streaming = false;
  private availableModels = BROWSER_GATEWAY_ASK_AGENT_FALLBACK_MODELS;
  private model = BROWSER_GATEWAY_ASK_AGENT_DEFAULT_MODEL;
  private preferredModel: string | undefined;
  private reasoningEffort: ReasoningEffort = "low";
  private questionRequest: QuestionRequest | null = null;
  private questionProgress: BrowserGatewayAskAgentQuestionProgress | null =
    null;
  private todos: TodoItem[] = [];
  private projectHandoff: BrowserGatewayAskAgentProjectHandoff | null = null;
  private readGrants: BrowserGatewayAskAgentReadGrant[] = [];

  constructor(
    private readonly ownerRegistry: BrowserGatewayCoreOwnerRegistry,
    initialPreferences: BrowserGatewayAskAgentPreferencesSnapshot = {},
  ) {
    const initialModel = initialPreferences.model?.trim();
    if (initialModel) {
      this.preferredModel = initialModel;
      if (this.availableModels.some((model) => model.id === initialModel)) {
        this.model = initialModel;
      }
    }
    if (initialPreferences.reasoningEffort) {
      this.reasoningEffort = initialPreferences.reasoningEffort;
    }
    this.syncReasoningEffortForCurrentModel();
  }

  loadHistory(history: BrowserGatewayAskAgentHistorySnapshot): void {
    const sessions = history.sessions.filter((session) => session.id.trim());
    this.sessions = sessions.length > 0 ? sessions : [];
    this.activeSessionId = sessions.some(
      (session) => session.id === history.activeSessionId,
    )
      ? history.activeSessionId
      : sessions[0]?.id;
    this.streaming = false;
    this.clearEphemeralUiState();
  }

  getHistorySnapshot(): BrowserGatewayAskAgentHistorySnapshot {
    return {
      ...(this.activeSessionId
        ? { activeSessionId: this.activeSessionId }
        : {}),
      sessions: this.sessions.map((session) => ({
        ...session,
        messages: [...session.messages],
      })),
    };
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.some((session) => session.id === sessionId);
  }

  getActiveSessionId(): string {
    return this.getActiveSession().id;
  }

  listSessions(): BrowserGatewayAskAgentSessionSummary[] {
    return this.sessions
      .map((session) => this.toSessionSummary(session))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  createSession(now: number, title = "Ask Agent"): void {
    const session: BrowserGatewayAskAgentPersistedSession = {
      id: this.nextSessionId(now),
      title,
      createdAt: now,
      lastActiveAt: now,
      messages: [],
      nextMessageSequence: 1,
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.streaming = false;
    this.clearEphemeralUiState();
  }

  loadSession(sessionId: string): boolean {
    if (!this.sessions.some((session) => session.id === sessionId)) {
      return false;
    }
    this.activeSessionId = sessionId;
    this.streaming = false;
    this.clearEphemeralUiState();
    return true;
  }

  deleteSession(sessionId: string, now = Date.now()): boolean {
    const index = this.sessions.findIndex(
      (session) => session.id === sessionId,
    );
    if (index === -1) return false;
    this.sessions.splice(index, 1);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id;
      this.streaming = false;
      this.clearEphemeralUiState();
      if (!this.activeSessionId) {
        this.createSession(now);
      }
    }
    return true;
  }

  renameSession(sessionId: string, title: string, now = Date.now()): boolean {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return false;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return false;
    session.title = normalizedTitle;
    session.lastActiveAt = now;
    return true;
  }

  getFirstPrompt(sessionId: string): string | null {
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    const firstUserMessage = session?.messages.find(
      (message) => message.role === "user",
    );
    return firstUserMessage?.content ?? null;
  }

  prepareLatestRetryableTurn(params: {
    sessionId: string;
    now: number;
  }): ChatMessage | null {
    const sessionId = params.sessionId.trim();
    if (!sessionId || this.streaming) return null;
    const session = this.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return null;
    const lastMessage = session.messages.at(-1);
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      !lastMessage.error?.retryable
    ) {
      return null;
    }
    for (let i = session.messages.length - 2; i >= 0; i -= 1) {
      const message = session.messages[i];
      if (message.role === "user" && message.content.trim()) {
        this.activeSessionId = session.id;
        session.messages.pop();
        session.lastActiveAt = params.now;
        return message;
      }
    }
    return null;
  }

  getPreferencesSnapshot(): BrowserGatewayAskAgentPreferencesSnapshot {
    return {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    };
  }

  applyPreferences(
    preferences: BrowserGatewayAskAgentPreferencesSnapshot,
  ): void {
    const preferredModel = preferences.model?.trim();
    if (preferredModel) {
      this.preferredModel = preferredModel;
      if (this.availableModels.some((model) => model.id === preferredModel)) {
        this.model = preferredModel;
      }
    }
    if (preferences.reasoningEffort) {
      this.reasoningEffort = preferences.reasoningEffort;
    }
    this.syncReasoningEffortForCurrentModel();
  }

  getOrCreate(params: {
    now: number;
    theme: BrowserGatewayThemeSnapshot;
    modelCredentialStatus: BrowserGatewayModelCredentialStatus;
    approval?: ApprovalRequest | null;
    memoryCandidateNudge?: BrowserGatewayAskAgentMemoryCandidateNudge | null;
  }): BrowserGatewayAskAgentSessionResponse {
    return this.buildResponse(
      params.now,
      params.theme,
      params.modelCredentialStatus,
      params.approval ?? null,
      params.memoryCandidateNudge ?? null,
    );
  }

  getTranscriptMessages(): ChatMessage[] {
    return [...this.getActiveSession().messages];
  }

  getProjectedMessages(): ChatMessage[] {
    return this.getActiveSession().messages.map((message) => {
      if (!message.media) return message;
      const { media: _media, ...rest } = message;
      return rest;
    });
  }

  getActiveUserMessageTexts(): string[] {
    return this.getActiveSession()
      .messages.filter(
        (message) => message.role === "user" && message.content.trim(),
      )
      .map((message) => message.content);
  }

  hasActiveUserMessageId(messageId: string | undefined): boolean {
    const normalized = messageId?.trim();
    if (!normalized) return false;
    return this.getActiveSession().messages.some(
      (message) => message.role === "user" && message.id === normalized,
    );
  }

  getAvailableModels(): WebviewModelInfo[] {
    return this.availableModels.map((model) => ({
      ...model,
      authenticated: true,
    }));
  }

  updateAvailableModels(models: WebviewModelInfo[]): void {
    const validModels = models.filter((model) => model.id.trim());
    if (validModels.length === 0) return;
    this.availableModels = validModels;
    if (
      this.preferredModel &&
      this.availableModels.some((model) => model.id === this.preferredModel)
    ) {
      this.model = this.preferredModel;
    }
    if (!this.availableModels.some((model) => model.id === this.model)) {
      const nextModel = this.availableModels[0];
      this.model = nextModel.id;
      this.preferredModel = nextModel.id;
      this.reasoningEffort =
        nextModel.defaultReasoningEffort ??
        nextModel.reasoningEfforts?.[0] ??
        this.reasoningEffort;
    }
    this.syncReasoningEffortForCurrentModel();
  }

  setModel(modelId: string): boolean {
    const normalized = modelId.trim();
    if (!normalized) return false;
    const model = this.availableModels.find(
      (candidate) => candidate.id === normalized,
    );
    if (!model) return false;
    this.model = model.id;
    this.preferredModel = model.id;
    this.syncReasoningEffortForCurrentModel();
    return true;
  }

  setReasoningEffort(effort: ReasoningEffort): boolean {
    const model = this.availableModels.find(
      (candidate) => candidate.id === this.model,
    );
    if (
      model?.reasoningEfforts?.length &&
      !model.reasoningEfforts.includes(effort)
    ) {
      return false;
    }
    this.reasoningEffort = effort;
    return true;
  }

  getModel(): string {
    return this.model;
  }

  getModelProvider(): string {
    const provider = this.availableModels.find(
      (candidate) => candidate.id === this.model,
    )?.provider;
    if (provider && provider !== "browser-gateway") {
      return normalizeBrowserGatewayModelCredentialProviderId(provider);
    }
    if (this.model.includes("codex") || this.model.startsWith("gpt-")) {
      return normalizeBrowserGatewayModelCredentialProviderId("codex");
    }
    return provider ?? "browser-gateway";
  }

  getReasoningEffort(): ReasoningEffort {
    return this.reasoningEffort;
  }

  // Producer wiring is intentionally deferred until the Ask Agent model loop
  // supports its safe projectless tool subset (`ask_user`, `todo_write`,
  // `set_task_status`). These setters keep the browser/helper snapshot contract
  // ready without enabling workspace write/exec capabilities.
  setQuestionRequest(question: QuestionRequest | null): void {
    this.questionRequest = question;
    if (!question) {
      this.questionProgress = null;
      return;
    }
    if (this.questionProgress?.id !== question.id) {
      this.questionProgress = null;
    }
  }

  setQuestionProgress(
    progress: BrowserGatewayAskAgentQuestionProgress,
  ): boolean {
    if (!this.questionRequest || this.questionRequest.id !== progress.id) {
      return false;
    }
    this.questionProgress = progress;
    return true;
  }

  answerQuestion(
    questionId: string,
    answers: Record<
      string,
      string | string[] | number | boolean | undefined
    > = {},
    notes: Record<string, string> = {},
  ): boolean {
    if (!this.questionRequest || this.questionRequest.id !== questionId) {
      return false;
    }
    const request = this.questionRequest;
    const session = this.getActiveSession();
    let latestAssistantIndex = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i]?.role === "assistant") {
        latestAssistantIndex = i;
        break;
      }
    }
    if (latestAssistantIndex >= 0) {
      const message = session.messages[latestAssistantIndex]!;
      const answeredItems = request.questions.map((question) => ({
        question: question.question,
        answer: answers[question.id] ?? null,
        ...(notes[question.id] ? { note: notes[question.id] } : {}),
      }));
      session.messages[latestAssistantIndex] = {
        ...message,
        blocks: [
          ...message.blocks,
          { type: "question_answer", items: answeredItems },
        ],
      };
    }
    this.questionRequest = null;
    this.questionProgress = null;
    return true;
  }

  setTodos(todos: TodoItem[]): void {
    this.todos = todos.map((todo) => ({ ...todo }));
  }

  completeTodos(): TodoItem[] {
    this.todos = completeTodos(this.todos);
    return this.todos.map((todo) => ({ ...todo }));
  }

  getTodos(): TodoItem[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  proposeProjectHandoff(
    handoff: Omit<BrowserGatewayAskAgentProjectHandoff, "status">,
  ): BrowserGatewayAskAgentProjectHandoff {
    this.projectHandoff = { ...handoff, status: "pending" };
    return { ...this.projectHandoff };
  }

  getProjectHandoff(): BrowserGatewayAskAgentProjectHandoff | null {
    return this.projectHandoff ? { ...this.projectHandoff } : null;
  }

  cancelProjectHandoff(handoffId: string): boolean {
    if (!this.projectHandoff || this.projectHandoff.id !== handoffId) {
      return false;
    }
    this.projectHandoff = {
      ...this.projectHandoff,
      status: "cancelled",
    };
    return true;
  }

  markProjectHandoffLaunching(
    handoffId: string,
  ): BrowserGatewayAskAgentProjectHandoff | null {
    if (!this.projectHandoff || this.projectHandoff.id !== handoffId) {
      return null;
    }
    this.projectHandoff = {
      ...this.projectHandoff,
      status: "launching",
      error: undefined,
    };
    return { ...this.projectHandoff };
  }

  addReadGrant(
    grant: BrowserGatewayAskAgentReadGrant,
  ): BrowserGatewayAskAgentReadGrant[] {
    const existingIndex = this.readGrants.findIndex(
      (candidate) => candidate.rootPath === grant.rootPath,
    );
    if (existingIndex >= 0) {
      this.readGrants[existingIndex] = grant;
    } else {
      this.readGrants.push(grant);
    }
    return this.getReadGrants();
  }

  removeReadGrant(grantId: string): boolean {
    const index = this.readGrants.findIndex((grant) => grant.id === grantId);
    if (index === -1) return false;
    this.readGrants.splice(index, 1);
    return true;
  }

  getReadGrants(): BrowserGatewayAskAgentReadGrant[] {
    return this.readGrants.map((grant) => ({ ...grant }));
  }

  completeProjectHandoff(handoffId: string): boolean {
    if (!this.projectHandoff || this.projectHandoff.id !== handoffId) {
      return false;
    }
    this.projectHandoff = {
      ...this.projectHandoff,
      status: "completed",
      error: undefined,
    };
    return true;
  }

  failProjectHandoff(handoffId: string, error: string): boolean {
    if (!this.projectHandoff || this.projectHandoff.id !== handoffId) {
      return false;
    }
    this.projectHandoff = {
      ...this.projectHandoff,
      status: "failed",
      error,
    };
    return true;
  }

  applyFinalMarker(marker: FinalMessageMarker | null): boolean {
    if (!marker) return false;
    const session = this.getActiveSession();
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i];
      if (message?.role !== "assistant") continue;
      session.messages[i] = { ...message, finalMarker: marker };
      return true;
    }
    return false;
  }

  private clearEphemeralUiState(): void {
    this.questionRequest = null;
    this.questionProgress = null;
    this.todos = [];
    this.projectHandoff = null;
  }

  private syncReasoningEffortForCurrentModel(): void {
    const model = this.availableModels.find(
      (candidate) => candidate.id === this.model,
    );
    if (
      model?.reasoningEfforts?.length &&
      !model.reasoningEfforts.includes(this.reasoningEffort)
    ) {
      this.reasoningEffort =
        model.defaultReasoningEffort ?? model.reasoningEfforts[0] ?? "none";
    }
  }

  appendUserMessage(params: {
    id?: string;
    text: string;
    now: number;
    displayMedia?: ChatMessage["displayMedia"];
    media?: ChatMessage["media"];
  }): ChatMessage {
    const text = params.text.trim();
    const hasMedia =
      Boolean(params.media?.images?.length) ||
      Boolean(params.media?.documents?.length);
    if (!text && !hasMedia) {
      throw new Error("browser_gateway_ask_agent_empty_message");
    }
    const session = this.getActiveSession(params.now);
    const message: ChatMessage = {
      id: params.id?.trim() || this.nextMessageId(session, "ask-agent-user"),
      role: "user",
      content: text,
      timestamp: params.now,
      blocks: [{ type: "text", text }],
      ...(params.displayMedia ? { displayMedia: params.displayMedia } : {}),
      ...(params.media ? { media: params.media } : {}),
    };
    session.messages.push(message);
    session.lastActiveAt = params.now;
    if (session.title === "Ask Agent") {
      session.title = this.deriveSessionTitle(text);
    }
    return message;
  }

  startAssistantMessage(params: {
    now: number;
    text?: string;
    memoryDisclosure?: ChatMessage["memoryDisclosure"];
  }): ChatMessage {
    const text = params.text ?? "";
    const session = this.getActiveSession(params.now);
    const message: ChatMessage = {
      id: this.nextMessageId(session, "ask-agent-assistant"),
      role: "assistant",
      content: text,
      timestamp: params.now,
      blocks: [{ type: "text", text }],
      ...(params.memoryDisclosure
        ? { memoryDisclosure: params.memoryDisclosure }
        : {}),
    };
    session.messages.push(message);
    session.lastActiveAt = params.now;
    this.streaming = true;
    return message;
  }

  appendAssistantDelta(messageId: string, delta: string): void {
    if (!delta) return;
    const session = this.getActiveSession();
    const message = session.messages.find(
      (candidate) => candidate.id === messageId,
    );
    if (!message) return;
    message.content = `${message.content}${delta}`;
    this.appendAssistantTextBlock(message, delta);
  }

  startAssistantToolCall(params: {
    messageId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
  }): void {
    const message = this.getAssistantMessage(params.messageId);
    if (!message) return;
    if (
      message.blocks.some(
        (block) => block.type === "tool_call" && block.id === params.toolCallId,
      )
    ) {
      return;
    }
    message.blocks.push({
      type: "tool_call",
      id: params.toolCallId,
      name: params.toolName,
      inputJson: JSON.stringify(params.input),
      result: "",
      complete: false,
    });
  }

  completeAssistantToolCall(params: {
    messageId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
    result: string;
    durationMs: number;
  }): void {
    const message = this.getAssistantMessage(params.messageId);
    if (!message) return;
    let found = false;
    message.blocks = message.blocks.map((block) => {
      if (block.type !== "tool_call" || block.id !== params.toolCallId) {
        return block;
      }
      found = true;
      return {
        ...block,
        name: params.toolName,
        inputJson: block.inputJson || JSON.stringify(params.input),
        result: params.result,
        complete: true,
        durationMs: params.durationMs,
      };
    });
    if (!found) {
      message.blocks.push({
        type: "tool_call",
        id: params.toolCallId,
        name: params.toolName,
        inputJson: JSON.stringify(params.input),
        result: params.result,
        complete: true,
        durationMs: params.durationMs,
      });
    }
    if (params.toolName === "ask_user") {
      this.appendQuestionAnswerBlockFromToolResult(message, params.result);
    }
  }

  finishAssistantMessage(
    messageId: string,
    fallbackText?: string,
    memoryDisclosure?: ChatMessage["memoryDisclosure"],
  ): void {
    const session = this.getActiveSession();
    const message = session.messages.find(
      (candidate) => candidate.id === messageId,
    );
    if (message && memoryDisclosure) {
      message.memoryDisclosure = memoryDisclosure;
    }
    if (message && !message.content.trim() && fallbackText) {
      message.content = fallbackText;
      this.setAssistantFallbackTextBlock(message, fallbackText);
    }
    this.streaming = false;
  }

  finishAssistantErrorMessage(params: {
    messageId: string;
    text: string;
    code: string;
    retryable: boolean;
    actions?: NonNullable<ChatMessage["error"]>["actions"];
  }): void {
    const session = this.getActiveSession();
    const message = session.messages.find(
      (candidate) => candidate.id === params.messageId,
    );
    if (message) {
      message.content = "";
      message.blocks = [];
      message.error = {
        message: params.text,
        retryable: params.retryable,
        code: params.code,
        ...(params.actions ? { actions: params.actions } : {}),
      };
    }
    this.streaming = false;
  }

  appendAssistantMessage(params: { text: string; now: number }): ChatMessage {
    const message = this.startAssistantMessage({
      now: params.now,
      text: params.text,
    });
    this.finishAssistantMessage(message.id);
    return message;
  }

  sendMessage(
    request: BrowserGatewayAskAgentSendRequest,
  ): BrowserGatewayAskAgentSessionResponse {
    const text = request.text.trim();
    const hasMedia =
      Boolean(request.media?.images?.length) ||
      Boolean(request.media?.documents?.length);
    if (!text && !hasMedia) {
      throw new Error("browser_gateway_ask_agent_empty_message");
    }

    if (this.hasActiveUserMessageId(request.id)) {
      return this.buildResponse(
        request.now,
        request.theme,
        request.modelCredentialStatus,
        null,
        null,
      );
    }

    this.appendUserMessage({
      id: request.id,
      text,
      now: request.now,
      displayMedia: askAgentMediaToDisplayMedia(request.media),
      media: request.media,
    });

    const assistant =
      request.assistantText?.trim() ||
      this.buildAssistantResponse(request.modelCredentialStatus);
    this.appendAssistantMessage({ text: assistant, now: request.now });

    return this.buildResponse(
      request.now,
      request.theme,
      request.modelCredentialStatus,
      null,
      null,
    );
  }

  private buildResponse(
    now: number,
    theme: BrowserGatewayThemeSnapshot,
    modelCredentialStatus: BrowserGatewayModelCredentialStatus,
    approval: ApprovalRequest | null = null,
    memoryCandidateNudge: BrowserGatewayAskAgentMemoryCandidateNudge | null = null,
  ): BrowserGatewayAskAgentSessionResponse {
    const ownerRegistration = this.getOrRegisterOwner(
      now,
      modelCredentialStatus,
    );
    const owner = ownerRegistration.owner;

    const activeSession = this.getActiveSession(now);
    const session: CoreSessionSummaryDto = {
      sessionId: activeSession.id,
      title: activeSession.title,
      mode: "ask",
      model: this.model,
      lifecycle: "idle",
      owner,
      capabilities: ownerRegistration.capabilities,
      createdAt: activeSession.createdAt,
      updatedAt: activeSession.lastActiveAt,
    };

    const statusOverride = this.buildStatusOverride(modelCredentialStatus);

    const projectedMessages = this.getProjectedMessages();

    return {
      ok: true,
      ownerRegistration,
      session,
      snapshot: {
        ui: {
          approval,
          question: this.questionRequest,
          questionProgress: this.questionProgress,
          urlElicitation: null,
          recentEvents: [],
          mcpStatusInfos: [],
          memoryCandidateNudge,
          projectHandoff: this.projectHandoff,
          readGrants: this.getReadGrants(),
        },
        session: {
          repository: null,
          sessions: this.listSessions(),
          foreground: {
            sessionId: session.sessionId,
            title: session.title,
            mode: "ask",
            model: session.model,
            status: this.streaming ? "streaming" : "idle",
            streaming: this.streaming,
            messages: [],
            projectedMessages,
            statusOverride,
            thinkingEnabled: this.reasoningEffort !== "none",
            reasoningEffort: this.reasoningEffort,
            lastInputTokens: 0,
            lastOutputTokens: 0,
            lastCacheReadTokens: 0,
            estimatedTotalUsed: 0,
            messageQueue: [],
            questionRequest: this.questionRequest,
            detectedQuestion: null,
            todos: this.todos,
            debugInfo: null,
            systemPrompt: null,
            loadedInstructions: null,
            restoringSession: false,
            revertRecoveryNotice: null,
            condenseThreshold: 0.8,
            agentWriteApproval: "prompt",
          },
        },
        background: [],
        diffs: [],
        theme,
        modelsVersion: 0,
      },
    };
  }

  private appendAssistantTextBlock(message: ChatMessage, text: string): void {
    const tail = message.blocks.at(-1);
    if (tail?.type === "text") {
      message.blocks[message.blocks.length - 1] = {
        ...tail,
        text: tail.text + text,
      };
    } else {
      message.blocks.push({ type: "text", text });
    }
  }

  private setAssistantFallbackTextBlock(
    message: ChatMessage,
    text: string,
  ): void {
    const first = message.blocks[0];
    if (first?.type === "text" && !first.text.trim()) {
      message.blocks[0] = { type: "text", text };
      return;
    }
    message.blocks.push({ type: "text", text });
  }

  private getAssistantMessage(messageId: string): ChatMessage | undefined {
    const session = this.getActiveSession();
    const message = session.messages.find(
      (candidate) => candidate.id === messageId,
    );
    return message?.role === "assistant" ? message : undefined;
  }

  private appendQuestionAnswerBlockFromToolResult(
    message: ChatMessage,
    result: string,
  ): void {
    try {
      const parsed = JSON.parse(result) as {
        responses?: Array<{
          question?: unknown;
          answer?: unknown;
          note?: unknown;
        }>;
      };
      const items = Array.isArray(parsed.responses)
        ? parsed.responses.flatMap((response) => {
            if (!response || typeof response !== "object") return [];
            const question =
              typeof response.question === "string" ? response.question : "";
            const answer = response.answer;
            if (
              answer !== null &&
              typeof answer !== "string" &&
              typeof answer !== "number" &&
              typeof answer !== "boolean" &&
              !(
                Array.isArray(answer) &&
                answer.every((item) => typeof item === "string")
              )
            ) {
              return [];
            }
            return [
              {
                question,
                answer,
                ...(typeof response.note === "string"
                  ? { note: response.note }
                  : {}),
              },
            ];
          })
        : [];
      if (items.length === 0) return;
      if (message.blocks.some((block) => block.type === "question_answer")) {
        return;
      }
      message.blocks.push({ type: "question_answer", items });
    } catch {
      // Ignore malformed tool results; raw result remains in the tool block.
    }
  }

  private getActiveSession(
    now = Date.now(),
  ): BrowserGatewayAskAgentPersistedSession {
    const existing = this.sessions.find(
      (session) => session.id === this.activeSessionId,
    );
    if (existing) return existing;
    this.createSession(now);
    const created = this.sessions.find(
      (session) => session.id === this.activeSessionId,
    );
    if (!created) {
      throw new Error("browser_gateway_ask_agent_session_create_failed");
    }
    return created;
  }

  private nextSessionId(_now: number): string {
    if (this.sessions.length === 0) return BROWSER_GATEWAY_ASK_AGENT_SESSION_ID;
    return `browser-gateway:ask-agent:${randomUUID()}`;
  }

  private nextMessageId(
    session: BrowserGatewayAskAgentPersistedSession,
    prefix: string,
  ): string {
    const sequence = session.nextMessageSequence++;
    return `${prefix}-${session.createdAt}-${sequence}`;
  }

  private deriveSessionTitle(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "Ask Agent";
    return normalized.length > 60 ? `${normalized.slice(0, 57)}…` : normalized;
  }

  private toSessionSummary(
    session: BrowserGatewayAskAgentPersistedSession,
  ): BrowserGatewayAskAgentSessionSummary {
    return {
      id: session.id,
      mode: "ask",
      model: this.model,
      title: session.title,
      messageCount: session.messages.length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    };
  }

  private buildStatusOverride(
    _modelCredentialStatus: BrowserGatewayModelCredentialStatus,
  ): string | null {
    return null;
  }

  private buildAssistantResponse(
    modelCredentialStatus: BrowserGatewayModelCredentialStatus,
  ): string {
    if (modelCredentialStatus.state === "ready") {
      return "I received your message and the browser gateway has cached model credentials, but no model turn was run for this request.";
    }
    if (modelCredentialStatus.state === "refresh_required") {
      return `I received your message, but cached model credentials need refresh before Ask Agent can answer. ${modelCredentialStatus.reason}`;
    }
    return `I received your message, but Ask Agent needs model credentials before it can answer. ${modelCredentialStatus.reason}`;
  }

  private getOrRegisterOwner(
    now: number,
    modelCredentialStatus: BrowserGatewayModelCredentialStatus,
  ): CoreOwnerRegistrationDto {
    const existing = this.ownerRegistry.heartbeat({
      ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      ownerGenerationId: BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID,
      capabilities: getAskAgentCapabilities(modelCredentialStatus),
      now,
    });
    if (existing) return existing;

    return this.ownerRegistry.register({
      ownerId: BROWSER_GATEWAY_ASK_AGENT_OWNER_ID,
      ownerKind: "browser-gateway",
      displayName: "Browser Gateway Ask Agent",
      scope: {
        kind: "projectless",
        scopeId: BROWSER_GATEWAY_ASK_AGENT_SCOPE_ID,
        displayName: "Ask Agent",
      },
      ownerGenerationId: BROWSER_GATEWAY_ASK_AGENT_OWNER_GENERATION_ID,
      capabilities: getAskAgentCapabilities(modelCredentialStatus),
      processId: process.pid,
      now,
    });
  }
}
