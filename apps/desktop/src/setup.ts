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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitApiKey();
});
oauthButton.addEventListener("click", () => void signInOAuth());
continueButton.addEventListener("click", () => void continueToChat());

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

  const hasAuth = next.oauthAccounts.length > 0 || next.hasOpenAiApiKey;
  continueButton.hidden = !hasAuth;
  if (next.hasOpenAiApiKey) {
    const key = document.createElement("p");
    key.className = "stored-key";
    key.textContent = "OpenAI API key stored in Keychain";
    accountList.append(key);
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

export {};
