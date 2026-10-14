import { Dialog, errorText, requestJson } from "./AssistantProjects";
import { useEffect, useState } from "preact/hooks";

/**
 * GitHub for the AgentLink Assistant's coding tasks: the accounts tasks
 * publish with (connected through the GitHub App's device code, or a
 * fine-grained token), and per repository the validation commands the
 * server runs and which connection may publish its tasks. Tokens never
 * reach this page: the server only reports each connection's status.
 */

export type ConnectionStatus =
  | {
      status: "pending";
      userCode: string;
      verificationUri: string;
      expiresAt: number;
    }
  | {
      status: "connected";
      kind: "app" | "token";
      login: string;
      signedIn: boolean;
    }
  | { status: "denied" | "expired" | "missing" }
  | { status: "failed" | "unavailable"; error: string };

export interface GitHubConnection {
  id: string;
  kind: "app" | "token";
  login?: string;
  commitName: string;
  commitEmail: string;
}

interface GitHubInfo {
  configured: boolean;
  available: boolean;
  deviceFlow: boolean;
  connections: { connection: GitHubConnection; status: ConnectionStatus }[];
}

export interface RepositorySettings {
  repository: string;
  validation: string[];
  publish?: { connectionId: string; grantedAt: number };
}

type PendingSignIn = {
  connectionId: string;
  userCode: string;
  verificationUri: string;
};

/** What a connection's status means for the owner, in a few words. */
export function connectionStatusLabel(status: ConnectionStatus): {
  text: string;
  tone: "ok" | "warn" | "bad" | "busy" | "muted";
} {
  switch (status.status) {
    case "connected":
      return status.signedIn
        ? { text: `Signed in as @${status.login}`, tone: "ok" }
        : { text: "Signed out: sign in again", tone: "warn" };
    case "pending":
      return { text: "Waiting for you to enter the code", tone: "busy" };
    case "denied":
      return { text: "Sign-in was declined", tone: "bad" };
    case "expired":
      return { text: "The code expired: sign in again", tone: "warn" };
    case "missing":
      return { text: "Not signed in", tone: "warn" };
    case "unavailable":
      return { text: "Publisher not reachable", tone: "muted" };
    case "failed":
      return { text: "Sign-in failed", tone: "bad" };
  }
}

/** One command per line, blank lines dropped. */
export function parseCommands(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function GitHubPanel({
  onClose,
  pollMs = 5_000,
}: {
  onClose: () => void;
  pollMs?: number;
}) {
  const [info, setInfo] = useState<GitHubInfo | null>(null);
  const [repositories, setRepositories] = useState<RepositorySettings[]>([]);
  const [view, setView] = useState<
    | { kind: "list" }
    | { kind: "connect" }
    | { kind: "repository"; settings: RepositorySettings | null }
  >({ kind: "list" });
  const [signIn, setSignIn] = useState<PendingSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      requestJson<GitHubInfo>("/api/github"),
      requestJson<{ repositories: RepositorySettings[] }>(
        "/api/tasks/repositories",
      ),
    ]).then(
      ([github, settings]) => {
        if (cancelled) return;
        setInfo(github);
        setRepositories(settings.repositories);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  // While a code is shown, follow the sign-in until GitHub answers.
  useEffect(() => {
    if (!signIn) return undefined;
    const timer = setInterval(() => {
      requestJson<{ status: ConnectionStatus }>(
        `/api/github/connections/${encodeURIComponent(signIn.connectionId)}`,
      ).then(
        ({ status }) => {
          if (status.status === "pending") return;
          setSignIn(null);
          setNotice(
            status.status === "connected"
              ? `Connected as @${status.login}.`
              : connectionStatusLabel(status).text,
          );
          setReloads((count) => count + 1);
        },
        () => undefined,
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [signIn, pollMs]);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      setReloads((count) => count + 1);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const startSignIn = (connectionId: string, status: ConnectionStatus) => {
    if (status.status === "pending") {
      setSignIn({
        connectionId,
        userCode: status.userCode,
        verificationUri: status.verificationUri,
      });
    }
  };

  const connections = info?.connections ?? [];
  const connectionName = (id: string | undefined) => {
    const entry = connections.find((item) => item.connection.id === id);
    if (!entry) return "an unknown connection";
    return entry.connection.login
      ? `@${entry.connection.login}`
      : entry.connection.commitName;
  };

  if (view.kind === "connect") {
    return (
      <Dialog title="Connect GitHub" onClose={onClose} wide>
        <ConnectForm
          deviceFlow={info?.deviceFlow ?? false}
          onCancel={() => setView({ kind: "list" })}
          onConnected={(connectionId, status) => {
            setView({ kind: "list" });
            startSignIn(connectionId, status);
            if (status.status === "connected") {
              setNotice(`Connected as @${status.login}.`);
            }
            setReloads((count) => count + 1);
          }}
        />
      </Dialog>
    );
  }

  if (view.kind === "repository") {
    return (
      <Dialog
        title={view.settings ? "Repository" : "Add a repository"}
        onClose={onClose}
        wide
      >
        <RepositoryForm
          settings={view.settings}
          connections={connections.map((entry) => entry.connection)}
          onCancel={() => setView({ kind: "list" })}
          onSaved={() => {
            setView({ kind: "list" });
            setReloads((count) => count + 1);
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="GitHub"
      onClose={onClose}
      wide
      actions={
        <button
          type="button"
          class="assistant-panel-action primary"
          disabled={!info?.configured || !info.available}
          onClick={() => setView({ kind: "connect" })}
        >
          <i class="codicon codicon-add" aria-hidden="true" /> Connect GitHub
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
      {signIn && (
        <div class="assistant-github-code" role="status">
          <p>
            Enter this code at{" "}
            <a href={signIn.verificationUri} target="_blank" rel="noreferrer">
              {signIn.verificationUri.replace(/^https:\/\//u, "")}
            </a>{" "}
            and approve AgentLink Assistant:
          </p>
          <code aria-label="GitHub code">{signIn.userCode}</code>
          <p class="assistant-project-hint">
            This updates by itself once GitHub confirms.
          </p>
        </div>
      )}
      {!info ? (
        <p class="assistant-project-hint">{error ? "" : "Loading…"}</p>
      ) : (
        <>
          {!info.configured ? (
            <p class="assistant-project-hint">
              Publishing is not set up on this server. Add the publisher (see
              "Publishing tasks to GitHub" in the server README) to connect
              GitHub and open pull requests.
            </p>
          ) : !info.available ? (
            <p class="assistant-project-error" role="alert">
              The publisher is not reachable, so GitHub cannot be connected
              right now.
            </p>
          ) : null}
          <section class="assistant-inbox-group">
            <h3>Connections</h3>
            {connections.length === 0 ? (
              <p class="assistant-project-hint">
                No GitHub accounts yet. A connection is one account, and the
                name and email its task commits credit as co-author.
              </p>
            ) : (
              <ul class="assistant-job-list">
                {connections.map(({ connection, status }) => {
                  const label = connectionStatusLabel(status);
                  const needsSignIn =
                    status.status !== "pending" &&
                    !(status.status === "connected" && status.signedIn);
                  return (
                    <li class="assistant-job" key={connection.id}>
                      <div class="assistant-job-main">
                        <strong>
                          {connection.login
                            ? `@${connection.login}`
                            : connection.commitName}
                        </strong>
                        <span class="assistant-job-meta">
                          <span
                            class={`assistant-run-status tone-${label.tone}`}
                          >
                            {label.text}
                          </span>
                          {" · "}
                          {connection.kind === "app"
                            ? "GitHub App"
                            : "Fine-grained token"}
                        </span>
                        <span class="assistant-job-meta">
                          Commits credit {connection.commitName} &lt;
                          {connection.commitEmail}&gt;
                        </span>
                      </div>
                      <div class="assistant-job-actions">
                        {needsSignIn && info.deviceFlow && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(connection.id, async () => {
                                const result = await requestJson<{
                                  status: ConnectionStatus;
                                }>(
                                  `/api/github/connections/${encodeURIComponent(connection.id)}/device`,
                                  { method: "POST" },
                                );
                                startSignIn(connection.id, result.status);
                              })
                            }
                          >
                            <i
                              class="codicon codicon-sign-in"
                              aria-hidden="true"
                            />{" "}
                            Sign in again
                          </button>
                        )}
                        <button
                          type="button"
                          class="icon-button"
                          aria-label={`Remove ${connection.login ? `@${connection.login}` : connection.commitName}`}
                          title="Remove (revokes the repositories that use it)"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(connection.id, () =>
                              requestJson(
                                `/api/github/connections/${encodeURIComponent(connection.id)}`,
                                { method: "DELETE" },
                              ),
                            )
                          }
                        >
                          <i class="codicon codicon-trash" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section class="assistant-inbox-group">
            <h3>
              Repositories
              <button
                type="button"
                class="assistant-panel-action"
                onClick={() => setView({ kind: "repository", settings: null })}
              >
                <i class="codicon codicon-add" aria-hidden="true" /> Add
              </button>
            </h3>
            {repositories.length === 0 ? (
              <p class="assistant-project-hint">
                No repository settings yet. Add one to set the commands every
                task's commit must pass, and whether its tasks may be published
                as draft pull requests.
              </p>
            ) : (
              <ul class="assistant-job-list">
                {repositories.map((settings) => (
                  <li class="assistant-job" key={settings.repository}>
                    <div class="assistant-job-main">
                      <strong>
                        {settings.repository.replace(/^https:\/\//u, "")}
                      </strong>
                      <span class="assistant-job-meta">
                        {settings.validation.length === 0
                          ? "No validation commands"
                          : `${settings.validation.length} validation command${settings.validation.length === 1 ? "" : "s"}`}
                        {" · "}
                        {settings.publish
                          ? `Publishes draft PRs as ${connectionName(settings.publish.connectionId)}`
                          : "Not published"}
                      </span>
                    </div>
                    <div class="assistant-job-actions">
                      <button
                        type="button"
                        onClick={() =>
                          setView({ kind: "repository", settings })
                        }
                      >
                        <i class="codicon codicon-edit" aria-hidden="true" />{" "}
                        Edit
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Dialog>
  );
}

function ConnectForm({
  deviceFlow,
  onCancel,
  onConnected,
}: {
  deviceFlow: boolean;
  onCancel: () => void;
  onConnected: (connectionId: string, status: ConnectionStatus) => void;
}) {
  const [method, setMethod] = useState<"device" | "token">(
    deviceFlow ? "device" : "token",
  );
  const [commitName, setCommitName] = useState("");
  const [commitEmail, setCommitEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson<{
        connection: GitHubConnection;
        status: ConnectionStatus;
      }>("/api/github/connections", {
        method: "POST",
        body: {
          method,
          commitName,
          commitEmail,
          ...(method === "token" ? { token } : {}),
        },
      });
      // The token is not kept on this page once sent.
      setToken("");
      onConnected(result.connection.id, result.status);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <form class="assistant-project-form" onSubmit={submit}>
      <p class="assistant-project-hint">
        Task commits are written by AgentLink Assistant and credit this person
        as co-author. Use the name and email of the GitHub account you connect.
      </p>
      <div class="assistant-project-row">
        <label>
          <span>Name</span>
          <input
            value={commitName}
            maxLength={100}
            autoComplete="name"
            onInput={(event) => setCommitName(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={commitEmail}
            maxLength={254}
            autoComplete="email"
            onInput={(event) => setCommitEmail(event.currentTarget.value)}
          />
        </label>
      </div>
      <fieldset>
        <legend>Sign in with</legend>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="github-method"
            checked={method === "device"}
            disabled={!deviceFlow}
            onChange={() => setMethod("device")}
          />
          <span>
            <strong>GitHub App (recommended)</strong>
            <small>
              {deviceFlow
                ? "Shows a code to enter on github.com. Works on the repositories you install the app on."
                : "Not available: the publisher has no GitHub App client ID."}
            </small>
          </span>
        </label>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="github-method"
            checked={method === "token"}
            onChange={() => setMethod("token")}
          />
          <span>
            <strong>Fine-grained token</strong>
            <small>
              For repositories the app cannot be installed on. Give it Contents
              and Pull requests (read and write) on those repositories only.
            </small>
          </span>
        </label>
      </fieldset>
      {method === "token" && (
        <label>
          <span>Token</span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            spellcheck={false}
            placeholder="github_pat_…"
            onInput={(event) => setToken(event.currentTarget.value)}
          />
        </label>
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
          {busy
            ? "Connecting…"
            : method === "device"
              ? "Get a code"
              : "Connect"}
        </button>
      </footer>
    </form>
  );
}

function RepositoryForm({
  settings,
  connections,
  onCancel,
  onSaved,
}: {
  settings: RepositorySettings | null;
  connections: GitHubConnection[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [repository, setRepository] = useState(settings?.repository ?? "");
  const [commands, setCommands] = useState(
    settings?.validation.join("\n") ?? "",
  );
  const [connectionId, setConnectionId] = useState(
    settings?.publish?.connectionId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/tasks/repositories", {
        method: "PUT",
        body: {
          repository: repository.trim(),
          validation: parseCommands(commands),
          connectionId: connectionId || null,
        },
      });
      onSaved();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <form class="assistant-project-form" onSubmit={submit}>
      <label>
        <span>Repository</span>
        <input
          value={repository}
          readOnly={settings !== null}
          placeholder="https://github.com/you/repo"
          onInput={(event) => setRepository(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>
          Validation commands, one per line (run in order on each task's commit;
          all must pass)
        </span>
        <textarea
          rows={4}
          value={commands}
          spellcheck={false}
          placeholder={"npm ci\nnpm test"}
          onInput={(event) => setCommands(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>Publish tasks as draft pull requests with</span>
        <select
          value={connectionId}
          onChange={(event) => setConnectionId(event.currentTarget.value)}
        >
          <option value="">Don't publish</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.login
                ? `@${connection.login}`
                : connection.commitName}
            </option>
          ))}
        </select>
      </label>
      <p class="assistant-project-hint">
        Publishing pushes each task's commit to its own agentlink/ branch (never
        forced) and opens or updates that task's draft pull request. It never
        merges, comments elsewhere, or touches other branches.
      </p>
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
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </form>
  );
}
