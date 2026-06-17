import * as vscode from "vscode";

import type { ApprovalRequest } from "../approvals/webview/types.js";
import type { McpUrlElicitationRequest } from "../shared/mcpUrlElicitation.js";
import type { Question } from "./webview/types.js";

export type AgentUiEvent =
  | { type: "showApproval"; request: ApprovalRequest }
  | { type: "idle" }
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
  | { type: "agentUrlElicitationRequest"; request: McpUrlElicitationRequest }
  | { type: "agentUrlElicitationCleared"; id: string };

export interface AgentUiPublisher {
  publishApproval(request: ApprovalRequest): void;
  publishApprovalIdle(): void;
  publishQuestionRequest(
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void;
  publishQuestionCleared(id: string): void;
  publishQuestionProgress(progress: {
    id: string;
    step: number;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes: Record<string, string>;
    origin: string;
  }): void;
  publishUrlElicitationRequest(request: McpUrlElicitationRequest): void;
  publishUrlElicitationCleared(id: string): void;
}

export interface ReadableAgentUiEventHub {
  readonly onDidPublish: vscode.Event<AgentUiEvent>;
  getSnapshot(): AgentUiEvent | undefined;
}

export class FanoutAgentUiPublisher implements AgentUiPublisher {
  constructor(private readonly publishers: readonly AgentUiPublisher[]) {}

  publishApproval(request: ApprovalRequest): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishApproval(request);
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }

  publishApprovalIdle(): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishApprovalIdle();
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }

  publishQuestionRequest(
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishQuestionRequest(
          id,
          context,
          questions,
          backgroundTask,
        );
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }

  publishQuestionCleared(id: string): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishQuestionCleared(id);
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }

  publishQuestionProgress(progress: {
    id: string;
    step: number;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes: Record<string, string>;
    origin: string;
  }): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishQuestionProgress(progress);
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }

  publishUrlElicitationRequest(request: McpUrlElicitationRequest): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishUrlElicitationRequest(request);
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }

  publishUrlElicitationCleared(id: string): void {
    for (const publisher of this.publishers) {
      try {
        publisher.publishUrlElicitationCleared(id);
      } catch {
        // Keep other sinks alive even if one publisher fails.
      }
    }
  }
}

export class WebviewAgentUiPublisher implements AgentUiPublisher {
  constructor(
    private readonly publishMessage: (message: AgentUiEvent) => void,
  ) {}

  publishApproval(request: ApprovalRequest): void {
    this.publishMessage({ type: "showApproval", request });
  }

  publishApprovalIdle(): void {
    this.publishMessage({ type: "idle" });
  }

  publishQuestionRequest(
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void {
    this.publishMessage({
      type: "agentQuestionRequest",
      id,
      context,
      questions,
      ...(backgroundTask ? { backgroundTask } : {}),
    });
  }

  publishQuestionCleared(id: string): void {
    this.publishMessage({ type: "agentQuestionCleared", id });
  }

  publishQuestionProgress(progress: {
    id: string;
    step: number;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes: Record<string, string>;
    origin: string;
  }): void {
    this.publishMessage({ type: "agentQuestionProgress", ...progress });
  }

  publishUrlElicitationRequest(request: McpUrlElicitationRequest): void {
    this.publishMessage({ type: "agentUrlElicitationRequest", request });
  }

  publishUrlElicitationCleared(id: string): void {
    this.publishMessage({ type: "agentUrlElicitationCleared", id });
  }
}

export class InMemoryAgentUiEventHub
  implements AgentUiPublisher, ReadableAgentUiEventHub, vscode.Disposable
{
  private readonly eventEmitter = new vscode.EventEmitter<AgentUiEvent>();
  private lastEvent: AgentUiEvent | undefined;

  readonly onDidPublish = this.eventEmitter.event;

  getSnapshot(): AgentUiEvent | undefined {
    return this.lastEvent;
  }

  publishApproval(request: ApprovalRequest): void {
    this.publish({ type: "showApproval", request });
  }

  publishApprovalIdle(): void {
    this.publish({ type: "idle" });
  }

  publishQuestionRequest(
    id: string,
    context: string,
    questions: Question[],
    backgroundTask?: string,
  ): void {
    this.publish({
      type: "agentQuestionRequest",
      id,
      context,
      questions,
      ...(backgroundTask ? { backgroundTask } : {}),
    });
  }

  publishQuestionCleared(id: string): void {
    this.publish({ type: "agentQuestionCleared", id });
  }

  publishQuestionProgress(progress: {
    id: string;
    step: number;
    answers: Record<string, string | string[] | number | boolean | undefined>;
    notes: Record<string, string>;
    origin: string;
  }): void {
    this.publish({ type: "agentQuestionProgress", ...progress });
  }

  publishUrlElicitationRequest(request: McpUrlElicitationRequest): void {
    this.publish({ type: "agentUrlElicitationRequest", request });
  }

  publishUrlElicitationCleared(id: string): void {
    this.publish({ type: "agentUrlElicitationCleared", id });
  }

  dispose(): void {
    this.lastEvent = undefined;
    this.eventEmitter.dispose();
  }

  private publish(event: AgentUiEvent): void {
    this.lastEvent = event;
    this.eventEmitter.fire(event);
  }
}
