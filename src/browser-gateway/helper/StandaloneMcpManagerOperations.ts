import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";

export interface StandaloneMcpManagerOperation {
  readonly id: string;
  readonly serverName: string;
  readonly mode: "connect" | "reconnect" | "reauthenticate";
  status: "running" | "completed" | "failed" | "cancelled";
  approval: ApprovalRequest | null;
  error?: string;
}

interface ActiveOperation {
  readonly state: StandaloneMcpManagerOperation;
  readonly controller: AbortController;
  settled: boolean;
}

/** Manual MCP sign-in belongs to its manager window, not the selected chat. */
export class StandaloneMcpManagerOperations {
  private operation: ActiveOperation | undefined;
  private readonly cancelledOperationIds = new Set<string>();

  constructor(
    private readonly options: {
      canStart: () => boolean;
      connect: (
        serverName: string,
        signal: AbortSignal,
        reconnect: boolean,
      ) => Promise<void>;
      reauthenticate: (
        serverName: string,
        confirm: (origin: string) => Promise<boolean>,
        signal: AbortSignal,
      ) => Promise<void>;
      onSettled: () => void;
    },
  ) {}

  isRunning(): boolean {
    return Boolean(this.operation && !this.operation.settled);
  }

  get(operationId: string): StandaloneMcpManagerOperation | undefined {
    return this.operation?.state.id === operationId
      ? structuredClone(this.operation.state)
      : undefined;
  }

  start(
    operationId: string,
    serverName: string,
    mode: StandaloneMcpManagerOperation["mode"] = "reauthenticate",
  ): void {
    if (this.cancelledOperationIds.has(operationId))
      throw new Error("desktop_mcp_operation_cancelled");
    if (this.isRunning() || !this.options.canStart())
      throw new Error("desktop_mcp_busy");
    if (this.operation?.state.id === operationId)
      throw new Error("desktop_mcp_operation_already_used");
    const operation: ActiveOperation = {
      state: {
        id: operationId,
        serverName,
        mode,
        status: "running",
        approval: null,
      },
      controller: new AbortController(),
      settled: false,
    };
    this.operation = operation;
    void Promise.resolve()
      .then(() => {
        operation.controller.signal.throwIfAborted();
        if (mode !== "reauthenticate")
          return this.options.connect(
            serverName,
            operation.controller.signal,
            mode === "reconnect",
          );
        return this.options.reauthenticate(
          serverName,
          async () => !operation.controller.signal.aborted,
          operation.controller.signal,
        );
      })
      .then(
        () => {
          if (!operation.controller.signal.aborted)
            operation.state.status = "completed";
        },
        (error: unknown) => {
          if (operation.controller.signal.aborted) return;
          operation.state.status = "failed";
          operation.state.error = String(error).slice(0, 500);
        },
      )
      .finally(() => {
        operation.settled = true;
        operation.state.approval = null;

        this.options.onSettled();
      });
  }

  authorize(request: {
    serverName: string;
    signal: AbortSignal | undefined;
  }): Promise<boolean> {
    const operation = this.operation;
    if (
      !operation ||
      operation.state.status !== "running" ||
      operation.state.serverName !== request.serverName ||
      request.signal !== operation.controller.signal
    )
      return Promise.resolve(false);
    return Promise.resolve(!operation.controller.signal.aborted);
  }

  respond(
    _operationId: string,
    _approvalId: string,
    _allowed: boolean,
  ): boolean {
    // Older clients may submit a confirmation, but sign-in no longer queues one.
    return false;
  }

  cancel(operationId: string): boolean {
    this.cancelledOperationIds.add(operationId);
    if (this.cancelledOperationIds.size > 64)
      this.cancelledOperationIds.delete(
        this.cancelledOperationIds.values().next().value!,
      );
    const operation = this.operation;
    if (
      operation?.state.id !== operationId ||
      operation.state.status !== "running"
    )
      return false;
    operation.state.status = "cancelled";
    operation.controller.abort();

    operation.state.approval = null;
    return true;
  }

  dispose(): void {
    if (this.operation) this.cancel(this.operation.state.id);
  }
}
