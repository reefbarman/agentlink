import * as vscode from "vscode";

import type { ApprovalRequest } from "../approvals/webview/types.js";
import type { McpFormElicitationRequest } from "../shared/mcpElicitation.js";
import type { McpUrlElicitationRequest } from "../shared/mcpUrlElicitation.js";
import type { Question } from "./webview/types.js";

export type AgentUiEvent =
  | { type: "showApproval"; request: ApprovalRequest }
  | { type: "idle"; id: string }
  | {
      type: "agentQuestionRequest";
      id: string;
      /** Visible explanation shown above structured questions. */
      context: string;
      questions: Question[];
      /** When set, the question is from a background agent with this task name. */
      backgroundTask?: string;
    }
  | { type: "agentQuestionCleared"; id: string }
  | {
      type: "agentQuestionProgress";
      id: string;
      step: number;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
      origin: string;
    }
  | { type: "agentFormElicitationRequest"; request: McpFormElicitationRequest }
  | { type: "agentFormElicitationCleared"; id: string }
  | { type: "agentUrlElicitationRequest"; request: McpUrlElicitationRequest }
  | { type: "agentUrlElicitationCleared"; id: string };

type QuestionAgentUiEvent = Extract<
  AgentUiEvent,
  {
    type:
      | "agentQuestionRequest"
      | "agentQuestionCleared"
      | "agentQuestionProgress";
  }
>;

type ApprovalAgentUiEvent = Extract<
  AgentUiEvent,
  { type: "showApproval" | "idle" }
>;
type AddressedAgentUiEvent = QuestionAgentUiEvent | ApprovalAgentUiEvent;

type WebviewAgentUiMessage =
  | Exclude<AgentUiEvent, AddressedAgentUiEvent>
  | (AddressedAgentUiEvent & { sessionId?: string });

export interface SessionUiEvent {
  sessionId: string;
  event: AgentUiEvent;
}

export interface AgentUiPublisher {
  publishApproval(sessionId: string, request: ApprovalRequest): void;
  publishApprovalIdle(sessionId: string, id: string): void;
  publishQuestionRequest(
    sessionId: string,
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void;
  publishQuestionCleared(sessionId: string, id: string): void;
  publishQuestionProgress(
    sessionId: string,
    progress: {
      id: string;
      step: number;
      answers: Record<string, string | string[] | number | boolean | undefined>;
      notes: Record<string, string>;
      origin: string;
    },
  ): void;
  publishFormElicitationRequest(
    sessionId: string,
    request: McpFormElicitationRequest,
  ): void;
  publishFormElicitationCleared(sessionId: string, id: string): void;
  publishUrlElicitationRequest(
    sessionId: string,
    request: McpUrlElicitationRequest,
  ): void;
  publishUrlElicitationCleared(sessionId: string, id: string): void;
}

export interface ReadableAgentUiEventHub {
  readonly onDidPublish: vscode.Event<SessionUiEvent>;
  getSnapshot(sessionId: string): readonly SessionUiEvent[];
}

export class FanoutAgentUiPublisher implements AgentUiPublisher {
  constructor(private readonly publishers: readonly AgentUiPublisher[]) {}

  publishApproval(sessionId: string, request: ApprovalRequest): void {
    this.publish((publisher) => publisher.publishApproval(sessionId, request));
  }

  publishApprovalIdle(sessionId: string, id: string): void {
    this.publish((publisher) => publisher.publishApprovalIdle(sessionId, id));
  }

  publishQuestionRequest(
    sessionId: string,
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void {
    this.publish((publisher) =>
      publisher.publishQuestionRequest(
        sessionId,
        id,
        context,
        questions,
        backgroundTask,
      ),
    );
  }

  publishQuestionCleared(sessionId: string, id: string): void {
    this.publish((publisher) =>
      publisher.publishQuestionCleared(sessionId, id),
    );
  }

  publishQuestionProgress(
    sessionId: string,
    progress: Parameters<AgentUiPublisher["publishQuestionProgress"]>[1],
  ): void {
    this.publish((publisher) =>
      publisher.publishQuestionProgress(sessionId, progress),
    );
  }

  publishFormElicitationRequest(
    sessionId: string,
    request: McpFormElicitationRequest,
  ): void {
    this.publish((publisher) =>
      publisher.publishFormElicitationRequest(sessionId, request),
    );
  }

  publishFormElicitationCleared(sessionId: string, id: string): void {
    this.publish((publisher) =>
      publisher.publishFormElicitationCleared(sessionId, id),
    );
  }

  publishUrlElicitationRequest(
    sessionId: string,
    request: McpUrlElicitationRequest,
  ): void {
    this.publish((publisher) =>
      publisher.publishUrlElicitationRequest(sessionId, request),
    );
  }

  publishUrlElicitationCleared(sessionId: string, id: string): void {
    this.publish((publisher) =>
      publisher.publishUrlElicitationCleared(sessionId, id),
    );
  }

  private publish(action: (publisher: AgentUiPublisher) => void): void {
    for (const publisher of this.publishers) {
      try {
        action(publisher);
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }
}

export class WebviewAgentUiPublisher implements AgentUiPublisher {
  private readonly globalApprovalIds = new Set<string>();
  private readonly globalQuestionIds = new Set<string>();

  constructor(
    private readonly publishMessage: (message: WebviewAgentUiMessage) => void,
  ) {}

  publishApproval(sessionId: string, request: ApprovalRequest): void {
    if (request.backgroundTask) this.globalApprovalIds.add(request.id);
    else this.globalApprovalIds.delete(request.id);
    this.publishMessage({
      type: "showApproval",
      ...this.approvalSessionAddress(sessionId, request.id),
      request,
    });
  }

  publishApprovalIdle(sessionId: string, id: string): void {
    this.publishMessage({
      type: "idle",
      ...this.approvalSessionAddress(sessionId, id),
      id,
    });
    this.globalApprovalIds.delete(id);
  }

  publishQuestionRequest(
    sessionId: string,
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void {
    if (backgroundTask) this.globalQuestionIds.add(id);
    else this.globalQuestionIds.delete(id);
    this.publishMessage({
      type: "agentQuestionRequest",
      ...this.questionSessionAddress(sessionId, id),
      id,
      context,
      questions,
      ...(backgroundTask ? { backgroundTask } : {}),
    });
  }

  publishQuestionCleared(sessionId: string, id: string): void {
    this.publishMessage({
      type: "agentQuestionCleared",
      ...this.questionSessionAddress(sessionId, id),
      id,
    });
    this.globalQuestionIds.delete(id);
  }

  publishQuestionProgress(
    sessionId: string,
    progress: Parameters<AgentUiPublisher["publishQuestionProgress"]>[1],
  ): void {
    this.publishMessage({
      type: "agentQuestionProgress",
      ...this.questionSessionAddress(sessionId, progress.id),
      ...progress,
    });
  }

  private approvalSessionAddress(
    sessionId: string,
    approvalId: string,
  ): { sessionId?: string } {
    return this.globalApprovalIds.has(approvalId) ? {} : { sessionId };
  }

  private questionSessionAddress(
    sessionId: string,
    questionId: string,
  ): { sessionId?: string } {
    return this.globalQuestionIds.has(questionId) ? {} : { sessionId };
  }

  publishFormElicitationRequest(
    _sessionId: string,
    request: McpFormElicitationRequest,
  ): void {
    this.publishMessage({ type: "agentFormElicitationRequest", request });
  }

  publishFormElicitationCleared(_sessionId: string, id: string): void {
    this.publishMessage({ type: "agentFormElicitationCleared", id });
  }

  publishUrlElicitationRequest(
    _sessionId: string,
    request: McpUrlElicitationRequest,
  ): void {
    this.publishMessage({ type: "agentUrlElicitationRequest", request });
  }

  publishUrlElicitationCleared(_sessionId: string, id: string): void {
    this.publishMessage({ type: "agentUrlElicitationCleared", id });
  }
}

export class InMemoryAgentUiEventHub
  implements AgentUiPublisher, ReadableAgentUiEventHub, vscode.Disposable
{
  private readonly eventEmitter = new vscode.EventEmitter<SessionUiEvent>();
  private readonly pendingEventsBySession = new Map<
    string,
    Map<string, AgentUiEvent>
  >();

  readonly onDidPublish = this.eventEmitter.event;

  getSnapshot(sessionId: string): readonly SessionUiEvent[] {
    return [
      ...(this.pendingEventsBySession.get(sessionId)?.values() ?? []),
    ].map((event) => ({ sessionId, event: cloneEvent(event) }));
  }

  publishApproval(sessionId: string, request: ApprovalRequest): void {
    this.publish(sessionId, { type: "showApproval", request });
  }

  publishApprovalIdle(sessionId: string, id: string): void {
    this.publish(sessionId, { type: "idle", id });
  }

  publishQuestionRequest(
    sessionId: string,
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void {
    this.publish(sessionId, {
      type: "agentQuestionRequest",
      id,
      context,
      questions,
      ...(backgroundTask ? { backgroundTask } : {}),
    });
  }

  publishQuestionCleared(sessionId: string, id: string): void {
    this.publish(sessionId, { type: "agentQuestionCleared", id });
  }

  publishQuestionProgress(
    sessionId: string,
    progress: Parameters<AgentUiPublisher["publishQuestionProgress"]>[1],
  ): void {
    this.publish(sessionId, { type: "agentQuestionProgress", ...progress });
  }

  publishFormElicitationRequest(
    sessionId: string,
    request: McpFormElicitationRequest,
  ): void {
    this.publish(sessionId, { type: "agentFormElicitationRequest", request });
  }

  publishFormElicitationCleared(sessionId: string, id: string): void {
    this.publish(sessionId, { type: "agentFormElicitationCleared", id });
  }

  publishUrlElicitationRequest(
    sessionId: string,
    request: McpUrlElicitationRequest,
  ): void {
    this.publish(sessionId, { type: "agentUrlElicitationRequest", request });
  }

  publishUrlElicitationCleared(sessionId: string, id: string): void {
    this.publish(sessionId, { type: "agentUrlElicitationCleared", id });
  }

  dispose(): void {
    this.pendingEventsBySession.clear();
    this.eventEmitter.dispose();
  }

  private publish(sessionId: string, event: AgentUiEvent): void {
    this.updatePendingEvents(sessionId, event);
    this.eventEmitter.fire({ sessionId, event: cloneEvent(event) });
  }

  private updatePendingEvents(sessionId: string, event: AgentUiEvent): void {
    const pending =
      this.pendingEventsBySession.get(sessionId) ??
      new Map<string, AgentUiEvent>();
    this.pendingEventsBySession.set(sessionId, pending);

    switch (event.type) {
      case "showApproval":
        setLatest(pending, `approval:${event.request.id}`, event);
        break;
      case "idle":
        pending.delete(`approval:${event.id}`);
        break;
      case "agentQuestionRequest":
        setLatest(pending, `question:${event.id}`, event);
        break;
      case "agentQuestionCleared":
        pending.delete(`question:${event.id}`);
        pending.delete(`question-progress:${event.id}`);
        break;
      case "agentQuestionProgress":
        if (pending.has(`question:${event.id}`)) {
          setLatest(pending, `question-progress:${event.id}`, event);
        }
        break;
      case "agentFormElicitationRequest":
        setLatest(pending, `form:${event.request.id}`, event);
        break;
      case "agentFormElicitationCleared":
        pending.delete(`form:${event.id}`);
        break;
      case "agentUrlElicitationRequest":
        setLatest(pending, `url:${event.request.id}`, event);
        break;
      case "agentUrlElicitationCleared":
        pending.delete(`url:${event.id}`);
        break;
    }

    if (pending.size === 0) this.pendingEventsBySession.delete(sessionId);
  }
}

function setLatest(
  pending: Map<string, AgentUiEvent>,
  key: string,
  event: AgentUiEvent,
): void {
  pending.delete(key);
  pending.set(key, cloneEvent(event));
}

function cloneEvent(event: AgentUiEvent): AgentUiEvent {
  return structuredClone(event);
}
