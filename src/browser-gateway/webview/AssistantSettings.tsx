import { Dialog, errorText, requestJson } from "./AssistantProjects";
import { useEffect, useState } from "preact/hooks";

/**
 * The Assistant's persona settings: its name and voice, what it calls the
 * owner, the owner's time zone, and quiet hours for notifications. They
 * change how it sounds and when pushes arrive, never what it may do.
 */

export interface QuietHours {
  start: string;
  end: string;
  allowApprovals: boolean;
}

export interface PersonaSettings {
  name: string;
  persona: string;
  ownerName?: string;
  timeZone: string;
  quietHours?: QuietHours;
  updatedAt: number;
}

interface PersonaResponse {
  settings: PersonaSettings;
  defaultPersona: string;
}

interface FormState {
  name: string;
  persona: string;
  ownerName: string;
  timeZone: string;
  quietOn: boolean;
  quietStart: string;
  quietEnd: string;
  allowApprovals: boolean;
}

export function formFromSettings(settings: PersonaSettings): FormState {
  return {
    name: settings.name,
    persona: settings.persona,
    ownerName: settings.ownerName ?? "",
    timeZone: settings.timeZone,
    quietOn: settings.quietHours !== undefined,
    quietStart: settings.quietHours?.start ?? "22:00",
    quietEnd: settings.quietHours?.end ?? "07:00",
    allowApprovals: settings.quietHours?.allowApprovals ?? true,
  };
}

/** The PATCH body for a form: every field, so the result is what is shown. */
export function patchFromForm(
  form: FormState,
  expectedUpdatedAt: number,
): Record<string, unknown> {
  return {
    expectedUpdatedAt,
    name: form.name.trim(),
    persona: form.persona.trim() || null,
    ownerName: form.ownerName.trim() || null,
    timeZone: form.timeZone.trim(),
    quietHours: form.quietOn
      ? {
          start: form.quietStart,
          end: form.quietEnd,
          allowApprovals: form.allowApprovals,
        }
      : null,
  };
}

/** Time zones the browser knows, with the current one first if missing. */
function timeZoneOptions(current: string): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf?.("timeZone");
  const zones = supported && supported.length > 0 ? supported : [current];
  return zones.includes(current) ? zones : [current, ...zones];
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<PersonaResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<PersonaResponse>("/api/settings/persona").then(
      (body) => {
        if (cancelled) return;
        setLoaded(body);
        setForm(formFromSettings(body.settings));
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!form || !loaded) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await requestJson<{ settings: PersonaSettings }>(
        "/api/settings/persona",
        {
          method: "PATCH",
          body: patchFromForm(form, loaded.settings.updatedAt),
        },
      );
      setLoaded({ ...loaded, settings: body.settings });
      setForm(formFromSettings(body.settings));
      setNotice("Saved. New messages use these settings.");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Settings" onClose={onClose} busy={busy} wide>
      {!form && !error && <p class="assistant-panel-empty">Loading…</p>}
      {form && loaded && (
        <form class="assistant-project-form" onSubmit={submit}>
          <div class="assistant-project-row">
            <label>
              <span>Assistant's name</span>
              <input
                value={form.name}
                maxLength={40}
                required
                onInput={(event) => update({ name: event.currentTarget.value })}
              />
            </label>
            <label>
              <span>What it calls you</span>
              <input
                value={form.ownerName}
                maxLength={60}
                placeholder="(not set)"
                onInput={(event) =>
                  update({ ownerName: event.currentTarget.value })
                }
              />
            </label>
          </div>
          <label>
            <span>Persona (how it sounds in your chats)</span>
            <textarea
              rows={5}
              maxLength={2000}
              value={form.persona}
              onInput={(event) =>
                update({ persona: event.currentTarget.value })
              }
            />
            <small>
              Not used in coding task chats, which write in the repository's own
              voice. It never changes what the Assistant may do.{" "}
              <button
                type="button"
                class="link-button"
                onClick={() => update({ persona: loaded.defaultPersona })}
              >
                Use the default
              </button>
            </small>
          </label>
          <label>
            <span>Your time zone</span>
            <select
              value={form.timeZone}
              onChange={(event) =>
                update({ timeZone: event.currentTarget.value })
              }
            >
              {timeZoneOptions(form.timeZone).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Quiet hours</legend>
            <label class="assistant-job-enabled">
              <input
                type="checkbox"
                checked={form.quietOn}
                onChange={(event) =>
                  update({ quietOn: event.currentTarget.checked })
                }
              />
              <span>
                Hold notifications during these hours (the Inbox still fills up;
                what is still unread is sent when they end)
              </span>
            </label>
            {form.quietOn && (
              <>
                <div class="assistant-project-row">
                  <label>
                    <span>From</span>
                    <input
                      type="time"
                      value={form.quietStart}
                      required
                      onInput={(event) =>
                        update({ quietStart: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Until</span>
                    <input
                      type="time"
                      value={form.quietEnd}
                      required
                      onInput={(event) =>
                        update({ quietEnd: event.currentTarget.value })
                      }
                    />
                  </label>
                </div>
                <label class="assistant-job-enabled">
                  <input
                    type="checkbox"
                    checked={form.allowApprovals}
                    onChange={(event) =>
                      update({ allowApprovals: event.currentTarget.checked })
                    }
                  />
                  <span>Still notify me when something needs my approval</span>
                </label>
              </>
            )}
          </fieldset>
          {notice && (
            <p class="assistant-panel-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <div class="assistant-project-error" role="alert">
              <p>{error}</p>
            </div>
          )}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              Close
            </button>
            <button class="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </footer>
        </form>
      )}
      {!form && error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
    </Dialog>
  );
}
