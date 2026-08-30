import type {
  AgentPluginManagerAction,
  AgentPluginManagerRow,
  AgentPluginManagerSnapshot,
} from "@agentlink/protocol/agent-plugin-manager";
import { useEffect, useMemo, useState } from "preact/hooks";

export interface AgentPluginManagerPanelProps {
  snapshot: AgentPluginManagerSnapshot;
  onClose?: () => void;
  onRefresh?: () => void;
  onSelectProject?: (projectId: string) => void;
  onInstall?: (source: string) => void;
  onAction?: (
    row: AgentPluginManagerRow,
    action: AgentPluginManagerAction,
  ) => void;
}

type View = "installed" | "install" | "diagnostics";

function statusIcon(status: AgentPluginManagerRow["status"]): string {
  if (status === "enabled") return "codicon-pass-filled";
  if (status === "disabled") return "codicon-circle-slash";
  if (status === "declared") return "codicon-cloud-download";
  if (status === "shadowed") return "codicon-layers";
  return "codicon-warning";
}

function actionLabel(action: AgentPluginManagerAction): string {
  switch (action) {
    case "enable":
      return "Enable";
    case "disable":
      return "Disable";
    case "reinstall":
      return "Reinstall";
    case "rollback":
      return "Rollback";
    case "uninstall":
      return "Uninstall";
    case "remove-data":
      return "Remove data";
    case "install-declared":
      return "Install";
  }
}

function rowActions(
  row: AgentPluginManagerRow,
  snapshot: AgentPluginManagerSnapshot,
): AgentPluginManagerAction[] {
  if (row.status === "declared") {
    return snapshot.capabilities.canInstall ? ["install-declared"] : [];
  }
  const actions: AgentPluginManagerAction[] = [];
  if (snapshot.capabilities.canEnable && row.enabled !== undefined) {
    actions.push(row.enabled ? "disable" : "enable");
  }
  if (snapshot.capabilities.canReinstall) actions.push("reinstall");
  if (snapshot.capabilities.canRollback && row.previousDigest) {
    actions.push("rollback");
  }
  if (snapshot.capabilities.canUninstall) actions.push("uninstall");
  if (snapshot.capabilities.canRemoveData) actions.push("remove-data");
  return actions;
}

function Row({
  row,
  snapshot,
  onAction,
}: {
  row: AgentPluginManagerRow;
  snapshot: AgentPluginManagerSnapshot;
  onAction?: AgentPluginManagerPanelProps["onAction"];
}) {
  const [expanded, setExpanded] = useState(false);
  const actions = rowActions(row, snapshot);
  return (
    <li
      class={`mcp-status-item mcp-manager-server-row plugin-status-${row.status}`}
    >
      <div class="mcp-status-row">
        <button
          class="mcp-status-expand icon-button"
          type="button"
          aria-label={`${expanded ? "Hide" : "Show"} details for ${row.manifestName}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <i
            class={`codicon codicon-chevron-${expanded ? "down" : "right"}`}
            aria-hidden="true"
          />
        </button>
        <i class={`codicon ${statusIcon(row.status)}`} aria-hidden="true" />
        <div class="mcp-manager-server-identity">
          <span class="mcp-status-name">
            {row.manifestName}
            {row.manifestVersion ? ` ${row.manifestVersion}` : ""}
          </span>
          <span class="mcp-status-detail">
            {row.source.label} · {row.skills.length} skill
            {row.skills.length === 1 ? "" : "s"} · {row.mcpServers.length} MCP ·{" "}
            {row.hooks.length} hook{row.hooks.length === 1 ? "" : "s"}
          </span>
        </div>
        <span class="mcp-manager-server-badges">
          <code>{row.status}</code>
          <code>{row.scope}</code>
          {row.source.shareability === "not-shareable" && (
            <code>not shareable</code>
          )}
        </span>
      </div>
      {expanded && (
        <div class="mcp-manager-server-details">
          {row.description && <p>{row.description}</p>}
          <dl>
            {row.installInstanceId && (
              <>
                <dt>Install ID</dt>
                <dd>{row.installInstanceId}</dd>
              </>
            )}
            {row.currentDigest && (
              <>
                <dt>Digest</dt>
                <dd>{row.currentDigest}</dd>
              </>
            )}
            {row.author && (
              <>
                <dt>Author</dt>
                <dd>{row.author}</dd>
              </>
            )}
            {row.license && (
              <>
                <dt>License</dt>
                <dd>{row.license}</dd>
              </>
            )}
          </dl>
          {row.skills.length > 0 && (
            <div>
              <strong>Skills</strong>
              <ul>
                {row.skills.map((skill) => (
                  <li key={skill.name}>
                    <code>{skill.name}</code> — {skill.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {row.mcpServers.length > 0 && (
            <div>
              <strong>MCP servers</strong>
              <ul>
                {row.mcpServers.map((server) => (
                  <li key={server.name}>
                    <code>{server.name}</code> · {server.type} · policy{" "}
                    {server.toolPolicy}
                    {server.command ? ` · ${server.command}` : ""}
                    {server.url ? ` · ${server.url}` : ""}
                    {server.headerNames?.length
                      ? ` · headers: ${server.headerNames.join(", ")}`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {row.hooks.length > 0 && (
            <div>
              <strong>Lifecycle hooks</strong>
              <ul>
                {row.hooks.map((hook, index) => (
                  <li key={`${hook.sourceRelativePath}-${hook.event}-${index}`}>
                    <code>{hook.event}</code>
                    {hook.matcher ? ` · matcher ${hook.matcher}` : ""} ·{" "}
                    {hook.handlerType}
                    {hook.async ? " · async" : ""}
                    {hook.command ? ` · ${hook.command}` : ""}
                  </li>
                ))}
              </ul>
              <p>
                Command hooks execute local code outside AgentLink&apos;s
                command sandbox from the reviewed immutable plugin package.
              </p>
            </div>
          )}
          {row.diagnostics.length > 0 && (
            <div>
              <strong>Diagnostics</strong>
              <ul>
                {row.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`}>
                    {diagnostic.severity}: {diagnostic.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {actions.length > 0 && (
            <div class="pane-actions">
              {actions.map((action) => (
                <button
                  key={action}
                  type="button"
                  class="mcp-manager-button"
                  onClick={() => onAction?.(row, action)}
                >
                  {actionLabel(action)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function AgentPluginManagerPanel({
  snapshot,
  onClose,
  onRefresh,
  onSelectProject,
  onInstall,
  onAction,
}: AgentPluginManagerPanelProps) {
  const [view, setView] = useState<View>("installed");
  const [source, setSource] = useState("");
  useEffect(() => setView("installed"), [snapshot.project?.projectId]);
  const diagnostics = useMemo(
    () => [
      ...snapshot.diagnostics,
      ...snapshot.rows.flatMap((row) =>
        row.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          componentName: diagnostic.componentName ?? row.manifestName,
        })),
      ),
    ],
    [snapshot],
  );
  return (
    <div class="mcp-manager-panel mcp-manager-panel-redesign">
      <header class="mcp-status-header mcp-manager-header">
        <i class="codicon codicon-extensions" aria-hidden="true" />
        <div class="mcp-manager-title">
          <strong>Agent Plugin Manager</strong>
          <span class="mcp-manager-profile">
            {snapshot.readOnlyReason ? "Read-only" : "VS Code"}
          </span>
        </div>
        <button
          class="mcp-status-close icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close Agent Plugin Manager"
        >
          <i class="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {snapshot.project && (
        <label class="mcp-manager-project-selector">
          <span>Project</span>
          {snapshot.projects.length > 1 ? (
            <select
              aria-label="Agent Plugin project"
              value={snapshot.project.projectId}
              onInput={(event) => onSelectProject?.(event.currentTarget.value)}
            >
              {snapshot.projects.map((project) => (
                <option
                  key={project.projectId}
                  value={project.projectId}
                  disabled={project.availability !== "available"}
                >
                  {project.displayName}
                  {project.availability === "available" ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          ) : (
            <strong>{snapshot.project.displayName}</strong>
          )}
        </label>
      )}
      <nav
        class="mcp-manager-tabs mcp-manager-navigation"
        aria-label="Agent Plugin Manager sections"
      >
        {(["installed", "install", "diagnostics"] as const).map((item) => (
          <button
            key={item}
            type="button"
            class={`mcp-manager-button${view === item ? " active" : ""}`}
            disabled={item === "install" && !snapshot.capabilities.canInstall}
            onClick={() => setView(item)}
          >
            {item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
        <button
          type="button"
          class="mcp-manager-button mcp-manager-refresh"
          onClick={onRefresh}
          aria-label="Refresh Agent Plugin Manager"
        >
          <i class="codicon codicon-refresh" aria-hidden="true" />
        </button>
      </nav>
      <p class="mcp-manager-feedback" role="status">
        Use <code>/plugin list</code> to inspect installs,{" "}
        <code>/plugin install &lt;source&gt;</code> to acquire one, or choose{" "}
        <strong>Install</strong> to review a source. Installs remain disabled
        until you approve the trust review.
      </p>
      {snapshot.readOnlyReason && (
        <p class="mcp-manager-feedback" role="status">
          {snapshot.readOnlyReason}
        </p>
      )}
      {view === "installed" && (
        <section class="mcp-manager-overview">
          {snapshot.rows.length === 0 ? (
            <div class="mcp-manager-empty-state">
              <p>No Agent Plugins are installed or declared.</p>
            </div>
          ) : (
            <ul class="mcp-status-list mcp-manager-server-list">
              {snapshot.rows.map((row) => (
                <Row
                  key={
                    row.installInstanceId ??
                    `declared:${row.projectId}:${row.manifestName}`
                  }
                  row={row}
                  snapshot={snapshot}
                  onAction={onAction}
                />
              ))}
            </ul>
          )}
        </section>
      )}
      {view === "install" && snapshot.capabilities.canInstall && (
        <form
          class="mcp-manager-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = source.trim();
            if (value) onInstall?.(value);
          }}
        >
          <label class="mcp-manager-field">
            <span class="mcp-manager-field-label">Plugin source</span>
            <input
              value={source}
              onInput={(event) => setSource(event.currentTarget.value)}
              placeholder="Git URL, archive URL, file URL, directory, manifest, ZIP, or TAR"
            />
            <small class="mcp-manager-field-hint">
              The next step selects a global/project target and opens the full
              trust review.
            </small>
          </label>
          <div class="pane-actions">
            <button
              type="submit"
              class="mcp-manager-button mcp-manager-button-primary"
              disabled={!source.trim()}
            >
              Acquire and review
            </button>
          </div>
        </form>
      )}
      {view === "diagnostics" && (
        <section class="mcp-manager-source-list">
          {diagnostics.length === 0 ? (
            <p>No Agent Plugin diagnostics.</p>
          ) : (
            <ul>
              {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}-${index}`}>
                  <strong>{diagnostic.severity}</strong> · {diagnostic.code}
                  {diagnostic.componentName
                    ? ` · ${diagnostic.componentName}`
                    : ""}
                  <br />
                  {diagnostic.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
