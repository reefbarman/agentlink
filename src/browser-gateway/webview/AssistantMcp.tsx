import { Dialog, errorText, requestJson } from "./AssistantProjects";
import { useEffect, useState } from "preact/hooks";

/**
 * The owner's remote MCP servers (other services the assistant can use,
 * such as Notion or Linear): add one by its HTTPS address, test it, sign
 * in, and choose per tool whether a call runs straight away (**Run**),
 * asks first (**Ask**, the default for every new or changed tool) or is
 * never offered (**Off**). Secrets go to the server and never come back.
 */

export type McpToolPolicy = "ask" | "run" | "off";

export interface McpTool {
  name: string;
  description: string;
  readOnlyHint?: boolean;
  policy: McpToolPolicy;
}

export interface McpServer {
  id: string;
  label: string;
  url: string;
  auth: "none" | "header" | "oauth";
  headerName?: string;
  enabled: boolean;
  status: "untested" | "ok" | "error" | "signed_out";
  error?: string;
  testedAt?: number;
  origin: "owner" | "chat";
  purpose?: string;
  hasCredentials: boolean;
  tools: McpTool[];
}

/** What a server's status means for the owner, in a few words. */
export function mcpStatusLabel(server: McpServer): {
  text: string;
  tone: "ok" | "warn" | "bad" | "muted";
} {
  if (!server.enabled) return { text: "Turned off", tone: "muted" };
  switch (server.status) {
    case "ok":
      return {
        text: `Working · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`,
        tone: "ok",
      };
    case "signed_out":
      return { text: "Needs you to sign in", tone: "warn" };
    case "error":
      return { text: "Not working", tone: "bad" };
    case "untested":
      return server.auth === "oauth" && !server.hasCredentials
        ? { text: "Sign in to finish adding it", tone: "warn" }
        : { text: "Not tested yet", tone: "muted" };
  }
}

/** The server's plain-language reason when there is one. */
function mcpErrorText(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : errorText(error);
}

/** What the page says after an OAuth sign-in returns (`/?mcp=…`). */
export function signInReturnNotice(search: string): string | undefined {
  const outcome = new URLSearchParams(search).get("mcp");
  if (outcome === "signed-in") return "Signed in.";
  if (outcome === "sign-in-failed") {
    return "Sign-in did not finish. Try again from the server's Sign in button.";
  }
  return undefined;
}

export function McpPanel({
  onClose,
  openUrl = (url) => window.open(url, "_blank", "noopener"),
}: {
  onClose: () => void;
  openUrl?: (url: string) => void;
}) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    () => signInReturnNotice(window.location.search) ?? null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    requestJson<{ servers: McpServer[] }>("/api/mcp").then(
      (body) => {
        if (!cancelled) setServers(body.servers);
      },
      (caught: unknown) => {
        if (!cancelled) setError(mcpErrorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      setReloads((count) => count + 1);
    } catch (caught) {
      setError(mcpErrorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const path = (server: McpServer, rest = "") =>
    `/api/mcp/${encodeURIComponent(server.id)}${rest}`;

  const test = (server: McpServer) =>
    act(`test:${server.id}`, async () => {
      const result = await requestJson<{
        server: McpServer;
        changed: string[];
        added: string[];
      }>(path(server, "/test"), { method: "POST" });
      if (result.server.status !== "ok") {
        setNotice(result.server.error ?? "It did not answer.");
      } else if (result.changed.length > 0) {
        setNotice(
          `Changed on the server, so they ask again: ${result.changed.join(", ")}.`,
        );
      } else if (result.added.length > 0) {
        setNotice(`New tools (they ask first): ${result.added.join(", ")}.`);
      } else {
        setNotice("It works.");
      }
    });

  const signIn = (server: McpServer) =>
    act(`sign-in:${server.id}`, async () => {
      const result = await requestJson<{
        authorizationUrl?: string;
        server?: McpServer;
      }>(path(server, "/sign-in"), { method: "POST" });
      if (result.authorizationUrl) {
        setNotice("Finish signing in on the page that opened.");
        openUrl(result.authorizationUrl);
      } else {
        setNotice("Signed in already.");
      }
    });

  const setPolicy = (server: McpServer, tool: McpTool, policy: McpToolPolicy) =>
    act(`policy:${server.id}:${tool.name}`, async () => {
      await requestJson(
        path(server, `/tools/${encodeURIComponent(tool.name)}`),
        { method: "PUT", body: { policy } },
      );
    });

  if (adding) {
    return (
      <Dialog title="Add an MCP server" onClose={onClose} wide>
        <AddServerForm
          onCancel={() => setAdding(false)}
          onAdded={(server) => {
            setAdding(false);
            setOpen(server.id);
            setNotice(
              server.auth === "oauth"
                ? `Added "${server.label}". Sign in to it to finish.`
                : server.status === "ok"
                  ? `Added "${server.label}". Every tool asks you first until you set it to Run.`
                  : `Added "${server.label}", but it is not working: ${server.error ?? "it did not answer"}.`,
            );
            setReloads((count) => count + 1);
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="MCP servers"
      onClose={onClose}
      wide
      actions={
        <button
          type="button"
          class="assistant-panel-action primary"
          onClick={() => setAdding(true)}
        >
          <i class="codicon codicon-add" aria-hidden="true" /> Add a server
        </button>
      }
    >
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p class="assistant-project-hint" role="status">
          {notice}
        </p>
      )}
      {!servers ? (
        <p class="assistant-project-hint">{error ? "" : "Loading…"}</p>
      ) : servers.length === 0 ? (
        <p class="assistant-project-hint">
          No servers yet. Add a service's remote MCP address (HTTPS) to let the
          assistant use it. Every tool asks you before each call until you set
          it to Run.
        </p>
      ) : (
        <ul class="assistant-job-list">
          {servers.map((server) => {
            const label = mcpStatusLabel(server);
            const expanded = open === server.id;
            return (
              <li class="assistant-job" key={server.id}>
                <div class="assistant-job-main">
                  <strong>{server.label}</strong>
                  <span class="assistant-job-meta">
                    <span class={`assistant-run-status tone-${label.tone}`}>
                      {label.text}
                    </span>
                    {" · "}
                    {server.url}
                  </span>
                  {server.status !== "ok" && server.error && (
                    <span class="assistant-job-meta">{server.error}</span>
                  )}
                  {server.origin === "chat" && server.purpose && (
                    <span class="assistant-job-meta">
                      Suggested by a chat: {server.purpose}
                    </span>
                  )}
                </div>
                <div class="assistant-job-actions">
                  {server.auth === "oauth" && (
                    <button
                      type="button"
                      class="assistant-panel-action"
                      disabled={busy !== null}
                      onClick={() => void signIn(server)}
                    >
                      Sign in
                    </button>
                  )}
                  <button
                    type="button"
                    class="assistant-panel-action"
                    disabled={busy !== null}
                    onClick={() => void test(server)}
                  >
                    {busy === `test:${server.id}` ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    class="assistant-panel-action"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`enable:${server.id}`, () =>
                        requestJson(path(server), {
                          method: "PATCH",
                          body: { enabled: !server.enabled },
                        }),
                      )
                    }
                  >
                    {server.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    type="button"
                    class="assistant-panel-action"
                    aria-expanded={expanded}
                    disabled={server.tools.length === 0}
                    onClick={() => setOpen(expanded ? null : server.id)}
                  >
                    Tools
                  </button>
                  <button
                    type="button"
                    class="assistant-panel-action"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove "${server.label}"? Its sign-in is forgotten.`,
                        )
                      ) {
                        void act(`remove:${server.id}`, () =>
                          requestJson(path(server), { method: "DELETE" }),
                        );
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
                {expanded && (
                  <ul class="assistant-mcp-tools" aria-label="Tools">
                    {server.tools.map((tool) => (
                      <li key={tool.name}>
                        <div class="assistant-job-main">
                          <code>{tool.name}</code>
                          <span class="assistant-job-meta">
                            {tool.description.slice(0, 200) || "No description"}
                            {tool.readOnlyHint
                              ? " (the server says it only reads)"
                              : ""}
                          </span>
                        </div>
                        <select
                          aria-label={`When ${tool.name} is called`}
                          value={tool.policy}
                          disabled={busy !== null}
                          onChange={(event) =>
                            void setPolicy(
                              server,
                              tool,
                              event.currentTarget.value as McpToolPolicy,
                            )
                          }
                        >
                          <option value="ask">Ask</option>
                          <option value="run">Run</option>
                          <option value="off">Off</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function AddServerForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (server: McpServer) => void;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"none" | "header" | "oauth">("none");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson<{ server: McpServer }>("/api/mcp", {
        method: "POST",
        body: {
          label,
          url,
          auth,
          ...(auth === "header" ? { headerName, headerValue } : {}),
        },
      });
      // The secret is not kept on this page once sent.
      setHeaderValue("");
      onAdded(result.server);
    } catch (caught) {
      setError(mcpErrorText(caught));
      setBusy(false);
    }
  };

  return (
    <form class="assistant-project-form" onSubmit={submit}>
      <div class="assistant-project-row">
        <label>
          <span>Name</span>
          <input
            value={label}
            maxLength={60}
            placeholder="Notion"
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Address</span>
          <input
            type="url"
            value={url}
            spellcheck={false}
            placeholder="https://mcp.example.com/mcp"
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
        </label>
      </div>
      <fieldset>
        <legend>Sign-in</legend>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="mcp-auth"
            checked={auth === "none"}
            onChange={() => setAuth("none")}
          />
          <span>
            <strong>None</strong>
            <small>A public server.</small>
          </span>
        </label>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="mcp-auth"
            checked={auth === "oauth"}
            onChange={() => setAuth("oauth")}
          />
          <span>
            <strong>Sign in with the service</strong>
            <small>
              After adding it, Sign in opens the service's page; you come back
              here when done.
            </small>
          </span>
        </label>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="mcp-auth"
            checked={auth === "header"}
            onChange={() => setAuth("header")}
          />
          <span>
            <strong>An API key in a header</strong>
            <small>Kept encrypted on the server; never shown again.</small>
          </span>
        </label>
      </fieldset>
      {auth === "header" && (
        <div class="assistant-project-row">
          <label>
            <span>Header</span>
            <input
              value={headerName}
              maxLength={64}
              spellcheck={false}
              onInput={(event) => setHeaderName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Value</span>
            <input
              type="password"
              value={headerValue}
              autoComplete="off"
              spellcheck={false}
              placeholder="Bearer …"
              onInput={(event) => setHeaderValue(event.currentTarget.value)}
            />
          </label>
        </div>
      )}
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button class="primary" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </footer>
    </form>
  );
}
