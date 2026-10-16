// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SettingsPanel,
  formFromSettings,
  patchFromForm,
  type PersonaSettings,
} from "./AssistantSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SETTINGS: PersonaSettings = {
  name: "AgentLink Assistant",
  persona: "Be friendly.",
  timeZone: "Australia/Brisbane",
  quietHours: { start: "22:00", end: "07:00", allowApprovals: true },
  updatedAt: 5,
};

function stubFetch(patch: { status: number; body: unknown }) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ settings: SETTINGS, defaultPersona: "Default." }),
          { status: 200 },
        );
      }
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(patch.body), {
        status: patch.status,
      });
    }),
  );
  return sent;
}

describe("settings form", () => {
  it("round-trips settings, sending every field so the result is what is shown", () => {
    const form = formFromSettings(SETTINGS);
    expect(form).toMatchObject({ ownerName: "", quietOn: true });
    expect(patchFromForm(form, 5)).toEqual({
      expectedUpdatedAt: 5,
      name: "AgentLink Assistant",
      persona: "Be friendly.",
      ownerName: null,
      timeZone: "Australia/Brisbane",
      quietHours: { start: "22:00", end: "07:00", allowApprovals: true },
    });
    expect(
      patchFromForm({ ...form, quietOn: false, persona: "  " }, 5),
    ).toMatchObject({ persona: null, quietHours: null });
  });
});

describe("SettingsPanel", () => {
  it("saves the edited settings", async () => {
    const sent = stubFetch({
      status: 200,
      body: { settings: { ...SETTINGS, name: "Matey", updatedAt: 6 } },
    });
    render(<SettingsPanel onClose={() => undefined} />);
    const name = await screen.findByDisplayValue("AgentLink Assistant");
    fireEvent.input(name, { target: { value: "Matey" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved. New messages use these settings.");
    expect(sent).toEqual([
      expect.objectContaining({ expectedUpdatedAt: 5, name: "Matey" }),
    ]);
  });

  it("offers this device's time zone when it differs", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Australia/Perth",
    } as Intl.ResolvedDateTimeFormatOptions);
    const sent = stubFetch({ status: 200, body: { settings: SETTINGS } });
    render(<SettingsPanel onClose={() => undefined} />);
    await screen.findByText(/This device is on Australia\/Perth/u);
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent).toEqual([
        expect.objectContaining({ timeZone: "Australia/Perth" }),
      ]),
    );
  });

  it("says plainly when the settings changed elsewhere", async () => {
    stubFetch({ status: 409, body: { error: "settings_changed" } });
    render(<SettingsPanel onClose={() => undefined} />);
    await screen.findByDisplayValue("AgentLink Assistant");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "These settings changed somewhere else.",
      ),
    );
  });
});
