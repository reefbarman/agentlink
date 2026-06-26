import type {
  McpConfigEntrySummary,
  McpConfigSnapshot,
  McpManagerScope,
  McpManagerServerDraft,
  McpManagerStatusInfo,
  McpManagerView,
} from "../mcpManagerTypes";
import { useEffect, useMemo, useState } from "preact/hooks";

import type { ComponentChildren } from "preact";

interface McpManagerPanelProps {
  snapshot: McpConfigSnapshot;
  initialView?: McpManagerView;
  error?: string | null;
  onClose?: () => void;
  onRefresh?: () => void;
  onServerAction?: (
    serverName: string,
    action: "disable" | "reconnect" | "reauthenticate",
  ) => void;
  onOpenRawConfig?: (scope: McpManagerScope) => void;
  onSaveServer?: (
    scope: McpManagerScope,
    server: McpManagerServerDraft,
  ) => void;
  onRemoveServer?: (scope: McpManagerScope, serverName: string) => void;
}

function statusIcon(status: string): string {
  if (status === "connected") return "codicon-pass-filled";
  if (status === "connecting") return "codicon-sync";
  if (status === "disabled") return "codicon-circle-slash";
  return "codicon-error";
}

function statusDetail(info: McpManagerStatusInfo): string {
  if (info.status !== "connected") return info.error ?? info.status;
  return [
    `${info.toolCount} tool${info.toolCount === 1 ? "" : "s"}`,
    `${info.resourceCount} resource${info.resourceCount === 1 ? "" : "s"}`,
    `${info.promptCount} prompt${info.promptCount === 1 ? "" : "s"}`,
  ].join(" · ");
}

function splitWords(value: string): string[] | undefined {
  const items = value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function splitLines(value: string): string[] | undefined {
  const items = value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function joinLines(value: string[] | undefined): string {
  return value?.join("\n") ?? "";
}

function editableScopeLabel(scope: McpManagerScope): string {
  if (scope === "ask-agent-global") return "Ask Agent";
  if (scope === "project") return "Project";
  return "Global";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ComponentChildren;
}) {
  return (
    <label class="mcp-manager-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ServerForm({
  entry,
  scopes,
  defaultScope,
  onCancel,
  onSave,
}: {
  entry?: McpConfigEntrySummary;
  scopes: McpManagerScope[];
  defaultScope?: McpManagerScope;
  onCancel: () => void;
  onSave: (scope: McpManagerScope, server: McpManagerServerDraft) => void;
}) {
  const [scope, setScope] = useState<McpManagerScope>(
    defaultScope ?? scopes[0] ?? "global",
  );
  const [name, setName] = useState(entry?.name ?? "");
  const [type, setType] = useState<McpManagerServerDraft["type"]>(
    entry?.config.type ?? "stdio",
  );
  const [command, setCommand] = useState(entry?.config.command ?? "");
  const [args, setArgs] = useState(entry?.config.args?.join(" ") ?? "");
  const [url, setUrl] = useState(entry?.config.url ?? "");
  const [timeout, setTimeoutValue] = useState(
    entry?.config.timeout ? String(entry.config.timeout) : "",
  );
  const [toolPolicy, setToolPolicy] = useState(
    entry?.config.toolPolicy ?? "ask",
  );
  const [toolDisclosure, setToolDisclosure] = useState(
    entry?.config.toolDisclosure ?? "auto",
  );
  const [allowedTools, setAllowedTools] = useState(
    joinLines(entry?.config.allowedTools),
  );

  const isHttp =
    type === "sse" || type === "streamable-http" || type === "http";

  return (
    <form
      class="mcp-manager-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(scope, {
          name,
          type,
          command: isHttp ? undefined : command,
          args: isHttp ? undefined : splitWords(args),
          url: isHttp ? url : undefined,
          timeout: timeout.trim() ? Number(timeout) : undefined,
          toolPolicy: toolPolicy as "ask" | "allow",
          toolDisclosure: toolDisclosure as "inline" | "deferred" | "auto",
          allowedTools: splitLines(allowedTools),
        });
      }}
    >
      <Field label="Save to">
        <select
          value={scope}
          onInput={(event) =>
            setScope(event.currentTarget.value as McpManagerScope)
          }
        >
          {scopes.map((item) => (
            <option key={item} value={item}>
              {editableScopeLabel(item)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Server name">
        <input
          value={name}
          disabled={Boolean(entry)}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <Field label="Transport">
        <select
          value={type}
          onInput={(event) =>
            setType(event.currentTarget.value as McpManagerServerDraft["type"])
          }
        >
          <option value="stdio">stdio</option>
          <option value="streamable-http">streamable-http</option>
          <option value="sse">sse</option>
        </select>
      </Field>
      {isHttp ? (
        <Field label="URL">
          <input
            value={url}
            placeholder="https://example.com/mcp"
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
        </Field>
      ) : (
        <>
          <Field label="Command">
            <input
              value={command}
              placeholder="npx"
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
          </Field>
          <Field label="Arguments">
            <input
              value={args}
              placeholder="-y @modelcontextprotocol/server-example"
              onInput={(event) => setArgs(event.currentTarget.value)}
            />
          </Field>
        </>
      )}
      <Field label="Timeout (ms)">
        <input
          value={timeout}
          inputMode="numeric"
          placeholder="60000"
          onInput={(event) => setTimeoutValue(event.currentTarget.value)}
        />
      </Field>
      <Field label="Tool policy">
        <select
          value={toolPolicy}
          onInput={(event) =>
            setToolPolicy(event.currentTarget.value as "ask" | "allow")
          }
        >
          <option value="ask">Ask before new tools</option>
          <option value="allow">Allow all tools</option>
        </select>
      </Field>
      <Field label="Tool disclosure">
        <select
          value={toolDisclosure}
          onInput={(event) =>
            setToolDisclosure(
              event.currentTarget.value as "inline" | "deferred" | "auto",
            )
          }
        >
          <option value="auto">Auto</option>
          <option value="inline">Inline</option>
          <option value="deferred">Deferred</option>
        </select>
      </Field>
      <Field label="Always allowed tools">
        <textarea
          value={allowedTools}
          rows={3}
          placeholder="one tool name per line"
          onInput={(event) => setAllowedTools(event.currentTarget.value)}
        />
      </Field>
      {entry?.hasSecrets && (
        <p class="mcp-manager-note">
          This server has env/header secrets. Non-secret edits preserve raw
          config access as the advanced path for reviewing or replacing secrets.
        </p>
      )}
      <div class="mcp-manager-form-actions">
        <button type="submit">Save server</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function McpManagerPanel({
  snapshot,
  initialView = "status",
  error,
  onClose,
  onRefresh,
  onServerAction,
  onOpenRawConfig,
  onSaveServer,
  onRemoveServer,
}: McpManagerPanelProps) {
  const [view, setView] = useState<McpManagerView>(initialView);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingServer, setEditingServer] = useState<string | null>(null);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  const editableScopes = useMemo(
    () =>
      snapshot.sources
        .filter((source) => source.editable)
        .map((source) => source.scope),
    [snapshot.sources],
  );
  const editingEntry = snapshot.entries.find(
    (entry) => entry.name === editingServer,
  );

  const showStatus = view === "status";
  const showConfig = view === "config";
  const showForm = view === "add" || view === "edit";

  return (
    <div class="mcp-manager-panel">
      <div class="mcp-status-header mcp-manager-header">
        <i class="codicon codicon-server" />
        <span>
          {snapshot.profile === "ask-agent"
            ? "Ask Agent MCP Manager"
            : "MCP Manager"}
        </span>
        <span class="mcp-manager-profile">
          {snapshot.profile === "ask-agent" ? "Ask Agent" : "VS Code"}
        </span>
        <button
          class="mcp-status-close icon-button"
          onClick={onClose}
          title="Dismiss"
        >
          <i class="codicon codicon-close" />
        </button>
      </div>
      <div class="mcp-manager-tabs">
        <button
          class={showStatus ? "active" : ""}
          onClick={() => setView("status")}
        >
          Status
        </button>
        <button
          class={showConfig ? "active" : ""}
          onClick={() => setView("config")}
        >
          Config
        </button>
        {snapshot.capabilities.canEditConfig && (
          <button
            class={view === "add" ? "active" : ""}
            onClick={() => setView("add")}
          >
            Add server
          </button>
        )}
        <button onClick={onRefresh}>Refresh</button>
      </div>
      {error && <p class="mcp-status-empty">{error}</p>}
      {snapshot.unavailableReason && (
        <p class="mcp-status-empty">{snapshot.unavailableReason}</p>
      )}

      {showStatus &&
        (snapshot.statusInfos.length === 0 ? (
          <p class="mcp-status-empty">No MCP servers configured.</p>
        ) : (
          <ul class="mcp-status-list">
            {snapshot.statusInfos.map((info) => (
              <li
                key={info.name}
                class={`mcp-status-item mcp-status-${info.status}`}
              >
                <div class="mcp-status-row">
                  <button
                    class="mcp-status-expand icon-button"
                    disabled={
                      info.tools.length === 0 && !expandedServers.has(info.name)
                    }
                    aria-expanded={expandedServers.has(info.name)}
                    title={
                      expandedServers.has(info.name)
                        ? "Hide tools"
                        : "Show tools"
                    }
                    onClick={() => {
                      setExpandedServers((current) => {
                        const next = new Set(current);
                        if (next.has(info.name)) next.delete(info.name);
                        else next.add(info.name);
                        return next;
                      });
                    }}
                  >
                    <i
                      class={`codicon codicon-chevron-${expandedServers.has(info.name) ? "down" : "right"}`}
                    />
                  </button>
                  <i class={`codicon ${statusIcon(info.status)}`} />
                  <span class="mcp-status-name">{info.name}</span>
                  <span class="mcp-status-detail">{statusDetail(info)}</span>
                  <span class="mcp-status-actions">
                    {snapshot.capabilities.canReconnect &&
                      info.status !== "connecting" && (
                        <button
                          class="icon-button"
                          title="Reconnect"
                          onClick={() =>
                            onServerAction?.(info.name, "reconnect")
                          }
                        >
                          <i class="codicon codicon-refresh" />
                        </button>
                      )}
                    {snapshot.capabilities.canReauthenticate && (
                      <button
                        class="icon-button"
                        title="Reauthenticate"
                        onClick={() =>
                          onServerAction?.(info.name, "reauthenticate")
                        }
                      >
                        <i class="codicon codicon-key" />
                      </button>
                    )}
                    {snapshot.capabilities.canDisable &&
                      info.status !== "disabled" && (
                        <button
                          class="icon-button"
                          title="Disable"
                          onClick={() => onServerAction?.(info.name, "disable")}
                        >
                          <i class="codicon codicon-circle-slash" />
                        </button>
                      )}
                  </span>
                </div>
                {expandedServers.has(info.name) && (
                  <ul class="mcp-tool-list">
                    {info.tools.length === 0 ? (
                      <li class="mcp-tool-empty">No tools available.</li>
                    ) : (
                      info.tools.map((tool) => (
                        <li key={tool.name} class="mcp-tool-item">
                          <span>{tool.name}</span>
                          {tool.description && (
                            <small>{tool.description}</small>
                          )}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ))}

      {showConfig && (
        <div class="mcp-manager-config">
          <div class="mcp-manager-section">
            <h3>Config sources</h3>
            <ul class="mcp-manager-sources">
              {snapshot.sources.map((source) => (
                <li key={source.id}>
                  <span>{source.label}</span>
                  <span class="mcp-manager-source-badges">
                    <code>{source.exists ? "exists" : "missing"}</code>
                    <code>{source.editable ? "editable" : "read-only"}</code>
                    {source.inherited && <code>inherited</code>}
                    {snapshot.capabilities.canOpenRawConfig &&
                      source.editable && (
                        <button onClick={() => onOpenRawConfig?.(source.scope)}>
                          Open raw
                        </button>
                      )}
                  </span>
                  <small>{source.path}</small>
                </li>
              ))}
            </ul>
          </div>
          <div class="mcp-manager-section">
            <h3>Servers</h3>
            {snapshot.entries.length === 0 ? (
              <p class="mcp-status-empty">No MCP servers configured.</p>
            ) : (
              <ul class="mcp-manager-entries">
                {snapshot.entries.map((entry) => (
                  <li key={entry.name}>
                    <div>
                      <strong>{entry.name}</strong>
                      <span>{entry.config.type ?? "stdio"}</span>
                      {entry.inherited && <code>inherited</code>}
                      {entry.hasSecrets && <code>secrets redacted</code>}
                    </div>
                    <small>
                      {entry.config.command ??
                        entry.config.url ??
                        "policy override"}
                    </small>
                    {snapshot.capabilities.canEditConfig &&
                      entry.preferredEditScope && (
                        <span class="mcp-status-actions">
                          <button
                            onClick={() => {
                              setEditingServer(entry.name);
                              setView("edit");
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() =>
                              onRemoveServer?.(
                                entry.preferredEditScope!,
                                entry.name,
                              )
                            }
                          >
                            Remove
                          </button>
                        </span>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <ServerForm
          entry={view === "edit" ? editingEntry : undefined}
          scopes={
            view === "edit"
              ? (editingEntry?.editableScopes ?? editableScopes)
              : editableScopes
          }
          defaultScope={
            view === "edit"
              ? editingEntry?.preferredEditScope
              : editableScopes[0]
          }
          onCancel={() => setView("config")}
          onSave={(scope, server) => {
            onSaveServer?.(scope, server);
            setEditingServer(null);
            setView("config");
          }}
        />
      )}
    </div>
  );
}
