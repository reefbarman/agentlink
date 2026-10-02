import type {
  McpConfigBatchMutation,
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerScope,
  McpManagerView,
} from "@agentlink/protocol/mcp-manager";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { ApprovalRequest } from "@agentlink/protocol/approval-transport";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import type { DesktopMcpManagerOpenRequest } from "../../shared/desktopBridge";
import { LazyMcpManagerPanel } from "./components/LazyMcpManagerPanel";
import { randomId } from "../../shared/randomId";

const emptySnapshot: McpConfigSnapshot = {
  profile: "ask-agent",
  version: 0,
  sources: [],
  entries: [],
  statusInfos: [],
  capabilities: {
    canEditConfig: true,
    canOpenRawConfig: true,
    canReconnect: true,
    canReauthenticate: true,
    canDisable: true,
    canUseProjectConfig: false,
    canWriteSecrets: true,
    canConfigureLocalProcess: true,
  },
};

interface ManagerOperation {
  id: string;
  serverName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  approval: ApprovalRequest | null;
  error?: string;
}

interface DesktopMcpManagerProps {
  authToken: string;
  initialRequest: DesktopMcpManagerOpenRequest;
  initialTheme?: BrowserGatewayThemeSnapshot;
  onClose(): void;
}

export function DesktopMcpManager({
  authToken,
  initialRequest,
  initialTheme,
  onClose,
}: DesktopMcpManagerProps) {
  const bridge = window.agentlinkDesktopShell;
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot>(emptySnapshot);
  const [view, setView] = useState<McpManagerView>(initialRequest.view);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ManagerOperation | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const generation = useRef(0);
  const polling = useRef(false);
  const disposed = useRef(false);

  useEffect(() => {
    const style = document.documentElement.style;
    const variables = initialTheme?.cssVariables ?? {};
    for (const [name, value] of Object.entries(variables)) {
      style.setProperty(name, value);
    }
    return () => {
      for (const name of Object.keys(variables)) style.removeProperty(name);
    };
  }, [initialTheme]);

  const requestStatus = useCallback(
    async (refresh: boolean, nextView?: McpManagerView) => {
      const current = ++generation.current;
      setError(null);
      try {
        const response = await fetch(
          refresh ? "/api/ask-agent/mcp-refresh" : "/api/ask-agent/mcp-config",
          {
            method: refresh ? "POST" : "GET",
            credentials: "same-origin",
            headers: { Authorization: `Bearer ${authToken}` },
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          configSnapshot?: McpConfigSnapshot;
          error?: string;
        };
        if (current !== generation.current) return;
        if (!response.ok || !body.ok || !body.configSnapshot) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        setSnapshot(body.configSnapshot);
        if (nextView) setView(nextView);
      } catch (cause) {
        if (current !== generation.current) return;
        setError(`MCP manager unavailable: ${String(cause)}`);
      }
    },
    [authToken],
  );

  useEffect(() => {
    disposed.current = false;
    void requestStatus(
      initialRequest.action === "refresh",
      initialRequest.view,
    );
    const unsubscribe = bridge?.onMcpManagerOpen?.((request) => {
      setView(request.view);
      void requestStatus(request.action === "refresh", request.view);
    });
    let active = true;
    let timer: number | undefined;
    const refresh = (): void => {
      if (!active) return;
      timer = window.setTimeout(async () => {
        if (!active) return;
        await requestStatus(false);
        refresh();
      }, 10_000);
    };
    refresh();
    return () => {
      active = false;
      disposed.current = true;
      generation.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe?.();
      const pending = operationRef.current;
      if (pending?.status === "running")
        void postOperation({ action: "cancel", operationId: pending.id }).catch(
          () => undefined,
        );
    };
  }, [bridge, initialRequest.action, initialRequest.view, requestStatus]);

  const operationRef = useRef<ManagerOperation | null>(null);

  const postOperation = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch("/api/ask-agent/mcp-manager-operation", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
    },
    [authToken],
  );

  const startOperation = async (
    serverName: string,
    mode: "connect" | "reconnect" | "reauthenticate",
  ): Promise<void> => {
    if (operationRef.current?.status === "running") return;
    const id = randomId();
    const next: ManagerOperation = {
      id,
      serverName,
      status: "running",
      approval: null,
    };
    operationRef.current = next;
    bridge?.setMcpOperation?.(id);
    setOperationError(null);
    try {
      await postOperation({
        action: "start",
        operationId: id,
        serverName,
        mode,
      });
      if (disposed.current) {
        void postOperation({ action: "cancel", operationId: id }).catch(
          () => undefined,
        );
        return;
      }
      setOperation(next);
    } catch (cause) {
      if (disposed.current) return;
      try {
        await postOperation({ action: "cancel", operationId: id });
        operationRef.current = null;
        bridge?.setMcpOperation?.(null);
      } catch {
        setOperation(next);
      }
      setOperationError(
        `Could not start ${mode} for ${serverName}: ${String(cause)}`,
      );
    }
  };

  useEffect(() => {
    const current = operation;
    if (!current || current.status !== "running") return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      if (!active || polling.current) return;
      polling.current = true;
      try {
        const response = await fetch(
          `/api/ask-agent/mcp-manager-operation?operationId=${encodeURIComponent(current.id)}`,
          {
            credentials: "same-origin",
            headers: { Authorization: `Bearer ${authToken}` },
          },
        );
        const body = (await response.json()) as {
          ok?: boolean;
          operation?: ManagerOperation;
          error?: string;
        };
        if (!response.ok || !body.ok || !body.operation || !active) {
          if (!active) return;
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        const result = body.operation;
        if (
          result.id !== current.id ||
          result.serverName !== current.serverName
        ) {
          throw new Error(
            "MCP operation response did not match the active request",
          );
        }
        operationRef.current = result;
        setOperation(result);
        if (result.status !== "running") {
          bridge?.setMcpOperation?.(null);
          void requestStatus(false);
        }
      } catch (cause) {
        if (active)
          setOperationError(
            `MCP operation status unavailable: ${String(cause)}`,
          );
      } finally {
        polling.current = false;
        if (active && operationRef.current?.status === "running") {
          timer = window.setTimeout(() => void poll(), 1_000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authToken, bridge, operation?.id, operation?.status, requestStatus]);

  const dismissOperation = useCallback(() => {
    if (operationRef.current?.status === "running") return;
    operationRef.current = null;
    setOperation(null);
    setOperationError(null);
  }, []);

  useEffect(() => {
    if (operation?.status !== "completed" && operation?.status !== "cancelled")
      return;
    const timer = window.setTimeout(dismissOperation, 5_000);
    return () => window.clearTimeout(timer);
  }, [operation?.id, operation?.status, dismissOperation]);

  const cancelOperation = async (): Promise<void> => {
    const current = operationRef.current;
    if (!current || current.status !== "running") return;
    try {
      await postOperation({ action: "cancel", operationId: current.id });
      bridge?.setMcpOperation?.(null);
      operationRef.current = {
        ...current,
        status: "cancelled",
        approval: null,
      };
      setOperation(operationRef.current);
    } catch (cause) {
      setOperationError(`Could not cancel MCP operation: ${String(cause)}`);
    }
  };

  const decideApproval = async (approval: ApprovalRequest, value: string) => {
    const current = operationRef.current;
    if (!current || !approval.id) return;
    const decision = value === "allow-once" ? "allow-once" : "deny";
    try {
      await postOperation({
        action: "approve",
        operationId: current.id,
        approvalId: approval.id,
        decision,
      });
    } catch (cause) {
      setOperationError(`Could not submit MCP approval: ${String(cause)}`);
    }
  };

  const onMutateConfig = useCallback(
    async (
      mutation: McpConfigBatchMutation,
    ): Promise<McpConfigMutationResult> => {
      setConfigError(null);
      try {
        const response = await fetch("/api/ask-agent/mcp-config/server", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...mutation,
            profile: "ask-agent",
            scope: "ask-agent-global",
            target: {
              kind: "native",
              profile: "ask-agent",
              scope: "ask-agent-global",
            },
          }),
        });
        const result = (await response.json()) as McpConfigMutationResult & {
          reconcileError?: string;
          error?: string;
        };
        if (!response.ok || !result.ok) {
          if (!result.ok && result.errors?.length) {
            setConfigError(
              result.errors.map((item) => item.message).join("; "),
            );
          } else {
            throw new Error(result.error ?? `HTTP ${response.status}`);
          }
        }
        if (result.configSnapshot) {
          generation.current += 1;
          setSnapshot(result.configSnapshot);
        }
        if (result.configSaved && result.reconcileError) {
          setConfigError(
            `Configuration saved, but live servers could not be reconciled: ${result.reconcileError}`,
          );
        }
        return result;
      } catch (cause) {
        setConfigError(`MCP configuration save failed: ${String(cause)}`);
        throw cause instanceof Error ? cause : new Error(String(cause));
      }
    },
    [authToken],
  );

  const onOpenRawConfig = useCallback(
    async (scope: McpManagerScope): Promise<void> => {
      if (scope !== "global" && scope !== "ask-agent-global") return;
      setConfigError(null);
      try {
        await bridge?.openMcpConfig?.(scope);
      } catch (cause) {
        setConfigError(`Could not open MCP configuration: ${String(cause)}`);
      }
    },
    [bridge],
  );

  const onServerAction = (
    serverName: string,
    action: "connect" | "reconnect" | "reauthenticate" | "disable",
  ): void => {
    if (
      action === "connect" ||
      action === "reconnect" ||
      action === "reauthenticate"
    ) {
      void startOperation(serverName, action);
    }
  };

  const request = initialRequest;
  return (
    <main
      class="browser-shell browser-shell-desktop desktop-mcp-manager"
      aria-label="MCP Servers"
    >
      <header class="desktop-mcp-manager-header">
        <div>
          <h1>MCP Servers</h1>
          <p>Manage your server connections</p>
        </div>
        <button
          type="button"
          class="desktop-mcp-manager-close"
          onClick={onClose}
          aria-label="Close MCP Servers"
          title="Close MCP Servers"
        >
          <i class="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {error && (
        <div class="desktop-mcp-manager-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void requestStatus(false)}>
            Retry
          </button>
        </div>
      )}
      {configError && (
        <p class="desktop-mcp-operation-error" role="alert">
          {configError}
        </p>
      )}

      {operationError && (
        <p class="desktop-mcp-operation-error" role="alert">
          {operationError}
        </p>
      )}
      {operation && (
        <section
          class={`desktop-mcp-operation desktop-mcp-operation-${operation.status}`}
          aria-label="MCP server operation"
          aria-live="polite"
        >
          <strong>{operation.serverName}</strong>
          {operation.status === "running" ? (
            <span>Waiting for sign-in or connection…</span>
          ) : (
            <span>Operation {operation.status}</span>
          )}
          {operation.error && <p role="alert">{operation.error}</p>}
          {operation.approval && (
            <div class="approval-panel-embed desktop-mcp-approval">
              <h2>
                {operation.approval.command ??
                  `Allow ${operation.serverName} to open a browser for sign-in?`}
              </h2>
              {operation.approval.mcpDetail && (
                <p>{operation.approval.mcpDetail}</p>
              )}
              <div class="desktop-mcp-approval-actions">
                {(operation.approval.mcpChoices ?? []).map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    disabled={operation.status !== "running"}
                    onClick={() =>
                      void decideApproval(operation.approval!, choice.value)
                    }
                  >
                    {choice.label}
                  </button>
                ))}
                <button
                  type="button"
                  class="secondary"
                  onClick={() => void cancelOperation()}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {operation.status === "running" && !operation.approval && (
            <button
              type="button"
              class="secondary"
              onClick={() => void cancelOperation()}
            >
              Cancel
            </button>
          )}
          {operation.status !== "running" && (
            <button
              type="button"
              class="desktop-mcp-icon-button"
              aria-label="Dismiss MCP operation"
              title="Dismiss"
              onClick={dismissOperation}
            >
              <i class="codicon codicon-close" aria-hidden="true" />
            </button>
          )}
        </section>
      )}
      <section class="desktop-mcp-manager-content">
        <LazyMcpManagerPanel
          snapshot={{
            ...snapshot,
            unavailableReason: undefined,
            capabilities: { ...snapshot.capabilities, canOpenRawConfig: true },
          }}
          initialView={view ?? request.view}
          onRefresh={() => void requestStatus(true)}
          onServerAction={onServerAction}
          onMutateConfig={onMutateConfig}
          onOpenRawConfig={onOpenRawConfig}
        />
      </section>
    </main>
  );
}
