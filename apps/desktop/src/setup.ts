import {
  acceleratorFromKeyboardEvent,
  formatQuickAskAccelerator,
} from "./quickAskShortcut.js";

import type { ReleaseUpdateState } from "../../../src/updates/releaseUpdateTypes.js";

interface QuickAskShortcutStatus {
  shortcut: string | null;
  registered: boolean;
  defaultShortcut: string;
}

interface OpenAtLoginStatus {
  available: boolean;
  enabled: boolean;
  requiresApproval: boolean;
}

interface DesktopOAuthAccount {
  id: string;
  label: string;
  email?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsageLimitAt?: number;
}

interface DesktopAuthStatus {
  hasOpenAiApiKey: boolean;
  openAiCompatibleCredentialCount?: number;
  hasUsableOpenAiCompatibleModel?: boolean;
  oauthAccounts: DesktopOAuthAccount[];
}

declare global {
  interface Window {
    agentlinkDesktop: {
      credentialStatus(): Promise<DesktopAuthStatus>;
      storeOpenAiApiKey(apiKey: string): Promise<{ ok: true }>;
      signInOAuth(): Promise<{
        account: DesktopOAuthAccount;
        status: DesktopAuthStatus;
      }>;
      setActiveOAuthAccount(accountId: string): Promise<DesktopAuthStatus>;
      removeOAuthAccount(accountId: string): Promise<DesktopAuthStatus>;
      continueToChat(): Promise<{ ok: true }>;
      quickAskShortcut(): Promise<QuickAskShortcutStatus>;
      setQuickAskShortcut(
        accelerator: string | null,
      ): Promise<QuickAskShortcutStatus>;
      openAtLogin(): Promise<OpenAtLoginStatus>;
      setOpenAtLogin(enabled: boolean): Promise<OpenAtLoginStatus>;
      getReleaseUpdateState(): Promise<ReleaseUpdateState>;
      onReleaseUpdateState(
        listener: (state: ReleaseUpdateState) => void,
      ): () => void;
      checkForReleaseUpdate(): Promise<ReleaseUpdateState>;
      dismissReleaseUpdate(): Promise<ReleaseUpdateState>;
      setAutomaticUpdateChecks(value: boolean): Promise<ReleaseUpdateState>;
      openReleaseUpdateLink(url: string): Promise<{ ok: true }>;
    };
  }
}

const form = document.querySelector<HTMLFormElement>("#setup-form")!;
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key")!;

const oauthButton =
  document.querySelector<HTMLButtonElement>("#oauth-sign-in")!;
const continueButton = document.querySelector<HTMLButtonElement>("#continue")!;
const accountList = document.querySelector<HTMLElement>("#accounts")!;
const status = document.querySelector<HTMLElement>("#status")!;
const shortcutValue = document.querySelector<HTMLElement>("#shortcut-value")!;
const shortcutRecord =
  document.querySelector<HTMLButtonElement>("#shortcut-record")!;
const shortcutReset =
  document.querySelector<HTMLButtonElement>("#shortcut-reset")!;
const shortcutDisable =
  document.querySelector<HTMLButtonElement>("#shortcut-disable")!;
const shortcutNote = document.querySelector<HTMLElement>("#shortcut-note")!;
const openAtLoginInput =
  document.querySelector<HTMLInputElement>("#open-at-login")!;
const loginNote = document.querySelector<HTMLElement>("#login-note")!;
const updateVersion = document.querySelector<HTMLElement>("#update-version")!;
const updateDetails = document.querySelector<HTMLElement>("#update-details")!;
const updateCandidate =
  document.querySelector<HTMLElement>("#update-candidate")!;
const updateNote = document.querySelector<HTMLElement>("#update-note")!;
const automaticUpdates =
  document.querySelector<HTMLInputElement>("#automatic-updates")!;
const releaseLink = document.querySelector<HTMLButtonElement>(
  "#update-release-link",
)!;
const instructionsLink = document.querySelector<HTMLButtonElement>(
  "#update-instructions-link",
)!;
const dismissUpdate =
  document.querySelector<HTMLButtonElement>("#dismiss-update")!;
const checkUpdates =
  document.querySelector<HTMLButtonElement>("#check-updates")!;
let releaseUpdateState: ReleaseUpdateState | null = null;
let shortcutStatus: QuickAskShortcutStatus | null = null;
let recordingShortcut = false;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitApiKey();
});
oauthButton.addEventListener("click", () => void signInOAuth());
continueButton.addEventListener("click", () => void continueToChat());
shortcutRecord.addEventListener("click", () => {
  if (recordingShortcut) stopRecordingShortcut();
  else startRecordingShortcut();
});
shortcutReset.addEventListener("click", () => {
  if (shortcutStatus) void saveShortcut(shortcutStatus.defaultShortcut);
});
shortcutDisable.addEventListener("click", () => void saveShortcut(null));
automaticUpdates.addEventListener("change", () => {
  automaticUpdates.disabled = true;
  void window.agentlinkDesktop
    .setAutomaticUpdateChecks(automaticUpdates.checked)
    .then(renderReleaseUpdateState)
    .catch(() => {
      automaticUpdates.checked = !automaticUpdates.checked;
      automaticUpdates.disabled = false;
      updateVersion.textContent = "Could not save update preference.";
    });
});
checkUpdates.addEventListener("click", () => {
  checkUpdates.disabled = true;
  updateVersion.textContent = "Checking for updates…";
  void window.agentlinkDesktop
    .checkForReleaseUpdate()
    .then(renderReleaseUpdateState)
    .catch(() => {
      updateVersion.textContent = "Update check unavailable.";
      checkUpdates.disabled = false;
    });
});
dismissUpdate.addEventListener("click", () => {
  void window.agentlinkDesktop
    .dismissReleaseUpdate()
    .then(renderReleaseUpdateState);
});
releaseLink.addEventListener("click", () => openUpdateLink("releaseUrl"));
instructionsLink.addEventListener("click", () =>
  openUpdateLink("instructionsUrl"),
);
void window.agentlinkDesktop
  .getReleaseUpdateState()
  .then(renderReleaseUpdateState);
window.agentlinkDesktop.onReleaseUpdateState(renderReleaseUpdateState);

openAtLoginInput.addEventListener("change", () => {
  const enabled = openAtLoginInput.checked;
  openAtLoginInput.disabled = true;
  void window.agentlinkDesktop
    .setOpenAtLogin(enabled)
    .then(renderOpenAtLogin)
    .catch(() => {
      openAtLoginInput.checked = !enabled;
      openAtLoginInput.disabled = false;
      showLoginNote("AgentLink could not update the login item.", true);
    });
});

function renderReleaseUpdateState(state: ReleaseUpdateState): void {
  releaseUpdateState = state;
  automaticUpdates.checked = state.automaticChecks;
  automaticUpdates.disabled = false;
  checkUpdates.disabled = state.status === "checking";
  dismissUpdate.hidden =
    !state.candidate || state.dismissedVersion === state.candidate.version;
  const candidate = state.candidate;
  updateDetails.hidden = !candidate;
  if (candidate) {
    updateCandidate.textContent = `AgentLink Desktop ${state.identity.version} → ${candidate.version} (${candidate.channel})`;
    updateNote.textContent = state.stale
      ? "Release information may be out of date."
      : "A compatible Desktop release is available.";
  }
  const labels: Record<ReleaseUpdateState["status"], string> = {
    idle: "Update status has not been checked yet.",
    checking: "Checking release metadata…",
    available: "An update is available.",
    current: "AgentLink Desktop is up to date.",
    unavailable: "Release information is currently unavailable.",
    rate_limited: "GitHub has temporarily limited update checks.",
    unsupported: "No compatible Desktop release is available for this system.",
    metadata_unavailable:
      "A release was found, but compatibility information is unavailable.",
  };
  updateVersion.textContent = `Installed ${state.identity.version}. ${
    candidate && state.status === "available"
      ? labels.available
      : labels[state.status]
  }`;
}

function openUpdateLink(key: "releaseUrl" | "instructionsUrl"): void {
  const url = releaseUpdateState?.candidate?.[key];
  if (url) void window.agentlinkDesktop.openReleaseUpdateLink(url);
}

function renderOpenAtLogin(next: OpenAtLoginStatus): void {
  openAtLoginInput.checked = next.enabled;
  openAtLoginInput.disabled = !next.available;
  if (!next.available) {
    showLoginNote("Only available in the installed app.", false);
  } else if (next.requiresApproval) {
    showLoginNote(
      "Allow AgentLink in System Settings → General → Login Items to finish turning this on.",
      true,
    );
  } else {
    showLoginNote("", false);
  }
}

function showLoginNote(message: string, isError: boolean): void {
  loginNote.textContent = message;
  loginNote.classList.toggle("error", isError);
}
window.addEventListener(
  "keydown",
  (event) => {
    if (!recordingShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecordingShortcut();
      return;
    }
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
    const accelerator = acceleratorFromKeyboardEvent(event);
    if (!accelerator) {
      showShortcutNote(
        "Use a key with ⌘, ⌃ or ⌥ (Shift alone isn't enough). Press Esc to cancel.",
        true,
      );
      return;
    }
    stopRecordingShortcut();
    void saveShortcut(accelerator);
  },
  true,
);
window.addEventListener("blur", () => {
  if (recordingShortcut) stopRecordingShortcut();
});

function startRecordingShortcut(): void {
  recordingShortcut = true;
  shortcutValue.textContent = "Press keys…";
  shortcutValue.classList.add("recording");
  shortcutRecord.textContent = "Cancel";
  showShortcutNote("Press the new shortcut, or Esc to cancel.", false);
}

function stopRecordingShortcut(): void {
  recordingShortcut = false;
  shortcutValue.classList.remove("recording");
  shortcutRecord.textContent = "Change";
  if (shortcutStatus) renderShortcut(shortcutStatus);
}

async function saveShortcut(accelerator: string | null): Promise<void> {
  try {
    renderShortcut(
      await window.agentlinkDesktop.setQuickAskShortcut(accelerator),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showShortcutNote(
      message.includes("shortcut_unavailable")
        ? "That shortcut is already used by macOS or another app. Try a different one."
        : "AgentLink could not save that shortcut.",
      true,
    );
  }
}

function renderShortcut(next: QuickAskShortcutStatus): void {
  shortcutStatus = next;
  shortcutValue.textContent = next.shortcut
    ? formatQuickAskAccelerator(next.shortcut)
    : "Off";
  shortcutReset.hidden = next.shortcut === next.defaultShortcut;
  shortcutDisable.hidden = next.shortcut === null;
  if (next.shortcut && !next.registered) {
    showShortcutNote(
      "This shortcut is in use by macOS or another app, so it won't work. Choose a different one.",
      true,
    );
  } else {
    showShortcutNote(
      next.shortcut
        ? "Send a message from Quick Ask to open it in a new chat here."
        : "Quick Ask is off.",
      false,
    );
  }
}

function showShortcutNote(message: string, isError: boolean): void {
  shortcutNote.textContent = message;
  shortcutNote.classList.toggle("error", isError);
}

async function submitApiKey(): Promise<void> {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    showStatus("Enter an OpenAI API key.", true);
    return;
  }

  setBusy(true);
  showStatus("Saving securely and starting AgentLink…", false);
  try {
    await window.agentlinkDesktop.storeOpenAiApiKey(apiKey);
    apiKeyInput.value = "";
  } catch (error) {
    showStatus(readError(error), true);
    setBusy(false);
    apiKeyInput.focus();
  }
}

async function signInOAuth(): Promise<void> {
  setBusy(true);
  showStatus("Opening ChatGPT sign-in in your browser…", false);
  try {
    const result = await window.agentlinkDesktop.signInOAuth();
    renderStatus(result.status);
    showStatus(`Signed in as ${result.account.label}.`, false);
  } catch (error) {
    showStatus(readError(error), true);
  } finally {
    setBusy(false);
  }
}

async function setActive(accountId: string): Promise<void> {
  setBusy(true);
  try {
    renderStatus(
      await window.agentlinkDesktop.setActiveOAuthAccount(accountId),
    );
    showStatus("Active account updated for all AgentLink surfaces.", false);
  } catch (error) {
    showStatus(readError(error), true);
  } finally {
    setBusy(false);
  }
}

async function removeAccount(accountId: string): Promise<void> {
  setBusy(true);
  try {
    renderStatus(await window.agentlinkDesktop.removeOAuthAccount(accountId));
    showStatus("Account signed out on this machine.", false);
  } catch (error) {
    showStatus(readError(error), true);
  } finally {
    setBusy(false);
  }
}

async function continueToChat(): Promise<void> {
  setBusy(true);
  try {
    await window.agentlinkDesktop.continueToChat();
  } catch (error) {
    showStatus(readError(error), true);
    setBusy(false);
  }
}

function renderStatus(next: DesktopAuthStatus): void {
  accountList.replaceChildren();
  for (const account of next.oauthAccounts) {
    const item = document.createElement("div");
    item.className = "account";
    const identity = document.createElement("div");
    identity.className = "account-identity";
    const label = document.createElement("strong");
    label.textContent = account.label;
    const detail = document.createElement("span");
    detail.textContent = account.email ?? "ChatGPT/Codex account";
    identity.append(label, detail);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    if (!account.isActive) {
      actions.append(
        actionButton("Use", () => void setActive(account.id), "secondary"),
      );
    } else {
      const badge = document.createElement("span");
      badge.className = "active-badge";
      badge.textContent = "Active";
      actions.append(badge);
    }
    actions.append(
      actionButton("Remove", () => void removeAccount(account.id), "quiet"),
    );
    item.append(identity, actions);
    accountList.append(item);
  }

  const compatibleCredentialCount = next.openAiCompatibleCredentialCount ?? 0;
  const hasAuth =
    next.oauthAccounts.length > 0 ||
    next.hasOpenAiApiKey ||
    next.hasUsableOpenAiCompatibleModel === true;
  continueButton.hidden = !hasAuth;
  if (next.hasOpenAiApiKey) {
    const key = document.createElement("p");
    key.className = "stored-key";
    key.textContent = "OpenAI API key stored in Keychain";
    accountList.append(key);
  }
  if (compatibleCredentialCount > 0) {
    const compatible = document.createElement("p");
    compatible.className = "stored-key";
    compatible.textContent = `${compatibleCredentialCount} OpenAI-compatible API key${compatibleCredentialCount === 1 ? "" : "s"} stored in Keychain`;
    accountList.append(compatible);
  }
}

function actionButton(
  label: string,
  handler: () => void,
  style: "secondary" | "quiet",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `account-action ${style}`;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function setBusy(busy: boolean): void {
  for (const element of document.querySelectorAll<HTMLButtonElement>(
    "button",
  )) {
    element.disabled = busy;
  }
  apiKeyInput.disabled = busy;
}

function showStatus(message: string, isError: boolean): void {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function readError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("api_key_required") ||
    message.includes("invalid_api_key")
  ) {
    return "Enter a valid OpenAI API key.";
  }
  if (message.includes("port_in_use")) {
    return "Another application is already handling ChatGPT sign-in. Close it and try again.";
  }
  if (message.includes("timeout"))
    return "ChatGPT sign-in timed out. Try again.";
  if (message.includes("model_credentials_missing")) {
    return "Sign in or add an API key before opening chat.";
  }
  return "AgentLink could not update the shared account. Check Keychain access and try again.";
}

void window.agentlinkDesktop
  .credentialStatus()
  .then(renderStatus)
  .catch((error) => showStatus(readError(error), true));
void window.agentlinkDesktop
  .quickAskShortcut()
  .then(renderShortcut)
  .catch(() => showShortcutNote("Quick Ask settings are unavailable.", true));
void window.agentlinkDesktop
  .openAtLogin()
  .then(renderOpenAtLogin)
  .catch(() => showLoginNote("Login item settings are unavailable.", true));

export {};
