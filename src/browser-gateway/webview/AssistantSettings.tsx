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

export interface StorageReport {
  areas: Array<{
    id: string;
    label: string;
    bytes: number;
    files: number;
    partial?: boolean;
  }>;
  retention: Array<{ label: string; text: string }>;
  measuredAt: number;
}

/** Bytes as people read them: 0 B, 12 KB, 3.4 MB, 1.2 GB. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown =
    unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/** How much each area uses, and how long each kind of record is kept. */
export function StorageSection() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    requestJson<StorageReport>("/api/settings/storage").then(
      (body) => {
        if (!cancelled) setReport(body);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <section class="assistant-storage" aria-label="Storage">
      <h3>Storage</h3>
      {!report && !error && <p class="assistant-panel-empty">Measuring…</p>}
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {report && (
        <>
          <ul>
            {report.areas.map((area) => (
              <li key={area.id}>
                <strong>{area.label}:</strong> {area.partial ? "at least " : ""}
                {formatBytes(area.bytes)}, {area.files}{" "}
                {area.files === 1 ? "file" : "files"}
              </li>
            ))}
          </ul>
          <h4>How long things are kept</h4>
          <ul>
            {report.retention.map((entry) => (
              <li key={entry.label}>
                <strong>{entry.label}:</strong> {entry.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** This device's IANA time zone, if the browser says. */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
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

  const deviceZone = deviceTimeZone();
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
            {deviceZone && deviceZone !== form.timeZone && (
              <small>
                This device is on {deviceZone}.{" "}
                <button
                  type="button"
                  class="link-button"
                  onClick={() => update({ timeZone: deviceZone })}
                >
                  Use it
                </button>
              </small>
            )}
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
      <StorageSection />
    </Dialog>
  );
}
