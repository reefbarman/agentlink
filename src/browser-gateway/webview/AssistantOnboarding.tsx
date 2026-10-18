import { Dialog, errorText, requestJson } from "./AssistantProjects";
import {
  deviceTimeZone,
  formFromSettings,
  patchFromForm,
  type PersonaSettings,
} from "./AssistantSettings";
import { useEffect, useState } from "preact/hooks";

/**
 * First-run setup for the AgentLink Assistant: connect ChatGPT, confirm the
 * name, time zone and quiet hours, point at optional connections, and check
 * that backups work. Every step can be skipped and resumed; progress lives
 * on the server, so another device or a reload carries on where it was.
 * Nothing here runs a task, creates a job or connects an integration.
 */

export interface OnboardingRecord {
  revision: number;
  freshInstall: boolean;
  steps: Partial<
    Record<
      "model" | "preferences" | "connections",
      { state: "done" | "deferred"; at: number }
    >
  >;
  backupPasswordSavedAt?: number;
  completedAt?: number;
  dismissedAt?: number;
}

export interface OnboardingState {
  record: OnboardingRecord | null;
  facts: {
    model: {
      codexAvailable: boolean;
      codexSignedIn: boolean;
      otherProviders: number;
      openAiKeyAvailable?: boolean;
      openAiKeySaved?: boolean;
    };
    backup: {
      configured: boolean;
      lastSuccessAt?: number;
      failing?: boolean;
      reachable?: boolean;
    };
    features?: {
      editor: FeatureState;
      browser: FeatureState;
    };
  };
  status: "setup-incomplete" | "backup-degraded" | "ready";
  openSetup: boolean;
}

type FeatureState = "on" | "off" | "needs-runners";

const FEATURES: ReadonlyArray<{
  id: "editor" | "browser";
  label: string;
  description: string;
}> = [
  {
    id: "editor",
    label: "Edit task workspaces",
    description:
      "An Open editor button on coding tasks: a browser editor for one task folder, served on port 8444.",
  },
  {
    id: "browser",
    label: "Research with a browser",
    description:
      "Chats on Open web projects can use a throwaway, signed-out browser for pages that need JavaScript.",
  },
];

const FEATURE_STATE_LABEL: Record<FeatureState, string> = {
  on: "On",
  off: "Off",
  "needs-runners": "Not available",
};

/**
 * Optional features are turned on or off on the machine itself, with the
 * installer. The browser shows their state and the fixed command only.
 */
export function OptionalFeatures({
  features,
}: {
  features: NonNullable<OnboardingState["facts"]["features"]>;
}) {
  return (
    <section class="assistant-settings-section" aria-label="Optional features">
      <h3>Optional features</h3>
      <p>
        Off unless you turn them on. Change them in a terminal on the machine
        running the Assistant (add <code>--deploy FOLDER</code> if you installed
        it somewhere other than <code>~/agentlink-assistant</code>). Running
        work is paused and backed up first, and a failed change is undone.
      </p>
      <ul class="assistant-settings-list">
        {FEATURES.map((feature) => {
          const state = features[feature.id];
          return (
            <li class="assistant-settings-row" key={feature.id}>
              <strong>{feature.label}</strong>
              <span>
                {FEATURE_STATE_LABEL[state]}. {feature.description}{" "}
                {state === "needs-runners" ? (
                  "It needs session runners, which this installation does not have."
                ) : (
                  <code>
                    bash ~/agentlink-assistant/install.sh{" "}
                    {state === "on" ? "disable" : "enable"} {feature.id}
                  </code>
                )}
              </span>
            </li>
          );
        })}
        <li class="assistant-settings-row">
          <strong>Claude models and SearXNG search</strong>
          <span>
            Advanced setup by hand: see the server README (Meridian and
            SearXNG).
          </span>
        </li>
      </ul>
    </section>
  );
}

export interface CodexStatus {
  available: boolean;
  accounts: Array<{ label: string; active: boolean }>;
  pending: { mine: boolean; deviceLabel: string; expiresAt: number } | null;
}

interface ModelReference {
  providerId: string;
  modelId: string;
}

interface ModelOption extends ModelReference {
  displayName?: string;
  providerDisplayName?: string;
}

export interface OpenAiStatus {
  revision: number;
  openai: {
    state:
      | "unavailable"
      | "externally-managed"
      | "not-set"
      | "saved"
      | "unreadable";
    label?: string;
    savedAt?: number;
  };
  openAiModels: ModelOption[];
  availableModels: ModelOption[];
  defaultModel: ModelReference;
  defaultModelSource: "setup" | "server";
  ignoredDefaultModel?: ModelReference;
}

const modelKey = (model: ModelReference) =>
  `${model.providerId}/${model.modelId}`;

const modelLabel = (model: ModelOption) =>
  `${model.displayName ?? model.modelId} (${model.providerDisplayName ?? model.providerId})`;

type Step = "welcome" | "model" | "preferences" | "connections" | "summary";
const STEPS: ReadonlyArray<{ id: Step; label: string }> = [
  { id: "welcome", label: "Welcome" },
  { id: "model", label: "Model" },
  { id: "preferences", label: "Preferences" },
  { id: "connections", label: "Connections" },
  { id: "summary", label: "Check" },
];

export function setupStatusLabel(status: OnboardingState["status"]): string {
  switch (status) {
    case "ready":
      return "Set up";
    case "backup-degraded":
      return "Ready to chat, but backups need attention";
    default:
      return "Setup not finished";
  }
}

export async function loadOnboarding(): Promise<OnboardingState> {
  return await requestJson<OnboardingState>("/api/onboarding");
}

export async function patchOnboarding(
  revision: number,
  change: Record<string, unknown>,
): Promise<OnboardingState> {
  return await requestJson<OnboardingState>("/api/onboarding", {
    method: "PATCH",
    body: { expectedRevision: revision, ...change },
  });
}

export function SetupPanel({
  initial,
  onClose,
  openPanel,
}: {
  initial?: OnboardingState;
  onClose: (state: OnboardingState | null) => void;
  /** Close setup and open another panel (GitHub or MCP). */
  openPanel: (view: "github" | "mcp") => void;
}) {
  const [state, setState] = useState<OnboardingState | null>(initial ?? null);
  const [step, setStep] = useState<Step>("welcome");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    loadOnboarding().then(
      (body) => {
        if (!cancelled) setState(body);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Record progress; a change from another tab reloads instead. */
  const record = async (change: Record<string, unknown>): Promise<boolean> => {
    if (!state) return false;
    setBusy(true);
    setError(null);
    try {
      setState(await patchOnboarding(state.record?.revision ?? 0, change));
      return true;
    } catch (caught) {
      setError(errorText(caught));
      await loadOnboarding()
        .then(setState)
        .catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const next = async (
    current: "model" | "preferences" | "connections",
    outcome: "done" | "deferred",
    to: Step,
  ) => {
    if (await record({ step: { id: current, state: outcome } })) setStep(to);
  };
  const index = STEPS.findIndex((entry) => entry.id === step);

  return (
    <Dialog
      title="Set up the Assistant"
      onClose={() => onClose(state)}
      busy={busy}
      wide
    >
      <ol class="assistant-setup-steps" aria-label="Setup steps">
        {STEPS.map((entry, position) => (
          <li
            key={entry.id}
            class={position === index ? "current" : undefined}
            aria-current={position === index ? "step" : undefined}
          >
            <button
              type="button"
              class="link-button"
              disabled={busy}
              onClick={() => setStep(entry.id)}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ol>
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {!state && !error && <p class="assistant-panel-empty">Loading…</p>}
      {state && step === "welcome" && (
        <section class="assistant-settings-section" aria-label="Welcome">
          <h3>Welcome</h3>
          <p>
            A few steps get the Assistant ready: connect ChatGPT (or an OpenAI
            API key), check your name, time zone and quiet hours, and make sure
            backups work. You can skip any step and come back later from{" "}
            <strong>Setup</strong>. Nothing here starts a task, creates a job or
            connects a service on its own.
          </p>
          <footer class="assistant-settings-actions">
            <button
              class="primary"
              type="button"
              onClick={() => setStep("model")}
            >
              Start
            </button>
          </footer>
        </section>
      )}
      {state && step === "model" && (
        <ModelStep
          busy={busy}
          onSkip={() => void next("model", "deferred", "preferences")}
          onDone={() => void next("model", "done", "preferences")}
          onSignedIn={() =>
            void loadOnboarding()
              .then(setState)
              .catch(() => undefined)
          }
        />
      )}
      {state && step === "preferences" && (
        <PreferencesStep
          busy={busy}
          onSkip={() => void next("preferences", "deferred", "connections")}
          onSaved={() => void next("preferences", "done", "connections")}
        />
      )}
      {state && step === "connections" && (
        <section class="assistant-settings-section" aria-label="Connections">
          <h3>Optional connections</h3>
          <p>
            None of these are needed to chat. Connect them now or later from the
            toolbar.
          </p>
          <ul class="assistant-settings-list">
            <li class="assistant-settings-row">
              <strong>GitHub</strong>
              <span>
                For coding tasks and draft pull requests. A fine-grained token
                works straight away; GitHub App sign-in needs a client ID set up
                by the server's operator.{" "}
                <button
                  type="button"
                  class="link-button"
                  onClick={() => openPanel("github")}
                >
                  Open GitHub
                </button>
              </span>
            </li>
            <li class="assistant-settings-row">
              <strong>MCP servers</strong>
              <span>
                Other services the Assistant can use, such as Home Assistant.
                Their tools still ask before they change anything.{" "}
                <button
                  type="button"
                  class="link-button"
                  onClick={() => openPanel("mcp")}
                >
                  Open MCP
                </button>
              </span>
            </li>
          </ul>
          {state.facts.features && (
            <OptionalFeatures features={state.facts.features} />
          )}
          <footer class="assistant-settings-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void next("connections", "deferred", "summary")}
            >
              Skip for now
            </button>
            <button
              class="primary"
              type="button"
              disabled={busy}
              onClick={() => void next("connections", "done", "summary")}
            >
              Continue
            </button>
          </footer>
        </section>
      )}
      {state && step === "summary" && (
        <SummaryStep
          state={state}
          busy={busy}
          onPasswordSaved={() => void record({ backupPasswordSaved: true })}
          onFinish={async () => {
            if (await record({ complete: true })) onClose(null);
          }}
        />
      )}
    </Dialog>
  );
}

function ModelStep({
  busy,
  onSkip,
  onDone,
  onSignedIn,
}: {
  busy: boolean;
  onSkip: () => void;
  onDone: () => void;
  onSignedIn: () => void;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [openAiSaved, setOpenAiSaved] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    requestJson<CodexStatus>("/api/providers/codex").then(
      (body) => {
        if (!cancelled) setStatus(body);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const call = async (run: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await run();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setWorking(false);
    }
  };
  const start = () =>
    call(async () => {
      const body = await requestJson<{ authorizeUrl: string }>(
        "/api/providers/codex/sign-in",
        { method: "POST", body: {} },
      );
      setAuthorizeUrl(body.authorizeUrl);
    });
  const cancel = () =>
    call(async () => {
      setStatus(
        await requestJson<CodexStatus>("/api/providers/codex/sign-in", {
          method: "DELETE",
        }),
      );
      setAuthorizeUrl(null);
      setAddress("");
    });
  const finish = () =>
    call(async () => {
      const redirectUrl = address.trim();
      // Only ever held in this form; cleared whatever the outcome.
      setAddress("");
      try {
        setStatus(
          await requestJson<CodexStatus>(
            "/api/providers/codex/sign-in/complete",
            { method: "POST", body: { redirectUrl } },
          ),
        );
        setAuthorizeUrl(null);
        onSignedIn();
      } catch (caught) {
        // Each sign-in link works once; start again after a failure.
        setAuthorizeUrl(null);
        throw caught;
      }
    });
  const signedIn = status?.accounts.find((account) => account.active);
  const disabled = busy || working;
  return (
    <section class="assistant-settings-section" aria-label="Model">
      <h3>Connect ChatGPT</h3>
      {!status && !error && <p class="assistant-panel-empty">Checking…</p>}
      {status && !status.available && (
        <p>
          This server's models are set up by its operator in{" "}
          <code>server.json</code>, not here. You can carry on.
        </p>
      )}
      {status?.available && signedIn && (
        <p class="assistant-panel-notice" role="status">
          Signed in as {signedIn.label}. Chats use your ChatGPT plan.
        </p>
      )}
      {status?.available && !signedIn && !authorizeUrl && (
        <>
          <p>
            Chats use your ChatGPT plan. Sign-in happens on OpenAI's site; this
            server never sees your password.
          </p>
          {status.pending && !status.pending.mine && (
            <p class="assistant-panel-notice" role="status">
              A sign-in started on {status.pending.deviceLabel} is still
              waiting. Finish or cancel it there, or wait ten minutes.
            </p>
          )}
        </>
      )}
      {authorizeUrl && (
        <ol class="assistant-setup-instructions">
          <li>
            <a href={authorizeUrl} target="_blank" rel="noopener noreferrer">
              Open ChatGPT sign-in
            </a>{" "}
            in a new tab and sign in.
          </li>
          <li>
            The tab then goes to an <code>http://localhost:1455/…</code> page
            that does not load. That is expected.
          </li>
          <li>
            <label>
              <span>Copy that whole address from the address bar here</span>
              <textarea
                rows={3}
                value={address}
                spellcheck={false}
                autocomplete="off"
                placeholder="http://localhost:1455/auth/callback?code=…"
                onInput={(event) => setAddress(event.currentTarget.value)}
              />
            </label>
          </li>
        </ol>
      )}
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {!authorizeUrl && (
        <OpenAiKeySection
          busy={disabled}
          onChanged={(saved) => {
            setOpenAiSaved(saved);
            onSignedIn();
          }}
        />
      )}
      <footer class="assistant-settings-actions">
        {authorizeUrl ? (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void cancel()}
            >
              Cancel sign-in
            </button>
            <button
              class="primary"
              type="button"
              disabled={disabled || !address.trim()}
              onClick={() => void finish()}
            >
              {working ? "Signing in…" : "Finish sign-in"}
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={disabled} onClick={onSkip}>
              Skip for now
            </button>
            {status?.available && !signedIn && (
              <button
                class={openAiSaved ? undefined : "primary"}
                type="button"
                disabled={
                  disabled || (status.pending !== null && !status.pending.mine)
                }
                onClick={() => void start()}
              >
                Sign in with ChatGPT
              </button>
            )}
            {(!status?.available || signedIn || openAiSaved) && (
              <button
                class="primary"
                type="button"
                disabled={disabled || !status}
                onClick={onDone}
              >
                Continue
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  );
}

/**
 * The OpenAI API key alternative. The key field is write-only: the server
 * returns a redacted label, never the key, and the field is cleared after
 * every attempt. Saving sends nothing to OpenAI.
 */
function OpenAiKeySection({
  busy,
  onChanged,
}: {
  busy: boolean;
  /** After a save, removal or default change; `saved`: a key is stored. */
  onChanged: (saved: boolean) => void;
}) {
  const [status, setStatus] = useState<OpenAiStatus | null>(null);
  const [key, setKey] = useState("");
  const [choice, setChoice] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const show = (body: OpenAiStatus) => {
    setStatus(body);
    setChoice(modelKey(body.defaultModel));
  };
  useEffect(() => {
    let cancelled = false;
    requestJson<OpenAiStatus>("/api/providers/openai").then(
      (body) => {
        if (cancelled) return;
        show(body);
        if (body.openai.state === "saved") onChanged(true);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const call = async (run: () => Promise<OpenAiStatus>) => {
    setWorking(true);
    setError(null);
    try {
      const body = await run();
      show(body);
      onChanged(body.openai.state === "saved");
    } catch (caught) {
      setError(errorText(caught));
      // A change elsewhere (or a failed save) shows what is stored now.
      await requestJson<OpenAiStatus>("/api/providers/openai")
        .then(show)
        .catch(() => undefined);
    } finally {
      setWorking(false);
    }
  };
  if (!status || status.openai.state === "unavailable") {
    return error ? (
      <div class="assistant-project-error" role="alert">
        <p>{error}</p>
      </div>
    ) : null;
  }
  const disabled = busy || working;
  const save = (event: Event) => {
    event.preventDefault();
    const apiKey = key.trim();
    // Only ever held in this field; cleared whatever the outcome.
    setKey("");
    void call(() =>
      requestJson<OpenAiStatus>("/api/providers/openai/key", {
        method: "PUT",
        body: { expectedRevision: status.revision, apiKey },
      }),
    );
  };
  const remove = () =>
    void call(() =>
      requestJson<OpenAiStatus>("/api/providers/openai/key", {
        method: "DELETE",
        body: { expectedRevision: status.revision },
      }),
    );
  const chosen = status.availableModels.find(
    (model) => modelKey(model) === choice,
  );
  const useDefault = () =>
    void call(() =>
      requestJson<OpenAiStatus>("/api/providers/default-model", {
        method: "PUT",
        body: {
          expectedRevision: status.revision,
          model: chosen
            ? { providerId: chosen.providerId, modelId: chosen.modelId }
            : null,
        },
      }),
    );
  const state = status.openai.state;
  const current = status.availableModels.find(
    (model) => modelKey(model) === modelKey(status.defaultModel),
  );
  return (
    <div class="assistant-setup-alternative">
      <h4>Or use an OpenAI API key</h4>
      {state === "externally-managed" ? (
        <p>
          OpenAI is set up by this server's operator in <code>server.json</code>
          , not here.
        </p>
      ) : (
        <>
          <p>
            API use is billed by OpenAI to the key's account, separately from
            any ChatGPT subscription. Saving a key sends nothing to OpenAI: the
            first chat that uses it is the first billed request.
          </p>
          {state === "saved" && (
            <p class="assistant-panel-notice" role="status">
              Key saved ({status.openai.label}). It has not been checked with
              OpenAI; the first chat will show if it works.
            </p>
          )}
          {state === "unreadable" && (
            <p class="assistant-panel-notice" role="status">
              The saved key cannot be read. Add it again.
            </p>
          )}
          <form class="assistant-project-form" onSubmit={save}>
            <label>
              <span>
                {state === "saved" ? "Replace the key" : "OpenAI API key"}
              </span>
              <input
                type="password"
                value={key}
                autocomplete="off"
                spellcheck={false}
                placeholder="sk-…"
                onInput={(event) => setKey(event.currentTarget.value)}
              />
            </label>
            <footer class="assistant-settings-actions">
              {(state === "saved" || state === "unreadable") && (
                <button type="button" disabled={disabled} onClick={remove}>
                  Remove key
                </button>
              )}
              <button type="submit" disabled={disabled || !key.trim()}>
                {working ? "Saving…" : "Save key"}
              </button>
            </footer>
          </form>
        </>
      )}
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <label>
        <span>Model for new chats</span>
        <select
          value={choice}
          disabled={disabled}
          onChange={(event) => setChoice(event.currentTarget.value)}
        >
          {status.availableModels.map((model) => (
            <option key={modelKey(model)} value={modelKey(model)}>
              {modelLabel(model)}
            </option>
          ))}
        </select>
      </label>
      <p class="assistant-panel-empty">
        Now: {current ? modelLabel(current) : modelKey(status.defaultModel)}
        {status.defaultModelSource === "server"
          ? " (the server's default)"
          : " (chosen here)"}
        .
        {state !== "saved" &&
          status.defaultModel.providerId === "openai" &&
          status.defaultModelSource === "setup" &&
          " New chats on it fail until a key is saved."}
      </p>
      <footer class="assistant-settings-actions">
        {status.defaultModelSource === "setup" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setChoice("");
              void call(() =>
                requestJson<OpenAiStatus>("/api/providers/default-model", {
                  method: "PUT",
                  body: { expectedRevision: status.revision, model: null },
                }),
              );
            }}
          >
            Use the server's default
          </button>
        )}
        <button
          type="button"
          disabled={
            disabled ||
            !chosen ||
            (choice === modelKey(status.defaultModel) &&
              status.defaultModelSource === "setup")
          }
          onClick={useDefault}
        >
          Use for new chats
        </button>
      </footer>
    </div>
  );
}

function PreferencesStep({
  busy,
  onSkip,
  onSaved,
}: {
  busy: boolean;
  onSkip: () => void;
  onSaved: () => void;
}) {
  const [settings, setSettings] = useState<PersonaSettings | null>(null);
  const [name, setName] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [quietOn, setQuietOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    requestJson<{ settings: PersonaSettings }>("/api/settings/persona").then(
      (body) => {
        if (cancelled) return;
        setSettings(body.settings);
        setName(body.settings.name);
        setTimeZone(body.settings.timeZone);
        setQuietOn(body.settings.quietHours !== undefined);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const deviceZone = deviceTimeZone();
  const save = async (event: Event) => {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const form = { ...formFromSettings(settings), name, timeZone, quietOn };
      await requestJson("/api/settings/persona", {
        method: "PATCH",
        body: patchFromForm(form, settings.updatedAt),
      });
      onSaved();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      class="assistant-project-form assistant-settings-section"
      aria-label="Preferences"
      onSubmit={save}
    >
      <h3>Name, time zone and quiet hours</h3>
      {!settings && !error && <p class="assistant-panel-empty">Loading…</p>}
      {settings && (
        <>
          <label>
            <span>Assistant's name</span>
            <input
              value={name}
              maxLength={40}
              required
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>
              Your time zone (IANA name, used for schedules and quiet hours)
            </span>
            <input
              value={timeZone}
              required
              spellcheck={false}
              onInput={(event) => setTimeZone(event.currentTarget.value)}
            />
            {deviceZone && deviceZone !== timeZone && (
              <small>
                This device is on {deviceZone}.{" "}
                <button
                  type="button"
                  class="link-button"
                  onClick={() => setTimeZone(deviceZone)}
                >
                  Use it
                </button>
              </small>
            )}
          </label>
          <label class="assistant-job-enabled">
            <input
              type="checkbox"
              checked={quietOn}
              onChange={(event) => setQuietOn(event.currentTarget.checked)}
            />
            <span>
              Hold notifications overnight (22:00 to 07:00 unless changed in
              Settings; approvals still notify)
            </span>
          </label>
        </>
      )}
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <footer class="assistant-settings-actions">
        <button type="button" disabled={busy || saving} onClick={onSkip}>
          Skip for now
        </button>
        <button
          class="primary"
          type="submit"
          disabled={busy || saving || !settings}
        >
          {saving ? "Saving…" : "Save and continue"}
        </button>
      </footer>
    </form>
  );
}

function SummaryStep({
  state,
  busy,
  onPasswordSaved,
  onFinish,
}: {
  state: OnboardingState;
  busy: boolean;
  onPasswordSaved: () => void;
  onFinish: () => Promise<void>;
}) {
  const { model, backup } = state.facts;
  const modelReady =
    model.codexSignedIn ||
    model.otherProviders > 0 ||
    model.openAiKeySaved === true;
  const passwordSaved = state.record?.backupPasswordSavedAt !== undefined;
  return (
    <section class="assistant-settings-section" aria-label="Check">
      <h3>{setupStatusLabel(state.status)}</h3>
      <ul class="assistant-settings-list">
        <li class="assistant-settings-row">
          <strong>Models</strong>
          <span>
            {model.codexSignedIn
              ? "ChatGPT is signed in."
              : model.openAiKeySaved
                ? "An OpenAI API key is saved (billed by OpenAI; not checked until the first chat)."
                : model.otherProviders > 0
                  ? "Models set up by the operator are available."
                  : model.openAiKeyAvailable
                    ? "Not connected yet: sign in with ChatGPT or add an OpenAI API key."
                    : "Not connected yet: chats cannot answer until ChatGPT is signed in."}
          </span>
        </li>
        <li class="assistant-settings-row">
          <strong>Backups</strong>
          <span>
            {!backup.configured
              ? "Not configured on this server."
              : backup.reachable === false
                ? "The backup service is not answering. Check it before relying on this installation."
                : backup.failing
                  ? "The last backup failed. Check the backup service before updating."
                  : backup.lastSuccessAt !== undefined
                    ? `Last backup ${new Date(backup.lastSuccessAt).toLocaleString()}. It is on this machine's disk, so it does not protect against losing the machine.`
                    : "No backup yet."}
          </span>
        </li>
        {backup.configured && (
          <li class="assistant-settings-row">
            <strong>Backup password</strong>
            <span>
              {passwordSaved ? (
                "You said it is saved off this machine."
              ) : (
                <label class="assistant-job-enabled">
                  <input
                    type="checkbox"
                    disabled={busy}
                    onChange={(event) => {
                      if (event.currentTarget.checked) onPasswordSaved();
                    }}
                  />
                  <span>
                    I saved <code>secrets/backup-password</code> from the
                    installation folder somewhere off this machine. Backups
                    cannot be restored without it.
                  </span>
                </label>
              )}
            </span>
          </li>
        )}
      </ul>
      <footer class="assistant-settings-actions">
        <button
          class="primary"
          type="button"
          disabled={
            busy || !modelReady || (backup.configured && !passwordSaved)
          }
          onClick={() => void onFinish()}
        >
          Finish setup
        </button>
      </footer>
      {(!modelReady || (backup.configured && !passwordSaved)) && (
        <p class="assistant-panel-empty">
          Finishing needs a model connection
          {backup.configured ? " and the backup password saved" : ""}. You can
          close this and come back from Setup.
        </p>
      )}
    </section>
  );
}
