import type {
  McpConfigBatchMutation,
  McpConfigConflictAction,
  McpConfigEntrySummary,
  McpConfigMutationResult,
  McpConfigSnapshot,
  McpManagerScope,
  McpManagerServerDraft,
  McpManagerServerWriteDraft,
  McpManagerStatusInfo,
  McpManagerView,
  McpSecretMutationMode,
  McpSecretRecordMutation,
} from "../mcpManagerTypes";
import {
  canonicalDraftToWriteDraft,
  validateMcpServerDraft,
} from "../mcpConfigValidation";
import { useEffect, useMemo, useState } from "preact/hooks";

import type { ComponentChildren } from "preact";
import { parseMcpConfigImport } from "../mcpConfigImport";
import { randomId } from "../randomId";

type PanelView = "overview" | "sources" | "guided" | "import";
type SubmissionState =
  | { kind: "idle" }
  | { kind: "pending"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export interface McpManagerPanelProps {
  snapshot: McpConfigSnapshot;
  initialView?: McpManagerView | PanelView;
  error?: string | null;
  onClose?: () => void;
  onRefresh?: () => void;
  onSelectProject?: (projectId: string) => void;
  onServerAction?: (
    serverName: string,
    action: "disable" | "reconnect" | "reauthenticate",
  ) => void;
  onOpenRawConfig?: (scope: McpManagerScope) => void;
  onMutateConfig?: (
    batch: McpConfigBatchMutation,
  ) => Promise<McpConfigMutationResult>;
  onSaveServer?: (
    scope: McpManagerScope,
    server: McpManagerServerDraft,
  ) => void;
  onRemoveServer?: (scope: McpManagerScope, serverName: string) => void;
}

function normalizeView(view: McpManagerView | PanelView): PanelView {
  if (view === "status") return "overview";
  if (view === "config") return "sources";
  if (view === "add" || view === "edit") return "guided";
  return view;
}

function scopeLabel(scope: McpManagerScope): string {
  if (scope === "ask-agent-global") return "Ask Agent";
  if (scope === "project") return "Project";
  return "Global";
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ").replaceAll("-", " ");
}

function statusIcon(status: string): string {
  if (status === "connected") return "codicon-pass-filled";
  if (status === "connecting") return "codicon-sync";
  if (status === "disabled") return "codicon-circle-slash";
  if (status === "not_connected") return "codicon-circle-outline";
  return "codicon-error";
}

function statusDetail(
  info?: McpManagerStatusInfo,
  configuredDisabled = false,
): string {
  if (configuredDisabled) return "Disabled in configuration";
  if (!info) return "Configured · not connected";
  if (info.status !== "connected")
    return info.error ?? statusLabel(info.status);
  return [
    `${info.toolCount} tool${info.toolCount === 1 ? "" : "s"}`,
    `${info.resourceCount} resource${info.resourceCount === 1 ? "" : "s"}`,
    `${info.promptCount} prompt${info.promptCount === 1 ? "" : "s"}`,
  ].join(" · ");
}

function sourceHealthLabel(
  source: McpConfigSnapshot["sources"][number],
): string {
  if (source.readStatus === "available") return "Healthy";
  if (source.readStatus === "missing") return "Not created";
  if (source.readError === "permission_denied") return "Permission denied";
  if (source.readStatus === "invalid") return "Invalid configuration";
  return "Could not read";
}

function editableScopes(snapshot: McpConfigSnapshot): McpManagerScope[] {
  return snapshot.sources
    .filter((source) => source.editable)
    .sort((left, right) => right.priority - left.priority)
    .map((source) => source.scope)
    .filter((scope, index, all) => all.indexOf(scope) === index);
}

function importCapabilityDiagnostics(
  snapshot: McpConfigSnapshot,
  draft: ReturnType<typeof parseMcpConfigImport>["rows"][number]["draft"],
): string[] {
  return [
    draft?.type === "stdio" &&
    snapshot.capabilities.canConfigureLocalProcess === false
      ? "This host cannot configure local-process servers."
      : undefined,
    (draft?.env || draft?.headers) &&
    snapshot.capabilities.canWriteSecrets === false
      ? "This host cannot import environment variables or headers."
      : undefined,
  ].filter((item): item is string => Boolean(item));
}

function revisionForScope(
  snapshot: McpConfigSnapshot,
  _scope: McpManagerScope,
): string {
  return snapshot.revision ?? "";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <label class="mcp-manager-field">
      <span class="mcp-manager-field-label">{label}</span>
      {children}
      {hint && <small class="mcp-manager-field-hint">{hint}</small>}
    </label>
  );
}

function Feedback({ state }: { state: SubmissionState }) {
  if (state.kind === "idle") return null;
  return (
    <p
      class={`mcp-manager-feedback mcp-manager-feedback-${state.kind}`}
      role={state.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {state.message}
    </p>
  );
}

function parseStringList(
  value: string,
  fieldName: string,
): { value?: string[]; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        !Array.isArray(parsed) ||
        parsed.some((item) => typeof item !== "string")
      ) {
        return { error: `${fieldName} JSON must be an array of strings.` };
      }
      return { value: parsed };
    } catch {
      return { error: `${fieldName} is not a valid JSON string array.` };
    }
  }
  return {
    value: value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function parseKeyValueLines(
  value: string,
  fieldName: string,
): { value?: Record<string, string>; error?: string } {
  const result: Record<string, string> = {};
  for (const [index, rawLine] of value.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return {
        error: `${fieldName} line ${index + 1} must use KEY=value.`,
      };
    }
    const key = line.slice(0, separator).trim();
    if (!key) {
      return { error: `${fieldName} line ${index + 1} has an empty key.` };
    }
    result[key] = line.slice(separator + 1);
  }
  return { value: Object.keys(result).length > 0 ? result : undefined };
}

function parseRemovalLines(value: string): string[] | undefined {
  const keys = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return keys.length > 0 ? [...new Set(keys)] : undefined;
}

function secretMutation(
  mode: McpSecretMutationMode,
  values: string,
  removals: string,
  label: string,
): { value: McpSecretRecordMutation; error?: string } {
  if (mode === "preserve" || mode === "remove") return { value: { mode } };
  const parsed = parseKeyValueLines(values, label);
  if (parsed.error) return { value: { mode }, error: parsed.error };
  if (mode === "replace" && !parsed.value) {
    return {
      value: { mode },
      error: `${label} replacement requires at least one KEY=value pair. Use Remove all values to clear them.`,
    };
  }
  const remove = mode === "patch" ? parseRemovalLines(removals) : undefined;
  return {
    value: {
      mode,
      ...(parsed.value ? { set: parsed.value } : {}),
      ...(remove ? { remove } : {}),
    },
  };
}

function SecretEditor({
  label,
  existingKeys,
  mode,
  values,
  removals,
  disabled,
  onModeChange,
  onValuesChange,
  onRemovalsChange,
}: {
  label: string;
  existingKeys: string[];
  mode: McpSecretMutationMode;
  values: string;
  removals: string;
  disabled: boolean;
  onModeChange: (mode: McpSecretMutationMode) => void;
  onValuesChange: (value: string) => void;
  onRemovalsChange: (value: string) => void;
}) {
  return (
    <fieldset class="mcp-manager-secret-editor" disabled={disabled}>
      <legend>{label}</legend>
      {existingKeys.length > 0 && (
        <p class="mcp-manager-secret-summary">
          Existing keys: {existingKeys.join(", ")}. Values are never displayed.
        </p>
      )}
      <Field label={`${label} update mode`}>
        <select
          value={mode}
          onInput={(event) =>
            onModeChange(event.currentTarget.value as McpSecretMutationMode)
          }
        >
          <option value="preserve">Preserve existing values</option>
          <option value="patch">Set or remove selected keys</option>
          <option value="replace">Replace all values</option>
          <option value="remove">Remove all values</option>
        </select>
      </Field>
      {(mode === "patch" || mode === "replace") && (
        <Field
          label={`${label} values`}
          hint="One KEY=value pair per line. Values may contain additional equals signs."
        >
          <textarea
            value={values}
            rows={3}
            autoComplete="off"
            spellcheck={false}
            placeholder="KEY=value"
            onInput={(event) => onValuesChange(event.currentTarget.value)}
          />
        </Field>
      )}
      {mode === "patch" && (
        <Field label={`${label} keys to remove`} hint="One key per line.">
          <textarea
            value={removals}
            rows={2}
            placeholder="OLD_KEY"
            onInput={(event) => onRemovalsChange(event.currentTarget.value)}
          />
        </Field>
      )}
    </fieldset>
  );
}

function GuidedEditor({
  snapshot,
  entry,
  entries,
  onSelectEntry,
  onCancel,
  onComplete,
  onMutateConfig,
  onSaveServer,
}: {
  snapshot: McpConfigSnapshot;
  entry?: McpConfigEntrySummary;
  entries: McpConfigEntrySummary[];
  onSelectEntry: (name: string | null) => void;
  onCancel: () => void;
  onComplete: (message: string) => void;
  onMutateConfig?: McpManagerPanelProps["onMutateConfig"];
  onSaveServer?: McpManagerPanelProps["onSaveServer"];
}) {
  const allScopes = useMemo(() => editableScopes(snapshot), [snapshot]);
  const entryScopes = entry
    ? (entry.writableOverrideScopes ?? entry.editableScopes)
    : allScopes;
  const availableScopes = entryScopes.length > 0 ? entryScopes : allScopes;
  const [scope, setScope] = useState<McpManagerScope>(
    entry?.preferredEditScope ?? availableScopes[0] ?? "global",
  );
  const [name, setName] = useState(entry?.name ?? "");
  const [type, setType] = useState<McpManagerServerDraft["type"]>(
    entry?.config.type === "streamable-http"
      ? "http"
      : (entry?.config.type ?? "stdio"),
  );
  const [command, setCommand] = useState(entry?.config.command ?? "");
  const [args, setArgs] = useState(entry?.config.args?.join("\n") ?? "");
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
  const [supportsParallelToolCalls, setSupportsParallelToolCalls] = useState(
    entry?.config.supportsParallelToolCalls ?? false,
  );
  const [allowedTools, setAllowedTools] = useState(
    entry?.config.allowedTools?.join("\n") ?? "",
  );
  const [disabled, setDisabled] = useState(entry?.config.disabled ?? false);
  const [envMode, setEnvMode] = useState<McpSecretMutationMode>("preserve");
  const [envValues, setEnvValues] = useState("");
  const [envRemovals, setEnvRemovals] = useState("");
  const [headerMode, setHeaderMode] =
    useState<McpSecretMutationMode>("preserve");
  const [headerValues, setHeaderValues] = useState("");
  const [headerRemovals, setHeaderRemovals] = useState("");
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });

  const isHttp =
    type === "sse" || type === "streamable-http" || type === "http";
  const canWriteSecrets =
    Boolean(onMutateConfig) && snapshot.capabilities.canWriteSecrets !== false;
  const credentialKeyCount =
    (entry?.envKeys?.length ?? 0) + (entry?.headerKeys?.length ?? 0);

  return (
    <form
      class="mcp-manager-form mcp-manager-guided-editor"
      aria-label={entry ? `Edit ${entry.name}` : "Add MCP server"}
      onSubmit={(event) => {
        event.preventDefault();
        const parsedArgs = parseStringList(args, "Arguments");
        const parsedAllowedTools = parseStringList(
          allowedTools,
          "Allowed tools",
        );
        const parsedEnv = secretMutation(
          envMode,
          envValues,
          envRemovals,
          "Environment variables",
        );
        const parsedHeaders = secretMutation(
          headerMode,
          headerValues,
          headerRemovals,
          "Headers",
        );
        const localError =
          (type === "stdio" &&
          snapshot.capabilities.canConfigureLocalProcess === false
            ? "This host cannot configure local-process servers."
            : undefined) ??
          parsedArgs.error ??
          parsedAllowedTools.error ??
          parsedEnv.error ??
          parsedHeaders.error;
        if (localError) {
          setSubmission({ kind: "error", message: localError });
          return;
        }

        const draft: McpManagerServerDraft = {
          name,
          type,
          ...(isHttp ? { url } : { command, args: parsedArgs.value }),
          ...(timeout.trim() ? { timeout: Number(timeout) } : {}),
          toolPolicy,
          toolDisclosure,
          supportsParallelToolCalls,
          allowedTools: parsedAllowedTools.value,
          disabled,
        };
        const review = validateMcpServerDraft(draft);
        if (!review.valid || !review.draft) {
          setSubmission({
            kind: "error",
            message:
              review.diagnostics.find((item) => item.severity === "error")
                ?.message ?? "Review the server fields and try again.",
          });
          return;
        }

        if (!onMutateConfig) {
          onSaveServer?.(scope, review.draft);
          setSubmission({ kind: "success", message: "Save request sent." });
          onComplete("Save request sent.");
          return;
        }

        const server: McpManagerServerWriteDraft = {
          ...review.draft,
          env: parsedEnv.value,
          headers: parsedHeaders.value,
        };
        const batch: McpConfigBatchMutation = {
          operationId: randomId(),
          profile: snapshot.profile,
          scope,
          ...(snapshot.project
            ? { projectId: snapshot.project.projectId }
            : {}),
          expectedRevision: revisionForScope(snapshot, scope),
          operations: [
            {
              kind: "upsert",
              server,
              conflictAction: "replace",
            },
          ],
        };
        setSubmission({ kind: "pending", message: "Saving server…" });
        void onMutateConfig(batch)
          .then((result) => {
            if (!result.ok) {
              setSubmission({
                kind: "error",
                message:
                  result.errors.map((item) => item.message).join(" ") ||
                  "The server could not be saved.",
              });
              return;
            }
            setSubmission({ kind: "success", message: "Server saved." });
            onComplete("Server saved.");
          })
          .catch((reason: unknown) => {
            setSubmission({
              kind: "error",
              message:
                reason instanceof Error ? reason.message : "The save failed.",
            });
          });
      }}
    >
      <Field label="Server to configure">
        <select
          value={entry?.name ?? ""}
          disabled={submission.kind === "pending"}
          onInput={(event) => onSelectEntry(event.currentTarget.value || null)}
        >
          <option value="">Add a new server</option>
          {entries.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>
      <div class="mcp-manager-form-heading">
        <h2>{entry ? `Edit ${entry.name}` : "Add a server"}</h2>
      </div>
      <div class="mcp-manager-form-grid">
        <Field label="Save to">
          <select
            value={scope}
            disabled={submission.kind === "pending"}
            onInput={(event) =>
              setScope(event.currentTarget.value as McpManagerScope)
            }
          >
            {availableScopes.map((item) => (
              <option key={item} value={item}>
                {scopeLabel(item)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Server name">
          <input
            value={name}
            disabled={Boolean(entry) || submission.kind === "pending"}
            placeholder="my-server"
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </Field>
        <Field label="Transport">
          <select
            value={type}
            disabled={submission.kind === "pending"}
            onInput={(event) =>
              setType(
                event.currentTarget.value as McpManagerServerDraft["type"],
              )
            }
          >
            <option value="stdio">Local process (stdio)</option>
            <option value="http">HTTP</option>
            <option value="sse">Legacy SSE</option>
          </select>
        </Field>
        <label class="mcp-manager-toggle-field">
          <input
            type="checkbox"
            checked={disabled}
            disabled={submission.kind === "pending"}
            onInput={(event) => setDisabled(event.currentTarget.checked)}
          />
          <span>Keep this server disabled</span>
        </label>
      </div>
      {isHttp ? (
        <Field label="Server URL">
          <input
            value={url}
            disabled={submission.kind === "pending"}
            placeholder="https://example.com/mcp"
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
        </Field>
      ) : (
        <div class="mcp-manager-form-grid">
          <Field label="Command">
            <input
              value={command}
              disabled={submission.kind === "pending"}
              placeholder="npx"
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
          </Field>
          <Field
            label="Arguments"
            hint="One argument per line, or a JSON array of strings. Spaces within a line are preserved."
          >
            <textarea
              value={args}
              rows={4}
              disabled={submission.kind === "pending"}
              placeholder={
                '-y\n@modelcontextprotocol/server-example\n"or use a JSON array"'
              }
              onInput={(event) => setArgs(event.currentTarget.value)}
            />
          </Field>
        </div>
      )}
      <p class="mcp-manager-note mcp-manager-security-note">
        <i class="codicon codicon-shield" aria-hidden="true" />
        Keep credentials out of arguments and URL query strings.
        {!isHttp &&
          " Saving launches this executable; only use commands you trust."}
      </p>
      <details class="mcp-manager-disclosure">
        <summary>Advanced settings</summary>
        <div class="mcp-manager-disclosure-content mcp-manager-form-grid">
          <Field label="Timeout (ms)">
            <input
              value={timeout}
              inputMode="numeric"
              disabled={submission.kind === "pending"}
              placeholder="60000"
              onInput={(event) => setTimeoutValue(event.currentTarget.value)}
            />
          </Field>
          <Field label="Tool approval policy">
            <select
              value={toolPolicy}
              disabled={submission.kind === "pending"}
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
              disabled={submission.kind === "pending"}
              onInput={(event) =>
                setToolDisclosure(
                  event.currentTarget.value as "inline" | "deferred" | "auto",
                )
              }
            >
              <option value="auto">Automatic</option>
              <option value="inline">Inline</option>
              <option value="deferred">Deferred</option>
            </select>
          </Field>
          <label class="mcp-manager-toggle-field">
            <input
              type="checkbox"
              checked={supportsParallelToolCalls}
              disabled={submission.kind === "pending"}
              onInput={(event) =>
                setSupportsParallelToolCalls(event.currentTarget.checked)
              }
            />
            <span>Server supports parallel tool calls</span>
            <small>
              Enable only when this server safely accepts concurrent calls.
            </small>
          </label>
          <Field
            label="Always allowed tools"
            hint="One tool per line, or a JSON array of strings."
          >
            <textarea
              value={allowedTools}
              rows={2}
              disabled={submission.kind === "pending"}
              onInput={(event) => setAllowedTools(event.currentTarget.value)}
            />
          </Field>
        </div>
      </details>
      <details class="mcp-manager-disclosure">
        <summary>
          Credentials
          {credentialKeyCount > 0 && (
            <span class="mcp-manager-disclosure-count">
              {credentialKeyCount} {credentialKeyCount === 1 ? "key" : "keys"}
            </span>
          )}
        </summary>
        <div class="mcp-manager-disclosure-content mcp-manager-secret-grid">
          <SecretEditor
            label="Environment variables"
            existingKeys={entry?.envKeys ?? []}
            mode={envMode}
            values={envValues}
            removals={envRemovals}
            disabled={!canWriteSecrets || submission.kind === "pending"}
            onModeChange={setEnvMode}
            onValuesChange={setEnvValues}
            onRemovalsChange={setEnvRemovals}
          />
          <SecretEditor
            label="Headers"
            existingKeys={entry?.headerKeys ?? []}
            mode={headerMode}
            values={headerValues}
            removals={headerRemovals}
            disabled={!canWriteSecrets || submission.kind === "pending"}
            onModeChange={setHeaderMode}
            onValuesChange={setHeaderValues}
            onRemovalsChange={setHeaderRemovals}
          />
        </div>
      </details>
      {!canWriteSecrets && (
        <p class="mcp-manager-note">
          Secret editing requires a host that supports batch config mutations
          and secret writes. Existing values will be preserved.
        </p>
      )}
      <Feedback state={submission} />
      <div class="mcp-manager-form-actions">
        <button
          class="mcp-manager-button mcp-manager-button-primary"
          type="submit"
          disabled={submission.kind === "pending" || !availableScopes.length}
        >
          {submission.kind === "pending" ? "Saving…" : "Save server"}
        </button>
        <button
          class="mcp-manager-button"
          type="button"
          disabled={submission.kind === "pending"}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ImportReview({
  snapshot,
  onMutateConfig,
  onComplete,
}: {
  snapshot: McpConfigSnapshot;
  onMutateConfig?: McpManagerPanelProps["onMutateConfig"];
  onComplete: () => void;
}) {
  const scopes = useMemo(() => editableScopes(snapshot), [snapshot]);
  const [scope, setScope] = useState<McpManagerScope>(scopes[0] ?? "global");
  const [raw, setRaw] = useState("");
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [actions, setActions] = useState<
    Record<number, McpConfigConflictAction>
  >({});
  const [renames, setRenames] = useState<Record<number, string>>({});
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });
  const review = useMemo(
    () => (raw.trim() ? parseMcpConfigImport(raw) : null),
    [raw],
  );

  useEffect(() => {
    if (!review) {
      setSelected({});
      setActions({});
      setRenames({});
      return;
    }
    setSelected(
      Object.fromEntries(
        review.rows.map((row, index) => [index, row.selected]),
      ),
    );
    setActions(
      Object.fromEntries(
        review.rows.map((row, index) => [
          index,
          snapshot.entries.some((entry) => entry.name === row.name)
            ? "skip"
            : "replace",
        ]),
      ),
    );
    setRenames({});
    setSubmission({ kind: "idle" });
  }, [review, snapshot.entries]);

  const selectedRows = review?.rows.filter(
    (row, index) =>
      row.valid &&
      selected[index] &&
      importCapabilityDiagnostics(snapshot, row.draft).length === 0,
  );
  const renameDiagnostics = useMemo(() => {
    if (!review) return {};
    const plannedNames = review.rows.flatMap((row, index) => {
      if (
        !row.valid ||
        !row.draft ||
        !selected[index] ||
        importCapabilityDiagnostics(snapshot, row.draft).length > 0
      )
        return [];
      return [
        actions[index] === "rename" ? renames[index]?.trim() : row.name,
      ].filter((name): name is string => Boolean(name));
    });
    return Object.fromEntries(
      review.rows.flatMap((row, index) => {
        if (actions[index] !== "rename" || !selected[index] || !row.draft)
          return [];
        const target = renames[index]?.trim();
        if (!target) return [[index, "Enter a new server name."]];
        const targetReview = validateMcpServerDraft({
          ...row.draft,
          name: target,
        });
        const validationError = targetReview.diagnostics.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (validationError) return [[index, validationError.message]];
        if (snapshot.entries.some((entry) => entry.name === target)) {
          return [[index, `A server named ${target} already exists.`]];
        }
        if (plannedNames.filter((name) => name === target).length > 1) {
          return [[index, `More than one selected row would use ${target}.`]];
        }
        return [];
      }),
    ) as Record<number, string>;
  }, [actions, renames, review, selected, snapshot]);
  const hasRenameErrors = Object.keys(renameDiagnostics).length > 0;

  return (
    <section class="mcp-manager-import" aria-labelledby="mcp-import-heading">
      <div class="mcp-manager-section-heading">
        <div>
          <h2 id="mcp-import-heading">Import JSON</h2>
          <p>Paste JSON or JSONC, then review before applying.</p>
        </div>
        <Field label="Import into">
          <select
            value={scope}
            disabled={submission.kind === "pending"}
            onInput={(event) =>
              setScope(event.currentTarget.value as McpManagerScope)
            }
          >
            {scopes.map((item) => (
              <option key={item} value={item}>
                {scopeLabel(item)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="MCP configuration JSON">
        <textarea
          class="mcp-manager-import-input"
          value={raw}
          rows={6}
          spellcheck={false}
          disabled={submission.kind === "pending"}
          placeholder={
            '{\n  "mcpServers": {\n    "example": { "command": "npx" }\n  }\n}'
          }
          onInput={(event) => setRaw(event.currentTarget.value)}
        />
      </Field>
      {review?.diagnostics.map((diagnostic, index) => (
        <p
          key={`${diagnostic.path}-${index}`}
          class={`mcp-manager-diagnostic mcp-manager-diagnostic-${diagnostic.severity}`}
          role={diagnostic.severity === "error" ? "alert" : "status"}
        >
          <code>{diagnostic.path}</code> {diagnostic.message}
        </p>
      ))}
      {review && review.rows.length > 0 && (
        <div
          class="mcp-manager-import-review"
          role="region"
          aria-label="Import review"
        >
          <div class="mcp-manager-import-review-header">
            <span>Import</span>
            <span>Server</span>
            <span>Conflict action</span>
            <span>Review</span>
          </div>
          {review.rows.map((row, index) => {
            const conflict = snapshot.entries.some(
              (entry) => entry.name === row.name,
            );
            const action = actions[index] ?? (conflict ? "skip" : "replace");
            const capabilityDiagnostics = importCapabilityDiagnostics(
              snapshot,
              row.draft,
            );
            const selectable = row.valid && capabilityDiagnostics.length === 0;
            return (
              <div
                key={`${row.sourceName}-${index}`}
                class={`mcp-manager-import-row${selectable ? "" : " invalid"}`}
              >
                <label class="mcp-manager-import-selection">
                  <input
                    type="checkbox"
                    aria-label={`Import ${row.name || row.sourceName || `row ${index + 1}`}`}
                    checked={Boolean(selected[index]) && selectable}
                    disabled={!selectable || submission.kind === "pending"}
                    onInput={(event) =>
                      setSelected((current) => ({
                        ...current,
                        [index]: event.currentTarget.checked,
                      }))
                    }
                  />
                </label>
                <div class="mcp-manager-import-name">
                  <strong>
                    {row.name || row.sourceName || "Unnamed server"}
                  </strong>
                  <small>{row.draft?.type ?? "Invalid"}</small>
                </div>
                <div class="mcp-manager-import-conflict">
                  {conflict ? (
                    <>
                      <label>
                        <span class="mcp-manager-visually-hidden">
                          Conflict action for {row.name}
                        </span>
                        <select
                          aria-label={`Conflict action for ${row.name}`}
                          value={action}
                          disabled={
                            !selectable || submission.kind === "pending"
                          }
                          onInput={(event) =>
                            setActions((current) => ({
                              ...current,
                              [index]: event.currentTarget
                                .value as McpConfigConflictAction,
                            }))
                          }
                        >
                          <option value="skip">Skip if it still exists</option>
                          <option value="replace">Replace existing</option>
                          <option value="rename">Import with a new name</option>
                        </select>
                      </label>
                      {action === "rename" && (
                        <label>
                          <span class="mcp-manager-visually-hidden">
                            New name for {row.name}
                          </span>
                          <input
                            aria-label={`New name for ${row.name}`}
                            aria-invalid={Boolean(renameDiagnostics[index])}
                            aria-describedby={
                              renameDiagnostics[index]
                                ? `mcp-import-rename-error-${index}`
                                : undefined
                            }
                            value={renames[index] ?? ""}
                            disabled={submission.kind === "pending"}
                            placeholder={`${row.name}-imported`}
                            onInput={(event) =>
                              setRenames((current) => ({
                                ...current,
                                [index]: event.currentTarget.value,
                              }))
                            }
                          />
                          {renameDiagnostics[index] && (
                            <p
                              id={`mcp-import-rename-error-${index}`}
                              class="mcp-manager-diagnostic mcp-manager-diagnostic-error"
                            >
                              {renameDiagnostics[index]}
                            </p>
                          )}
                        </label>
                      )}
                    </>
                  ) : (
                    <span class="mcp-manager-import-new">Add new server</span>
                  )}
                </div>
                <div class="mcp-manager-import-diagnostics">
                  {row.diagnostics.length === 0 &&
                    capabilityDiagnostics.length === 0 && (
                      <span class="mcp-manager-diagnostic-ok">Ready</span>
                    )}
                  {row.diagnostics.map((diagnostic, diagnosticIndex) => (
                    <p
                      key={`${diagnostic.path}-${diagnosticIndex}`}
                      class={`mcp-manager-diagnostic mcp-manager-diagnostic-${diagnostic.severity}`}
                    >
                      <code>{diagnostic.path}</code> {diagnostic.message}
                    </p>
                  ))}
                  {capabilityDiagnostics.map((message) => (
                    <p
                      key={message}
                      class="mcp-manager-diagnostic mcp-manager-diagnostic-error"
                    >
                      {message}
                    </p>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!onMutateConfig && (
        <p class="mcp-manager-note">
          JSON import requires a host with batch config mutation support.
        </p>
      )}
      <Feedback state={submission} />
      <div class="mcp-manager-form-actions">
        <button
          class="mcp-manager-button mcp-manager-button-primary"
          type="button"
          disabled={
            !onMutateConfig ||
            submission.kind === "pending" ||
            submission.kind === "success" ||
            !selectedRows?.length ||
            hasRenameErrors ||
            !scopes.length
          }
          onClick={() => {
            if (!review || !onMutateConfig || !selectedRows?.length) return;
            const operations = review.rows.flatMap((row, index) => {
              if (
                !row.valid ||
                !row.draft ||
                !selected[index] ||
                importCapabilityDiagnostics(snapshot, row.draft).length > 0
              )
                return [];
              const conflictAction = actions[index] ?? "replace";
              return [
                {
                  kind: "upsert" as const,
                  server: canonicalDraftToWriteDraft(row.draft),
                  conflictAction,
                  ...(conflictAction === "rename"
                    ? { renameTo: renames[index]?.trim() }
                    : {}),
                },
              ];
            });
            const batch: McpConfigBatchMutation = {
              operationId: randomId(),
              profile: snapshot.profile,
              scope,
              ...(snapshot.project
                ? { projectId: snapshot.project.projectId }
                : {}),
              expectedRevision: revisionForScope(snapshot, scope),
              operations,
            };
            setSubmission({
              kind: "pending",
              message: `Applying ${operations.length} server${operations.length === 1 ? "" : "s"}…`,
            });
            void onMutateConfig(batch)
              .then((result) => {
                if (!result.ok) {
                  setSubmission({
                    kind: "error",
                    message:
                      result.errors.map((item) => item.message).join(" ") ||
                      "The import could not be applied.",
                  });
                  return;
                }
                setSubmission({
                  kind: "success",
                  message: `Applied ${operations.length} server${operations.length === 1 ? "" : "s"}.`,
                });
                onComplete();
              })
              .catch((reason: unknown) => {
                setSubmission({
                  kind: "error",
                  message:
                    reason instanceof Error
                      ? reason.message
                      : "The import failed.",
                });
              });
          }}
        >
          {submission.kind === "pending" ? "Applying…" : "Apply selected"}
        </button>
      </div>
    </section>
  );
}

export function McpManagerPanel({
  snapshot,
  initialView = "status",
  error,
  onClose,
  onRefresh,
  onSelectProject,
  onServerAction,
  onOpenRawConfig,
  onMutateConfig,
  onSaveServer,
  onRemoveServer,
}: McpManagerPanelProps) {
  const [view, setView] = useState<PanelView>(normalizeView(initialView));
  const [expandedServers, setExpandedServers] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({
    kind: "idle",
  });

  useEffect(() => {
    setView(normalizeView(initialView));
  }, [initialView]);

  const statusByName = useMemo(
    () => new Map(snapshot.statusInfos.map((info) => [info.name, info])),
    [snapshot.statusInfos],
  );
  const entryByName = useMemo(
    () => new Map(snapshot.entries.map((entry) => [entry.name, entry])),
    [snapshot.entries],
  );
  const serverNames = useMemo(
    () => [
      ...snapshot.entries.map((entry) => entry.name),
      ...snapshot.statusInfos
        .map((info) => info.name)
        .filter((name) => !entryByName.has(name)),
    ],
    [snapshot.entries, snapshot.statusInfos, entryByName],
  );
  const editingEntry = editingServer
    ? entryByName.get(editingServer)
    : undefined;
  useEffect(() => {
    if (editingServer && !entryByName.has(editingServer)) {
      setEditingServer(null);
    }
  }, [editingServer, entryByName]);
  const configuredCount = snapshot.entries.length;
  const connectedCount = snapshot.statusInfos.filter(
    (info) => info.status === "connected",
  ).length;
  const disabledCount = serverNames.filter(
    (name) =>
      entryByName.get(name)?.config.disabled ||
      statusByName.get(name)?.status === "disabled",
  ).length;
  const attentionCount = serverNames.filter((name) => {
    if (entryByName.get(name)?.config.disabled) return false;
    const status = statusByName.get(name)?.status ?? "not_connected";
    return (
      status !== "connected" && status !== "disabled" && status !== "connecting"
    );
  }).length;
  const canEdit =
    snapshot.capabilities.canEditConfig && editableScopes(snapshot).length > 0;

  const navigate = (next: PanelView) => {
    setView(next);
    setEditingServer(null);
    setSubmission({ kind: "idle" });
  };

  const setServerDisabled = (
    entry: McpConfigEntrySummary,
    disabled: boolean,
  ) => {
    const scope =
      entry.preferredEditScope ??
      entry.writableOverrideScopes?.at(-1) ??
      entry.editableScopes.at(-1);
    if (!scope) return;
    if (!onMutateConfig) {
      onSaveServer?.(scope, { ...entry.config, disabled });
      setSubmission({
        kind: "success",
        message: `${disabled ? "Disable" : "Enable"} request sent.`,
      });
      return;
    }
    const batch: McpConfigBatchMutation = {
      operationId: randomId(),
      profile: snapshot.profile,
      scope,
      ...(snapshot.project ? { projectId: snapshot.project.projectId } : {}),
      expectedRevision: revisionForScope(snapshot, scope),
      operations: [
        {
          kind: "upsert",
          conflictAction: "replace",
          server: { ...entry.config, disabled },
        },
      ],
    };
    setSubmission({
      kind: "pending",
      message: `${disabled ? "Disabling" : "Enabling"} ${entry.name}…`,
    });
    void onMutateConfig(batch)
      .then((result) => {
        setSubmission(
          result.ok
            ? {
                kind: "success",
                message: `${entry.name} ${disabled ? "disabled" : "enabled"}.`,
              }
            : {
                kind: "error",
                message:
                  result.errors.map((item) => item.message).join(" ") ||
                  `${entry.name} could not be ${disabled ? "disabled" : "enabled"}.`,
              },
        );
      })
      .catch((reason: unknown) => {
        setSubmission({
          kind: "error",
          message:
            reason instanceof Error
              ? reason.message
              : `The ${disabled ? "disable" : "enable"} request failed.`,
        });
      });
  };

  const removeServer = (entry: McpConfigEntrySummary) => {
    const scope =
      entry.preferredEditScope ??
      entry.writableOverrideScopes?.at(-1) ??
      entry.editableScopes.at(-1);
    if (!scope) return;
    if (!onMutateConfig) {
      onRemoveServer?.(scope, entry.name);
      setSubmission({ kind: "success", message: "Remove request sent." });
      return;
    }
    const batch: McpConfigBatchMutation = {
      operationId: randomId(),
      profile: snapshot.profile,
      scope,
      ...(snapshot.project ? { projectId: snapshot.project.projectId } : {}),
      expectedRevision: revisionForScope(snapshot, scope),
      operations: [{ kind: "remove", serverName: entry.name }],
    };
    setSubmission({ kind: "pending", message: `Removing ${entry.name}…` });
    void onMutateConfig(batch)
      .then((result) => {
        setSubmission(
          result.ok
            ? { kind: "success", message: `${entry.name} removed.` }
            : {
                kind: "error",
                message:
                  result.errors.map((item) => item.message).join(" ") ||
                  `${entry.name} could not be removed.`,
              },
        );
      })
      .catch((reason: unknown) => {
        setSubmission({
          kind: "error",
          message:
            reason instanceof Error ? reason.message : "The removal failed.",
        });
      });
  };

  return (
    <div class="mcp-manager-panel mcp-manager-panel-redesign">
      <header class="mcp-status-header mcp-manager-header">
        <i class="codicon codicon-server" aria-hidden="true" />
        <div class="mcp-manager-title">
          <strong>
            {snapshot.profile === "ask-agent"
              ? "Ask Agent MCP Manager"
              : "MCP Manager"}
          </strong>
          <span class="mcp-manager-profile">
            {snapshot.profile === "ask-agent" ? "Ask Agent" : "VS Code"}
          </span>
        </div>
        <button
          class="mcp-status-close icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close MCP Manager"
          title="Close MCP Manager"
        >
          <i class="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>
      {snapshot.profile === "main" && snapshot.project && (
        <label class="mcp-manager-project-selector">
          <span>Project</span>
          {snapshot.projects && snapshot.projects.length > 1 ? (
            <select
              aria-label="MCP project"
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
        aria-label="MCP Manager sections"
      >
        {(
          [
            ["overview", "Servers"],
            ["sources", "Sources"],
            ["guided", "Add / edit"],
            ["import", "Import"],
          ] as const
        ).map(([item, label]) => (
          <button
            key={item}
            class={`mcp-manager-button${view === item ? " active" : ""}`}
            type="button"
            aria-current={view === item ? "page" : undefined}
            disabled={(item === "guided" || item === "import") && !canEdit}
            onClick={() => navigate(item)}
          >
            {label}
          </button>
        ))}
        <button
          class="mcp-manager-button mcp-manager-refresh"
          type="button"
          aria-label="Refresh MCP Manager"
          title="Refresh"
          onClick={onRefresh}
        >
          <i class="codicon codicon-refresh" aria-hidden="true" />
          <span class="mcp-manager-visually-hidden">Refresh</span>
        </button>
      </nav>
      {error && (
        <p class="mcp-manager-feedback mcp-manager-feedback-error" role="alert">
          {error}
        </p>
      )}
      {snapshot.unavailableReason && (
        <p class="mcp-manager-feedback mcp-manager-feedback-error" role="alert">
          {snapshot.unavailableReason}
        </p>
      )}

      {view === "overview" && (
        <section
          class="mcp-manager-overview"
          aria-labelledby="mcp-overview-heading"
        >
          <h2 id="mcp-overview-heading" class="mcp-manager-visually-hidden">
            MCP server overview
          </h2>
          <div class="mcp-manager-summary-cards">
            <div class="mcp-manager-summary-card">
              <strong>{configuredCount}</strong>
              <span>Configured</span>
            </div>
            <div class="mcp-manager-summary-card mcp-manager-summary-connected">
              <strong>{connectedCount}</strong>
              <span>Connected</span>
            </div>
            <div class="mcp-manager-summary-card mcp-manager-summary-attention">
              <strong>{attentionCount}</strong>
              <span>Need attention</span>
            </div>
            <div class="mcp-manager-summary-card mcp-manager-summary-disabled">
              <strong>{disabledCount}</strong>
              <span>Disabled</span>
            </div>
          </div>
          <Feedback state={submission} />
          {serverNames.length === 0 ? (
            <div class="mcp-manager-empty-state">
              <p>No MCP servers are configured.</p>
              {canEdit && (
                <button
                  class="mcp-manager-button mcp-manager-button-primary"
                  type="button"
                  onClick={() => navigate("guided")}
                >
                  Add your first server
                </button>
              )}
            </div>
          ) : (
            <ul class="mcp-status-list mcp-manager-server-list">
              {serverNames.map((name) => {
                const entry = entryByName.get(name);
                const info = statusByName.get(name);
                const effectiveStatus =
                  entry?.config.disabled || info?.status === "disabled"
                    ? "disabled"
                    : (info?.status ?? "not_connected");
                const expanded = expandedServers.has(name);
                return (
                  <li
                    key={name}
                    class={`mcp-status-item mcp-status-${effectiveStatus} mcp-manager-server-row`}
                  >
                    <div class="mcp-status-row">
                      <button
                        class="mcp-status-expand icon-button"
                        type="button"
                        disabled={!info?.tools.length}
                        aria-label={`${expanded ? "Hide" : "Show"} tools for ${name}`}
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedServers((current) => {
                            const next = new Set(current);
                            if (next.has(name)) next.delete(name);
                            else next.add(name);
                            return next;
                          })
                        }
                      >
                        <i
                          class={`codicon codicon-chevron-${expanded ? "down" : "right"}`}
                          aria-hidden="true"
                        />
                      </button>
                      <i
                        class={`codicon ${statusIcon(effectiveStatus)}`}
                        aria-hidden="true"
                      />
                      <div class="mcp-manager-server-identity">
                        <span class="mcp-status-name">{name}</span>
                        <span class="mcp-status-detail">
                          {statusDetail(info, Boolean(entry?.config.disabled))}
                        </span>
                      </div>
                      <span class="mcp-manager-server-badges">
                        <code>{statusLabel(effectiveStatus)}</code>
                        {entry && <code>{entry.config.type ?? "stdio"}</code>}
                        {entry?.inherited && <code>inherited</code>}
                        {entry?.hasSecrets && <code>secrets</code>}
                        {!entry && <code>runtime only</code>}
                      </span>
                      <span class="mcp-status-actions">
                        {snapshot.capabilities.canReconnect &&
                          info &&
                          effectiveStatus !== "connecting" &&
                          effectiveStatus !== "disabled" && (
                            <button
                              class="icon-button"
                              type="button"
                              aria-label={`Reconnect ${name}`}
                              title="Reconnect"
                              onClick={() =>
                                onServerAction?.(name, "reconnect")
                              }
                            >
                              <i
                                class="codicon codicon-refresh"
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        {snapshot.capabilities.canReauthenticate &&
                          info &&
                          effectiveStatus !== "disabled" && (
                            <button
                              class="icon-button"
                              type="button"
                              aria-label={`Reauthenticate ${name}`}
                              title="Reauthenticate"
                              onClick={() =>
                                onServerAction?.(name, "reauthenticate")
                              }
                            >
                              <i
                                class="codicon codicon-key"
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        {snapshot.capabilities.canDisable &&
                          entry &&
                          !(
                            (entry.config.type === undefined ||
                              entry.config.type === "stdio") &&
                            snapshot.capabilities.canConfigureLocalProcess ===
                              false
                          ) && (
                            <button
                              class="icon-button"
                              type="button"
                              disabled={submission.kind === "pending"}
                              aria-label={`${effectiveStatus === "disabled" ? "Enable" : "Disable"} ${name}`}
                              title={
                                effectiveStatus === "disabled"
                                  ? "Enable"
                                  : "Disable"
                              }
                              onClick={() =>
                                setServerDisabled(
                                  entry,
                                  effectiveStatus !== "disabled",
                                )
                              }
                            >
                              <i
                                class={`codicon codicon-${effectiveStatus === "disabled" ? "play" : "circle-slash"}`}
                                aria-hidden="true"
                              />
                            </button>
                          )}
                        {canEdit && entry && (
                          <button
                            class="icon-button"
                            type="button"
                            aria-label={`Edit ${name}`}
                            title="Edit"
                            onClick={() => {
                              setEditingServer(name);
                              setView("guided");
                            }}
                          >
                            <i
                              class="codicon codicon-edit"
                              aria-hidden="true"
                            />
                          </button>
                        )}
                        {canEdit && entry?.preferredEditScope && (
                          <button
                            class="icon-button mcp-manager-icon-danger"
                            type="button"
                            disabled={submission.kind === "pending"}
                            aria-label={`Remove ${name}`}
                            title="Remove"
                            onClick={() => removeServer(entry)}
                          >
                            <i
                              class="codicon codicon-trash"
                              aria-hidden="true"
                            />
                          </button>
                        )}
                      </span>
                    </div>
                    {expanded && info && (
                      <ul class="mcp-tool-list">
                        {info.tools.map((tool) => (
                          <li key={tool.name} class="mcp-tool-item">
                            <span>{tool.name}</span>
                            {tool.description && (
                              <small>{tool.description}</small>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {view === "sources" && (
        <section
          class="mcp-manager-sources-view"
          aria-labelledby="mcp-sources-heading"
        >
          <div class="mcp-manager-section-heading">
            <div>
              <h2 id="mcp-sources-heading">Configuration sources</h2>
              <p>
                Higher-priority sources override matching settings below them.
              </p>
            </div>
          </div>
          {snapshot.sources.length === 0 ? (
            <p class="mcp-manager-empty-state">
              No configuration sources are available.
            </p>
          ) : (
            <ul class="mcp-manager-sources">
              {[...snapshot.sources]
                .sort((left, right) => right.priority - left.priority)
                .map((source) => (
                  <li
                    key={source.id}
                    class={`mcp-manager-source-row mcp-manager-source-${source.readStatus}`}
                  >
                    <div class="mcp-manager-source-heading">
                      <div>
                        <strong>{source.label}</strong>
                        <span class="mcp-manager-source-health">
                          {sourceHealthLabel(source)}
                        </span>
                      </div>
                      <span class="mcp-manager-source-badges">
                        <code>{scopeLabel(source.scope)}</code>
                        <code>
                          {source.editable ? "editable" : "read-only"}
                        </code>
                        {source.inherited && <code>inherited</code>}
                        <code>priority {source.priority}</code>
                      </span>
                    </div>
                    <details class="mcp-manager-disclosure mcp-manager-source-details">
                      <summary>Path and actions</summary>
                      <div class="mcp-manager-disclosure-content">
                        <small class="mcp-manager-source-path">
                          {source.path}
                        </small>
                        {source.readError && (
                          <p class="mcp-manager-diagnostic mcp-manager-diagnostic-error">
                            Read error: {statusLabel(source.readError)}
                          </p>
                        )}
                        {snapshot.capabilities.canOpenRawConfig && (
                          <button
                            class="mcp-manager-button"
                            type="button"
                            onClick={() => onOpenRawConfig?.(source.scope)}
                          >
                            Open raw configuration
                          </button>
                        )}
                      </div>
                    </details>
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      {view === "guided" && (
        <GuidedEditor
          key={editingEntry?.name ?? "new"}
          snapshot={snapshot}
          entry={editingEntry}
          entries={snapshot.entries}
          onSelectEntry={setEditingServer}
          onMutateConfig={onMutateConfig}
          onSaveServer={onSaveServer}
          onCancel={() => navigate("overview")}
          onComplete={(message) => {
            setView("overview");
            setEditingServer(null);
            setSubmission({ kind: "success", message });
          }}
        />
      )}

      {view === "import" && (
        <ImportReview
          snapshot={snapshot}
          onMutateConfig={onMutateConfig}
          onComplete={() => undefined}
        />
      )}
    </div>
  );
}
