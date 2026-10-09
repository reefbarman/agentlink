import { ApiError, api, errorMessage, setCsrfToken } from "./api.js";
import { liveItems, transcriptItems, type ChatItem } from "./chatModel.js";
import {
  append,
  displayValue,
  formatTime,
  h,
  replaceChildren,
  type Child,
} from "./dom.js";
import {
  SessionEventBuffer,
  parseSessionEvent,
  reconnectDelayMs,
} from "./eventBuffer.js";
import type {
  AuthSession,
  BackgroundAgent,
  Device,
  ModelReference,
  ModelsResponse,
  PendingInteraction,
  Project,
  SessionSnapshot,
  SessionSummary,
} from "./types.js";

const root = document.getElementById("app")!;
let auth: AuthSession | undefined;
let teardown: (() => void) | undefined;

type Route =
  | { readonly view: "projects" }
  | { readonly view: "devices" }
  | { readonly view: "project"; readonly projectId: string }
  | {
      readonly view: "session";
      readonly projectId: string;
      readonly sessionId: string;
    };

type Toast = (message?: string) => void;

// ---------------------------------------------------------------- routing

function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/u, "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
  if (parts[0] === "devices") return { view: "devices" };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "s" && parts[3]) {
      return { view: "session", projectId: parts[1], sessionId: parts[3] };
    }
    return { view: "project", projectId: parts[1] };
  }
  return { view: "projects" };
}

const enc = encodeURIComponent;
const projectHash = (projectId: string) => `#/p/${enc(projectId)}`;
const sessionHash = (projectId: string, sessionId: string) =>
  `#/p/${enc(projectId)}/s/${enc(sessionId)}`;
const projectPath = (projectId: string) => `/api/projects/${enc(projectId)}`;
const sessionPath = (projectId: string, sessionId: string) =>
  `${projectPath(projectId)}/sessions/${enc(sessionId)}`;

async function render(): Promise<void> {
  teardown?.();
  teardown = undefined;
  if (!auth) {
    await renderSignIn();
    return;
  }
  const route = parseRoute(location.hash);
  switch (route.view) {
    case "projects":
      await renderProjects();
      return;
    case "devices":
      await renderDevices();
      return;
    case "project":
      await renderProject(route.projectId);
      return;
    case "session":
      teardown = renderSession(route.projectId, route.sessionId);
      return;
  }
}

function signedIn(session: AuthSession): void {
  auth = session;
  setCsrfToken(session.csrfToken);
}

function signedOut(): void {
  auth = undefined;
  setCsrfToken(undefined);
  void render();
}

/** Show an error, or return to sign-in when the session has ended. */
function fail(error: unknown, toast: Toast): void {
  if (
    error instanceof ApiError &&
    error.status === 401 &&
    error.code === "authentication_required"
  ) {
    signedOut();
    return;
  }
  toast(errorMessage(error));
}

// ---------------------------------------------------------------- layout

function layout(
  title: string,
  options: {
    readonly back?: string;
    readonly actions?: readonly Child[];
    readonly contentClass?: string;
  } = {},
): { readonly content: HTMLElement; readonly toast: Toast } {
  const toastBox = h("div", { class: "toast", role: "alert", hidden: true });
  const content = h("main", { class: options.contentClass ?? "content" });
  replaceChildren(
    root,
    h(
      "header",
      { class: "topbar" },
      options.back
        ? h(
            "a",
            { class: "back", href: options.back, "aria-label": "Back" },
            "‹",
          )
        : null,
      h("h1", {}, title),
      h("nav", {}, ...(options.actions ?? [])),
    ),
    toastBox,
    content,
  );
  return {
    content,
    toast: (message) => {
      toastBox.hidden = !message;
      toastBox.textContent = message ?? "";
    },
  };
}

const devicesLink = () => h("a", { href: "#/devices" }, "Devices");

function field(label: string, input: HTMLElement): HTMLElement {
  return h("label", {}, label, input);
}

// ---------------------------------------------------------------- reauth

/** Run a sensitive action, asking for the passphrase once if needed. */
async function withReauth<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (
      !(error instanceof ApiError && error.code === "reauthentication_required")
    ) {
      throw error;
    }
  }
  if (!(await confirmPassphrase())) return undefined;
  return await action();
}

function confirmPassphrase(): Promise<boolean> {
  return new Promise((resolve) => {
    const input = h("input", {
      type: "password",
      autocomplete: "current-password",
      required: true,
    });
    const error = h("p", { class: "error" });
    const submit = h("button", { class: "primary", type: "submit" }, "Confirm");
    const dialog = h("dialog", {});
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(ok);
    };
    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (event: SubmitEvent) => {
          event.preventDefault();
          submit.disabled = true;
          error.textContent = "";
          try {
            await api("POST", "/api/auth/reauthenticate", {
              passphrase: input.value,
            });
            finish(true);
          } catch (caught) {
            if (
              caught instanceof ApiError &&
              caught.code === "authentication_required"
            ) {
              finish(false);
              signedOut();
              return;
            }
            error.textContent = errorMessage(caught);
            submit.disabled = false;
            input.select();
          }
        },
      },
      h("h2", {}, "Confirm it's you"),
      h(
        "p",
        { class: "hint" },
        "Approvals and device changes need your passphrase again. It stays confirmed for 5 minutes.",
      ),
      field("Passphrase", input),
      error,
      h(
        "div",
        { class: "inline" },
        submit,
        h("button", { type: "button", onClick: () => finish(false) }, "Cancel"),
      ),
    );
    dialog.addEventListener("cancel", () => finish(false));
    append(dialog, form);
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// ---------------------------------------------------------------- sign in

function defaultDeviceLabel(): string {
  const agent = navigator.userAgent;
  if (/iPhone/u.test(agent)) return "iPhone";
  if (/iPad/u.test(agent)) return "iPad";
  if (/Android/u.test(agent)) return "Android";
  if (/Macintosh/u.test(agent)) return "Mac";
  if (/Windows/u.test(agent)) return "Windows";
  if (/Linux/u.test(agent)) return "Linux";
  return "Browser";
}

async function renderSignIn(): Promise<void> {
  const { content, toast } = layout("AgentLink Assistant");
  let ownerConfigured = true;
  try {
    ownerConfigured = (
      await api<{ ownerConfigured: boolean }>("GET", "/api/auth/state")
    ).ownerConfigured;
  } catch (error) {
    toast(errorMessage(error));
  }
  const tabs: readonly (readonly [string, string, () => HTMLElement])[] =
    ownerConfigured
      ? [
          ["pair", "Pair this device", pairForm],
          ["recover", "Recovery code", recoverForm],
        ]
      : [["setup", "Set up", setupForm]];
  const body = h("div", {});
  const buttons = tabs.map(([, label, build]) => {
    const button = h(
      "button",
      {
        type: "button",
        onClick: () => {
          for (const other of buttons)
            other.setAttribute("aria-pressed", "false");
          button.setAttribute("aria-pressed", "true");
          replaceChildren(body, build());
        },
      },
      label,
    );
    return button;
  });
  buttons[0]!.setAttribute("aria-pressed", "true");
  replaceChildren(body, tabs[0]![2]());
  append(
    content,
    h(
      "section",
      { class: "card" },
      tabs.length > 1 ? h("div", { class: "tabs" }, ...buttons) : null,
      body,
    ),
  );
}

/** A sign-in form whose submit returns the newly issued session. */
function authForm(
  intro: Child,
  fields: readonly HTMLElement[],
  submitLabel: string,
  submitAction: () => Promise<AuthSession> | undefined,
): HTMLElement {
  const error = h("p", { class: "error" });
  const submit = h("button", { class: "primary", type: "submit" }, submitLabel);
  return h(
    "form",
    {
      class: "form",
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          const pending = submitAction();
          if (!pending) return;
          signedIn(await pending);
          await render();
        } catch (caught) {
          error.textContent = errorMessage(caught);
        } finally {
          submit.disabled = false;
        }
      },
    },
    intro,
    ...fields,
    error,
    submit,
  );
}

function labelInput(): HTMLInputElement {
  return h("input", {
    value: defaultDeviceLabel(),
    maxlength: 80,
    required: true,
    autocomplete: "off",
  });
}

function setupForm(): HTMLElement {
  const credential = h("input", {
    required: true,
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
  });
  const passphrase = h("input", {
    type: "password",
    required: true,
    minlength: 12,
    autocomplete: "new-password",
  });
  const confirm = h("input", {
    type: "password",
    required: true,
    autocomplete: "new-password",
  });
  const label = labelInput();
  const mismatch = h("p", { class: "error" });
  return authForm(
    h(
      "p",
      { class: "hint" },
      "Create the owner with the one-time setup credential the server printed when it started (for a container: docker compose logs assistant). Choose a passphrase of at least 12 characters; you'll need it for approvals.",
    ),
    [
      field("Setup credential", credential),
      field("Passphrase", passphrase),
      field("Confirm passphrase", confirm),
      field("This device's name", label),
      mismatch,
    ],
    "Create owner",
    () => {
      mismatch.textContent = "";
      if (passphrase.value !== confirm.value) {
        mismatch.textContent = "The passphrases don't match.";
        return undefined;
      }
      return api<AuthSession>("POST", "/api/auth/bootstrap", {
        setupToken: credential.value.trim(),
        passphrase: passphrase.value,
        deviceLabel: label.value,
      });
    },
  );
}

function pairForm(): HTMLElement {
  const code = h("input", {
    required: true,
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    placeholder: "XXXXX-XXXXX",
  });
  const label = labelInput();
  return authForm(
    h(
      "p",
      { class: "hint" },
      "On a device that is already signed in, open Devices and create a pairing code, then enter it here within 5 minutes.",
    ),
    [field("Pairing code", code), field("This device's name", label)],
    "Pair",
    () =>
      api<AuthSession>("POST", "/api/auth/pairings/redeem", {
        code: code.value.trim().toUpperCase(),
        deviceLabel: label.value,
      }),
  );
}

function recoverForm(): HTMLElement {
  const code = h("input", {
    required: true,
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
  });
  const passphrase = h("input", {
    type: "password",
    required: true,
    autocomplete: "current-password",
  });
  const label = labelInput();
  return authForm(
    h(
      "p",
      { class: "hint" },
      "Lost every signed-in device? Run agentlink-server recover on the server (for a container: docker compose exec assistant agentlink-server recover) and enter the code with your passphrase.",
    ),
    [
      field("Recovery code", code),
      field("Passphrase", passphrase),
      field("This device's name", label),
    ],
    "Sign in",
    () =>
      api<AuthSession>("POST", "/api/auth/recover", {
        recoveryToken: code.value.trim(),
        passphrase: passphrase.value,
        deviceLabel: label.value,
      }),
  );
}

// ---------------------------------------------------------------- models

const modelKey = (model: ModelReference) =>
  JSON.stringify([model.providerId, model.modelId]);

function modelLabel(
  models: ModelsResponse | undefined,
  model: ModelReference,
): string {
  const choice = models?.models.find(
    (candidate) => modelKey(candidate) === modelKey(model),
  );
  const name = choice?.displayName ?? model.modelId;
  const provider = choice?.providerDisplayName ?? model.providerId;
  return `${name} (${provider})`;
}

function fillModelSelect(
  select: HTMLSelectElement,
  models: ModelsResponse,
  selected: ModelReference,
): void {
  replaceChildren(
    select,
    ...models.models.map((model) =>
      h("option", { value: modelKey(model) }, modelLabel(models, model)),
    ),
  );
  select.value = modelKey(selected);
}

function selectedModel(select: HTMLSelectElement): ModelReference | undefined {
  try {
    const [providerId, modelId] = JSON.parse(select.value) as [string, string];
    return { providerId, modelId };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- projects

async function renderProjects(): Promise<void> {
  const { content, toast } = layout("AgentLink Assistant", {
    actions: [devicesLink()],
  });
  try {
    const { projects } = await api<{ projects: Project[] }>(
      "GET",
      "/api/projects",
    );
    append(
      content,
      projects.length === 0
        ? h("p", { class: "empty" }, "No projects are mounted on this server.")
        : h(
            "section",
            { class: "card" },
            h("h2", {}, "Projects"),
            h(
              "ul",
              { class: "list" },
              ...projects.map((project) =>
                h(
                  "li",
                  {},
                  h(
                    "a",
                    { class: "row", href: projectHash(project.projectId) },
                    h("span", {}, project.label ?? project.projectId),
                    h("span", { class: "meta" }, "›"),
                  ),
                ),
              ),
            ),
          ),
    );
  } catch (error) {
    fail(error, toast);
  }
}

function stateClass(state: string): string {
  if (/interaction|suspend|approval/u.test(state)) return "pill attention";
  if (/running/u.test(state)) return "pill busy";
  return "pill";
}

async function renderProject(projectId: string): Promise<void> {
  const { content, toast } = layout(projectId, {
    back: "#/",
    actions: [devicesLink()],
  });
  try {
    const [project, models, { sessions }] = await Promise.all([
      api<Project>("GET", projectPath(projectId)),
      api<ModelsResponse>("GET", `${projectPath(projectId)}/models`),
      api<{ sessions: SessionSummary[] }>(
        "GET",
        `${projectPath(projectId)}/sessions`,
      ),
    ]);
    const title = root.querySelector(".topbar h1");
    if (title) title.textContent = project.label ?? project.projectId;
    const select = h("select", { "aria-label": "Model for the new chat" });
    fillModelSelect(select, models, models.defaultModel);
    const create = h(
      "button",
      {
        class: "primary",
        type: "button",
        onClick: async () => {
          create.disabled = true;
          try {
            const model = selectedModel(select);
            const created = await api<{ sessionId: string }>(
              "POST",
              `${projectPath(projectId)}/sessions`,
              model ? { model } : undefined,
            );
            location.hash = sessionHash(projectId, created.sessionId);
          } catch (error) {
            fail(error, toast);
            create.disabled = false;
          }
        },
      },
      "New chat",
    );
    const visible = sessions
      .filter((session) => !session.background)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    append(
      content,
      h(
        "section",
        { class: "card" },
        h("h2", {}, "New chat"),
        h("div", { class: "inline" }, select, create),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", {}, "Chats"),
        visible.length === 0
          ? h("p", { class: "hint" }, "No chats yet.")
          : h(
              "ul",
              { class: "list" },
              ...visible.map((session) =>
                h(
                  "li",
                  {},
                  h(
                    "a",
                    {
                      class: "row",
                      href: sessionHash(projectId, session.sessionId),
                    },
                    h(
                      "span",
                      {},
                      formatTime(session.updatedAt),
                      h(
                        "span",
                        { class: "meta" },
                        ` · ${modelLabel(models, session.model)}`,
                      ),
                    ),
                    h(
                      "span",
                      { class: stateClass(session.state) },
                      session.state,
                    ),
                  ),
                ),
              ),
            ),
      ),
    );
  } catch (error) {
    fail(error, toast);
  }
}

// ---------------------------------------------------------------- chat

function renderItem(item: ChatItem): HTMLElement {
  switch (item.kind) {
    case "user":
    case "assistant":
      return h(
        "div",
        { class: `msg ${item.kind}` },
        item.text,
        item.truncated
          ? h("span", { class: "truncated" }, "(shortened for display)")
          : null,
      );
    case "tool": {
      const icon =
        item.state === "running"
          ? "⋯"
          : item.state === "failed"
            ? "✗"
            : item.state === "done"
              ? "✓"
              : "•";
      return h(
        "div",
        { class: `tool ${item.state}` },
        `${icon} ${item.toolName}`,
      );
    }
    case "notice":
      return h(
        "div",
        { class: item.tone === "error" ? "notice error" : "notice" },
        item.text,
      );
  }
}

function renderSession(projectId: string, sessionId: string): () => void {
  const base = sessionPath(projectId, sessionId);
  const { content, toast } = layout(projectId, {
    back: projectHash(projectId),
    actions: [devicesLink()],
    contentClass: "chat",
  });

  const status = h("span", { class: "pill" }, "Loading…");
  const modelSelect = h("select", { "aria-label": "Model", disabled: true });
  const stopButton = h(
    "button",
    {
      class: "danger",
      type: "button",
      hidden: true,
      onClick: () => void stop(),
    },
    "Stop",
  );
  const messages = h("div", { class: "messages", "aria-live": "polite" });
  const approvalBox = h("div", {});
  const agentsBox = h("div", {});
  const input = h("textarea", {
    rows: 2,
    placeholder: "Message the assistant",
    "aria-label": "Message",
  });
  const sendButton = h("button", { class: "primary", type: "submit" }, "Send");
  const composer = h(
    "form",
    { class: "composer", onSubmit: (event: SubmitEvent) => void send(event) },
    input,
    sendButton,
  );
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  append(
    content,
    h("div", { class: "session-bar" }, modelSelect, status, stopButton),
    messages,
    h("div", { class: "panel" }, approvalBox, agentsBox),
    composer,
  );

  let snapshot: SessionSnapshot | undefined;
  let buffer: SessionEventBuffer | undefined;
  let models: ModelsResponse | undefined;
  let pendingUser: string | undefined;
  /** How the last turn ended badly; kept until the next message. */
  let lastFailure: ChatItem[] = [];
  let source: EventSource | undefined;
  let streamReady = false;
  let attempt = 0;
  let closed = false;
  let sending = false;
  let answering = false;
  let approvalKey = "";
  let frame = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let agentsTimer: ReturnType<typeof setTimeout> | undefined;

  const renderSoon = () => {
    if (closed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderAll();
    });
  };

  function renderAll(): void {
    if (closed || !snapshot) return;
    const pending = snapshot.session.pendingInteraction;
    const busy = snapshot.task !== null;
    status.className = !streamReady
      ? "pill attention"
      : pending
        ? "pill attention"
        : busy
          ? "pill busy"
          : "pill";
    status.textContent = !streamReady
      ? "Reconnecting…"
      : pending
        ? "Needs approval"
        : busy
          ? "Working…"
          : "Ready";
    stopButton.hidden = !busy;
    sendButton.disabled = sending || busy || pending !== undefined;
    modelSelect.disabled = !models || busy || pending !== undefined;

    const items: ChatItem[] = [];
    if (snapshot.transcript.omitted > 0) {
      items.push({
        kind: "notice",
        tone: "info",
        text: `${snapshot.transcript.omitted} earlier messages not shown`,
      });
    }
    items.push(...transcriptItems(snapshot.transcript.entries));
    items.push(...lastFailure);
    if (pendingUser !== undefined) {
      items.push({ kind: "user", text: pendingUser });
    }
    if (buffer) items.push(...liveItems(buffer.events, buffer.base));
    if (items.length === 0) {
      items.push({
        kind: "notice",
        tone: "info",
        text: "Start the chat below.",
      });
    }
    const atBottom =
      messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    replaceChildren(messages, ...items.map(renderItem));
    if (atBottom) messages.scrollTop = messages.scrollHeight;

    const nextApprovalKey = pending
      ? `${pending.request.interactionId}:${pending.interactionRevision}:${answering}`
      : "";
    if (nextApprovalKey !== approvalKey) {
      approvalKey = nextApprovalKey;
      replaceChildren(approvalBox, pending ? approvalCard(pending) : null);
    }
  }

  function approvalCard(pending: PendingInteraction): HTMLElement {
    const detail =
      pending.request.displayInput ?? pending.request.displayContent;
    return h(
      "section",
      { class: "card approval" },
      h("h2", {}, "Approval needed"),
      h("p", {}, pending.request.summary),
      h(
        "p",
        { class: "hint" },
        `${pending.request.toolName} · ${pending.request.effect}`,
      ),
      detail !== undefined ? h("pre", {}, displayValue(detail)) : null,
      h(
        "div",
        { class: "inline" },
        h(
          "button",
          {
            class: "primary",
            type: "button",
            disabled: answering,
            onClick: () => void answer(pending, "allow"),
          },
          "Allow",
        ),
        h(
          "button",
          {
            class: "danger",
            type: "button",
            disabled: answering,
            onClick: () => void answer(pending, "deny"),
          },
          "Deny",
        ),
      ),
    );
  }

  async function answer(
    pending: PendingInteraction,
    decision: "allow" | "deny",
  ): Promise<void> {
    answering = true;
    renderAll();
    try {
      await withReauth(() =>
        api("POST", `${base}/interaction`, {
          interactionId: pending.request.interactionId,
          interactionRevision: pending.interactionRevision,
          decision,
        }),
      );
    } catch (error) {
      fail(error, toast);
    } finally {
      answering = false;
      scheduleReload(0);
    }
  }

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = input.value;
    if (!text.trim() || sending) return;
    sending = true;
    sendButton.disabled = true;
    toast();
    try {
      await api("POST", `${base}/turns`, { text });
      pendingUser = text;
      lastFailure = [];
      input.value = "";
      scheduleReload(0);
    } catch (error) {
      fail(error, toast);
      if (
        error instanceof ApiError &&
        (error.code === "session_busy" || error.code === "interaction_pending")
      ) {
        scheduleReload(0);
      }
    } finally {
      sending = false;
      renderSoon();
    }
  }

  async function stop(): Promise<void> {
    stopButton.disabled = true;
    try {
      await api("POST", `${base}/cancel`);
    } catch (error) {
      fail(error, toast);
    } finally {
      stopButton.disabled = false;
    }
  }

  modelSelect.addEventListener("change", async () => {
    const model = selectedModel(modelSelect);
    if (!model || !snapshot || !models) return;
    modelSelect.disabled = true;
    try {
      await api("POST", `${base}/model`, { model });
    } catch (error) {
      fail(error, toast);
    }
    scheduleReload(0);
  });

  // ---- snapshot and stream

  let loadGeneration = 0;
  async function loadSnapshot(): Promise<void> {
    // Loads can overlap; only the newest one may update the view.
    const generation = ++loadGeneration;
    let next: SessionSnapshot;
    try {
      next = await api<SessionSnapshot>("GET", base);
    } catch (error) {
      if (generation === loadGeneration) fail(error, toast);
      return;
    }
    if (closed || generation !== loadGeneration) return;
    snapshot = next;
    // A running task's events since it started are not in the transcript
    // yet, so replay them from the log.
    const position =
      next.task?.startedSequence !== undefined
        ? next.task.startedSequence - 1
        : next.events.sequence;
    if (next.task === null && buffer && buffer.epoch === next.events.epoch) {
      // The snapshot only holds what the turn saved: keep its error, and the
      // message that started it if the transcript does not have it.
      const errors = liveItems(buffer.events, buffer.base).filter(
        (item) => item.kind === "notice" && item.tone === "error",
      );
      if (errors.length > 0) {
        const lastUser = [...next.transcript.entries]
          .reverse()
          .find((entry) => entry.kind === "user");
        lastFailure = [
          ...(pendingUser !== undefined && lastUser?.text !== pendingUser
            ? [{ kind: "user" as const, text: pendingUser }]
            : []),
          ...errors,
        ];
      }
    }
    if (!buffer || buffer.epoch !== next.events.epoch) {
      buffer = new SessionEventBuffer(next.events.epoch, position, position);
      connect();
    } else {
      buffer.rebase(position);
    }
    if (next.task === null) pendingUser = undefined;
    // The running turn's prompt is not in the transcript until it commits.
    else if (next.task.text !== undefined) pendingUser = next.task.text;
    if (models) fillModelSelect(modelSelect, models, next.model);
    renderAll();
  }

  function scheduleReload(delay = 150): void {
    if (closed) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      void loadSnapshot();
    }, delay);
  }

  function connect(): void {
    if (closed || !buffer) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    source?.close();
    const current = new EventSource(buffer.streamUrl(base));
    source = current;
    current.addEventListener("ready", () => {
      attempt = 0;
      streamReady = true;
      renderSoon();
    });
    current.addEventListener("session", (message) => {
      const event = parseSessionEvent(String(message.data));
      if (!event || !buffer?.add(event)) return;
      const inner = event.event;
      if (inner.kind === "task" && inner.state !== "started") scheduleReload();
      if (inner.kind === "agent") scheduleAgents();
      renderSoon();
    });
    current.addEventListener("reset", (message) => {
      try {
        const data = JSON.parse(String(message.data)) as {
          epoch: string;
          sequence: number;
        };
        buffer?.reset(data.epoch, data.sequence);
      } catch {
        // The snapshot reload below recovers either way.
      }
      scheduleReload(0);
      scheduleAgents();
    });
    current.onerror = () => {
      if (current !== source) return;
      current.close();
      source = undefined;
      streamReady = false;
      renderSoon();
      void reconnectLater();
    };
  }

  /** Tell an expired sign-in from a dropped connection, then retry. */
  async function reconnectLater(): Promise<void> {
    try {
      await api("GET", "/api/auth/session");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        signedOut();
        return;
      }
    }
    if (closed || source || reconnectTimer) return;
    reconnectTimer = setTimeout(connect, reconnectDelayMs(attempt));
    attempt += 1;
  }

  const onWake = () => {
    if (document.visibilityState !== "visible" || closed || source) return;
    attempt = 0;
    connect();
    scheduleReload(0);
  };
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("online", onWake);

  // ---- background agents

  function scheduleAgents(delay = 300): void {
    if (closed) return;
    if (agentsTimer) clearTimeout(agentsTimer);
    agentsTimer = setTimeout(() => {
      agentsTimer = undefined;
      void loadAgents();
    }, delay);
  }

  async function loadAgents(): Promise<void> {
    let agents: readonly BackgroundAgent[];
    try {
      agents = (
        await api<{ agents: BackgroundAgent[] }>("GET", `${base}/agents`)
      ).agents;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "agents_not_enabled")) {
        fail(error, toast);
      }
      return;
    }
    if (closed) return;
    const recent = [...agents]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 10);
    replaceChildren(agentsBox, ...recent.map(agentCard));
  }

  function agentCard(agent: BackgroundAgent): HTMLElement {
    const target = `${base}/agents/${enc(agent.childSessionId)}`;
    const active =
      agent.lifecycle === "queued" ||
      agent.lifecycle === "running" ||
      agent.lifecycle === "awaiting_approval";
    const output = agent.resultText ?? agent.partialOutput;
    const act = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        fail(error, toast);
      }
      scheduleAgents(0);
    };
    const summaryLine = h(
      "summary",
      {},
      `${agent.task} `,
      h(
        "span",
        {
          class:
            agent.lifecycle === "awaiting_approval"
              ? "pill attention"
              : active
                ? "pill busy"
                : "pill",
        },
        agent.lifecycle,
      ),
    );
    return h(
      "details",
      { class: "card agent", open: active },
      summaryLine,
      h(
        "p",
        { class: "hint" },
        [
          agent.model ? modelLabel(models, agent.model) : undefined,
          agent.currentTool ? `using ${agent.currentTool}` : undefined,
          agent.terminalReason,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      agent.approval
        ? h(
            "div",
            { class: "approval" },
            h("p", {}, agent.approval.summary),
            agent.approval.displayContent !== undefined
              ? h("pre", {}, displayValue(agent.approval.displayContent))
              : null,
            h(
              "div",
              { class: "inline" },
              h(
                "button",
                {
                  class: "primary",
                  type: "button",
                  onClick: () =>
                    void act(() =>
                      withReauth(() =>
                        api("POST", `${target}/approval`, {
                          interactionId: agent.approval!.interactionId,
                          decision: "allow",
                        }),
                      ),
                    ),
                },
                "Allow",
              ),
              h(
                "button",
                {
                  class: "danger",
                  type: "button",
                  onClick: () =>
                    void act(() =>
                      withReauth(() =>
                        api("POST", `${target}/approval`, {
                          interactionId: agent.approval!.interactionId,
                          decision: "deny",
                        }),
                      ),
                    ),
                },
                "Deny",
              ),
            ),
          )
        : null,
      output ? h("pre", {}, displayValue(output, 20_000)) : null,
      active
        ? h(
            "button",
            {
              class: "danger",
              type: "button",
              onClick: () => void act(() => api("POST", `${target}/stop`)),
            },
            "Stop agent",
          )
        : null,
    );
  }

  // ---- start

  void (async () => {
    try {
      models = await api<ModelsResponse>(
        "GET",
        `${projectPath(projectId)}/models`,
      );
    } catch (error) {
      fail(error, toast);
    }
    await loadSnapshot();
    await loadAgents();
  })();

  return () => {
    closed = true;
    source?.close();
    source = undefined;
    if (frame) cancelAnimationFrame(frame);
    for (const timer of [reconnectTimer, reloadTimer, agentsTimer]) {
      if (timer) clearTimeout(timer);
    }
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("online", onWake);
  };
}

// ---------------------------------------------------------------- devices

async function renderDevices(): Promise<void> {
  const { content, toast } = layout("Devices", { back: "#/" });
  const pairingResult = h("div", {});
  const pairButton = h(
    "button",
    {
      class: "primary",
      type: "button",
      onClick: async () => {
        pairButton.disabled = true;
        try {
          const pairing = await withReauth(() =>
            api<{ code: string; expiresAt: number }>(
              "POST",
              "/api/auth/pairings",
            ),
          );
          if (pairing) {
            replaceChildren(
              pairingResult,
              h("p", { class: "code" }, pairing.code),
              h(
                "p",
                { class: "hint" },
                `Open this server on the new device, choose "Pair this device", and enter the code before ${formatTime(pairing.expiresAt)}.`,
              ),
            );
          }
        } catch (error) {
          fail(error, toast);
        } finally {
          pairButton.disabled = false;
        }
      },
    },
    "Create pairing code",
  );
  const list = h("ul", { class: "list" });
  const signOut = h(
    "button",
    {
      type: "button",
      onClick: async () => {
        try {
          await api("POST", "/api/auth/logout");
        } catch {
          // Signed out locally either way.
        }
        signedOut();
      },
    },
    "Sign out of this device",
  );
  append(
    content,
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Add a device"),
      h("div", { class: "form" }, pairButton, pairingResult),
    ),
    h("section", { class: "card" }, h("h2", {}, "Signed-in devices"), list),
    h("section", { class: "card" }, signOut),
  );

  const load = async () => {
    try {
      const { devices } = await api<{ devices: Device[] }>(
        "GET",
        "/api/auth/devices",
      );
      replaceChildren(
        list,
        ...devices
          .filter((device) => device.revokedAt === undefined)
          .map((device) =>
            h(
              "li",
              {},
              h(
                "div",
                { class: "row" },
                h(
                  "span",
                  {},
                  device.label,
                  h(
                    "span",
                    { class: "meta" },
                    ` · added ${formatTime(device.createdAt)}${device.current ? " · this device" : ""}`,
                  ),
                ),
                h(
                  "button",
                  {
                    class: "danger",
                    type: "button",
                    onClick: async () => {
                      if (!window.confirm(`Sign out "${device.label}"?`))
                        return;
                      try {
                        await withReauth(() =>
                          api(
                            "DELETE",
                            `/api/auth/devices/${enc(device.deviceId)}`,
                          ),
                        );
                        if (device.current) {
                          signedOut();
                          return;
                        }
                      } catch (error) {
                        fail(error, toast);
                      }
                      await load();
                    },
                  },
                  "Revoke",
                ),
              ),
            ),
          ),
      );
    } catch (error) {
      fail(error, toast);
    }
  };
  await load();
}

// ---------------------------------------------------------------- boot

async function start(): Promise<void> {
  window.addEventListener("hashchange", () => void render());
  try {
    signedIn(await api<AuthSession>("GET", "/api/auth/session"));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      layout("AgentLink Assistant").toast(errorMessage(error));
      return;
    }
  }
  await render();
}

void start();
