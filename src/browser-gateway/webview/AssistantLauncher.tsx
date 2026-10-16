import {
  DEFAULT_ASSISTANT_ORIGIN,
  normalizeAssistantOrigin,
} from "../../shared/assistantAddress";

import { useState } from "preact/hooks";

/** Per browser: each device may reach the Assistant at a different address. */
export const ASSISTANT_ORIGIN_STORAGE_KEY = "agentlink.assistantOrigin";

export function readAssistantOrigin(): string {
  try {
    return (
      normalizeAssistantOrigin(
        window.localStorage.getItem(ASSISTANT_ORIGIN_STORAGE_KEY),
      ) ?? DEFAULT_ASSISTANT_ORIGIN
    );
  } catch {
    return DEFAULT_ASSISTANT_ORIGIN;
  }
}

function saveAssistantOrigin(origin: string): void {
  try {
    if (origin === DEFAULT_ASSISTANT_ORIGIN) {
      window.localStorage.removeItem(ASSISTANT_ORIGIN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(ASSISTANT_ORIGIN_STORAGE_KEY, origin);
    }
  } catch {
    // Without storage the address lasts for this page only.
  }
}

/**
 * The browser gateway's link to the AgentLink Assistant. The Assistant
 * refuses to be framed and its sign-in cookie is same-site only, so it
 * always opens in its own tab, never inside the gateway page.
 */
export function AssistantLauncher() {
  const [origin, setOrigin] = useState(readAssistantOrigin);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(origin);
  const [invalid, setInvalid] = useState(false);

  const save = () => {
    const next = normalizeAssistantOrigin(draft);
    if (!next) {
      setInvalid(true);
      return;
    }
    saveAssistantOrigin(next);
    setOrigin(next);
    setDraft(next);
    setInvalid(false);
    setEditing(false);
  };

  return (
    <div class="assistant-launcher">
      <div class="assistant-launcher-row">
        <a
          class="assistant-launcher-link"
          href={`${origin}/`}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open the AgentLink Assistant at ${origin} in a new tab`}
        >
          <i class="codicon codicon-sparkle" aria-hidden="true" /> Assistant
          <i class="codicon codicon-link-external" aria-hidden="true" />
        </a>
        <button
          class="assistant-launcher-edit"
          type="button"
          aria-label="Change the Assistant's address"
          aria-expanded={editing}
          title="Change the Assistant's address"
          onClick={() => {
            setDraft(origin);
            setInvalid(false);
            setEditing(!editing);
          }}
        >
          <i class="codicon codicon-gear" aria-hidden="true" />
        </button>
      </div>
      {editing && (
        <form
          class="assistant-launcher-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label>
            Assistant address
            <input
              value={draft}
              placeholder={DEFAULT_ASSISTANT_ORIGIN}
              spellcheck={false}
              autocomplete="off"
              aria-invalid={invalid}
              onInput={(event) => {
                setDraft(event.currentTarget.value);
                setInvalid(false);
              }}
            />
          </label>
          {invalid && (
            <p class="assistant-launcher-error" role="alert">
              Enter the Assistant's https:// address.
            </p>
          )}
          <div class="assistant-launcher-actions">
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
