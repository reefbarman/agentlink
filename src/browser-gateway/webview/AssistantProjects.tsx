import { useEffect, useRef, useState } from "preact/hooks";

import type { ComponentChildren } from "preact";

/**
 * Project switcher for the AgentLink Assistant: the selected project, a
 * menu to switch or create projects, and the project's settings. Each
 * project has its own chats on the server, so switching reloads the app.
 */

interface AssistantProjectRepository {
  url: string;
  directory: string;
}

export interface AssistantProject {
  id: string;
  label: string;
  origin: "config" | "app";
  path: string;
  repositories: AssistantProjectRepository[];
  settings: { defaultModel?: string; defaultReasoningEffort?: string };
}

interface AssistantProjectList {
  activeProjectId: string | null;
  canCreate: boolean;
  canClone: boolean;
  projects: AssistantProject[];
}

interface AssistantModelOption {
  id: string;
  displayName?: string;
  providerDisplayName?: string;
  provider?: string;
  reasoningEfforts?: string[];
}

const ERROR_TEXT: Record<string, string> = {
  project_name_required: "Give the project a name.",
  project_name_too_long: "That name is too long.",
  repository_url_invalid:
    "Use an https:// clone URL without a username, token, or query.",
  too_many_repositories: "A project can start with up to 10 repositories.",
  project_creation_disabled:
    "This server has no projectsRoot, so it cannot create projects.",
  project_clone_unavailable: "This server cannot clone repositories.",
  project_clone_failed: "A repository could not be cloned.",
  invalid_model: "That model is not available.",
  instructions_too_large: "Instructions can be up to 64 KB.",
};

async function requestJson<T>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    headers:
      init?.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const code = typeof data.error === "string" ? data.error : "";
    const error = new Error(
      ERROR_TEXT[code] ?? `Request failed (${code || response.status}).`,
    ) as Error & { detail?: string; url?: string };
    if (typeof data.detail === "string") error.detail = data.detail;
    if (typeof data.url === "string") error.url = data.url;
    throw error;
  }
  return data as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetail(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown } | null)?.detail;
  const url = (error as { url?: unknown } | null)?.url;
  if (typeof detail !== "string") return undefined;
  return typeof url === "string" ? `${url}\n\n${detail}` : detail;
}

export function AssistantProjectSwitcher({
  reloadPage,
}: {
  reloadPage: () => void;
}) {
  const [list, setList] = useState<AssistantProjectList | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<"new" | "settings" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<AssistantProjectList>("/api/ask-agent/projects").then(
      (next) => {
        if (!cancelled) setList(next);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !rootRef.current?.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const active = list?.projects.find(
    (project) => project.id === list.activeProjectId,
  );

  const select = async (projectId: string) => {
    setMenuOpen(false);
    if (projectId === list?.activeProjectId) return;
    try {
      await requestJson("/api/ask-agent/projects/select", {
        method: "POST",
        body: { projectId },
      });
      reloadPage();
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  return (
    <div class="assistant-projects" ref={rootRef}>
      <button
        class="assistant-project-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Switch project"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <i class="codicon codicon-folder-library" aria-hidden="true" />
        <span class="assistant-project-name">
          <span class="assistant-project-eyebrow">Project</span>
          <span>{active?.label ?? (list ? "No project" : "Loading…")}</span>
        </span>
        <i class="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {menuOpen && list && (
        <div class="assistant-project-menu" role="menu">
          {list.projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={project.id === list.activeProjectId}
              class={`assistant-project-menu-item${project.id === list.activeProjectId ? " active" : ""}`}
              onClick={() => void select(project.id)}
            >
              <i
                class={`codicon ${project.id === list.activeProjectId ? "codicon-check" : "codicon-blank"}`}
                aria-hidden="true"
              />
              <span>{project.label}</span>
            </button>
          ))}
          <hr />
          {list.canCreate && (
            <button
              class="assistant-project-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDialog("new");
              }}
            >
              <i class="codicon codicon-add" aria-hidden="true" />
              <span>New project…</span>
            </button>
          )}
          {active && (
            <button
              class="assistant-project-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDialog("settings");
              }}
            >
              <i class="codicon codicon-settings-gear" aria-hidden="true" />
              <span>Project settings…</span>
            </button>
          )}
        </div>
      )}
      {dialog === "new" && list && (
        <NewProjectDialog
          canClone={list.canClone}
          onClose={() => setDialog(null)}
          onCreated={() => reloadPage()}
        />
      )}
      {dialog === "settings" && active && (
        <ProjectSettingsDialog
          projectId={active.id}
          onClose={() => setDialog(null)}
          onSaved={(project) => {
            setList((current) =>
              current
                ? {
                    ...current,
                    projects: current.projects.map((candidate) =>
                      candidate.id === project.id ? project : candidate,
                    ),
                  }
                : current,
            );
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div
      class="assistant-project-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        class="assistant-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            class="icon-button"
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <i class="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function NewProjectDialog({
  canClone,
  onClose,
  onCreated,
}: {
  canClone: boolean;
  onClose: () => void;
  onCreated: (project: AssistantProject) => void;
}) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"empty" | "clone">("empty");
  const [urls, setUrls] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(
    null,
  );

  const repositories =
    source === "clone" ? urls.map((url) => url.trim()).filter(Boolean) : [];
  const canSubmit =
    !busy && name.trim() !== "" && (source === "empty" || repositories.length);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson<{ project: AssistantProject }>(
        "/api/ask-agent/projects",
        { method: "POST", body: { name: name.trim(), repositories } },
      );
      onCreated(result.project);
    } catch (caught) {
      setError({ text: errorText(caught), detail: errorDetail(caught) });
      setBusy(false);
    }
  };

  return (
    <Dialog title="New project" onClose={onClose} busy={busy}>
      <form class="assistant-project-form" onSubmit={submit}>
        <label>
          <span>Name</span>
          <input
            value={name}
            maxLength={80}
            placeholder="Trip planning, my-app, …"
            onInput={(event) => setName(event.currentTarget.value)}
            autoFocus
          />
        </label>
        <fieldset>
          <legend>Start with</legend>
          <label class="assistant-project-choice">
            <input
              type="radio"
              name="project-source"
              checked={source === "empty"}
              onChange={() => setSource("empty")}
            />
            <span>
              <strong>An empty folder</strong>
              <small>For notes, research, or anything not in git yet.</small>
            </span>
          </label>
          <label class="assistant-project-choice">
            <input
              type="radio"
              name="project-source"
              checked={source === "clone"}
              disabled={!canClone}
              onChange={() => setSource("clone")}
            />
            <span>
              <strong>Git repositories</strong>
              <small>
                {canClone
                  ? "Cloned side by side, one folder each."
                  : "Cloning is not available on this server."}
              </small>
            </span>
          </label>
        </fieldset>
        {source === "clone" && (
          <div class="assistant-project-repos">
            {urls.map((url, index) => (
              <div class="assistant-project-repo" key={index}>
                <input
                  aria-label={`Repository ${index + 1} URL`}
                  value={url}
                  placeholder="https://github.com/owner/repo.git"
                  inputMode="url"
                  onInput={(event) => {
                    const value = event.currentTarget.value;
                    setUrls((current) =>
                      current.map((item, position) =>
                        position === index ? value : item,
                      ),
                    );
                  }}
                />
                {urls.length > 1 && (
                  <button
                    class="icon-button"
                    type="button"
                    aria-label={`Remove repository ${index + 1}`}
                    onClick={() =>
                      setUrls((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <i class="codicon codicon-trash" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            {urls.length < 10 && (
              <button
                class="assistant-project-link"
                type="button"
                onClick={() => setUrls((current) => [...current, ""])}
              >
                <i class="codicon codicon-add" aria-hidden="true" /> Add another
                repository
              </button>
            )}
            <p class="assistant-project-hint">
              Public https URLs work out of the box. Hosts other than GitHub
              need to be on the egress allowlist.
            </p>
          </div>
        )}
        {error && (
          <div class="assistant-project-error" role="alert">
            <p>{error.text}</p>
            {error.detail && <pre>{error.detail}</pre>}
          </div>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={!canSubmit}>
            {busy
              ? repositories.length
                ? "Cloning…"
                : "Creating…"
              : "Create project"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function ProjectSettingsDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (project: AssistantProject) => void;
}) {
  const [loaded, setLoaded] = useState<{
    project: AssistantProject;
    instructionsTruncated: boolean;
  } | null>(null);
  const [models, setModels] = useState<AssistantModelOption[]>([]);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      requestJson<{
        project: AssistantProject;
        instructions: string;
        instructionsTruncated: boolean;
      }>(`/api/ask-agent/projects/${encodeURIComponent(projectId)}/settings`),
      requestJson<{ models: AssistantModelOption[] }>(
        "/api/ask-agent/models",
      ).catch(() => ({ models: [] })),
    ]).then(
      ([settings, catalog]) => {
        if (cancelled) return;
        setLoaded(settings);
        setModels(catalog.models);
        setName(settings.project.label);
        setModel(settings.project.settings.defaultModel ?? "");
        setEffort(settings.project.settings.defaultReasoningEffort ?? "");
        setInstructions(settings.instructions);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const efforts = models.find((option) => option.id === model)
    ?.reasoningEfforts ?? [
    ...new Set(models.flatMap((option) => option.reasoningEfforts ?? [])),
  ];

  const save = async (event: Event) => {
    event.preventDefault();
    if (!loaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson<{ project: AssistantProject }>(
        `/api/ask-agent/projects/${encodeURIComponent(projectId)}/settings`,
        {
          method: "POST",
          body: {
            name,
            defaultModel: model || null,
            defaultReasoningEffort: effort || null,
            ...(loaded.instructionsTruncated ? {} : { instructions }),
          },
        },
      );
      onSaved(result.project);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Project settings" onClose={onClose} busy={busy}>
      {!loaded ? (
        <p class="assistant-project-hint">{error ?? "Loading…"}</p>
      ) : (
        <form class="assistant-project-form" onSubmit={save}>
          <label>
            <span>Name</span>
            <input
              value={name}
              maxLength={80}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <div class="assistant-project-row">
            <label>
              <span>Default model for new chats</span>
              <select
                value={model}
                onChange={(event) => setModel(event.currentTarget.value)}
              >
                <option value="">Server default</option>
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.displayName ?? option.id}
                    {option.providerDisplayName
                      ? ` · ${option.providerDisplayName}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Thinking</span>
              <select
                value={effort}
                onChange={(event) => setEffort(event.currentTarget.value)}
              >
                <option value="">Model default</option>
                {efforts.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Instructions (AGENTS.md)</span>
            <textarea
              rows={8}
              value={instructions}
              readOnly={loaded.instructionsTruncated}
              placeholder="How the assistant should work in this project."
              onInput={(event) => setInstructions(event.currentTarget.value)}
            />
            {loaded.instructionsTruncated && (
              <small>
                AGENTS.md is larger than 64 KB; edit it in a chat instead.
              </small>
            )}
          </label>
          <dl class="assistant-project-facts">
            <dt>Folder</dt>
            <dd>
              <code>{loaded.project.path}</code>
            </dd>
            {loaded.project.repositories.length > 0 && (
              <>
                <dt>Repositories</dt>
                <dd>
                  <ul>
                    {loaded.project.repositories.map((repository) => (
                      <li key={repository.directory}>
                        <code>{repository.directory}/</code> ← {repository.url}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          {error && (
            <p class="assistant-project-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button class="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
