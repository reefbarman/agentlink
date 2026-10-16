import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ASSISTANT_NAME,
  DEFAULT_PERSONA_TEXT,
  applyPersonaPatch,
  defaultPersona,
  describePersonaChanges,
  isQuietTime,
  openPersonaStore,
  parsePersonaPatch,
  personaInstructions,
  untilQuietEnds,
  type PersonaSettings,
} from "./persona.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Brisbane has no daylight saving: UTC+10 all year. */
const BRISBANE = "Australia/Brisbane";
/** Friday 16 October 2026 at the given Brisbane time. */
const brisbane = (hours: number, minutes = 0) =>
  Date.UTC(2026, 9, 16, hours - 10, minutes);

const QUIET = { start: "22:00", end: "07:00", allowApprovals: true };

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persona-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "settings", "persona.json");
}

describe("parsePersonaPatch", () => {
  it("accepts and trims the known fields", () => {
    expect(
      parsePersonaPatch({
        name: "  Matey ",
        persona: " Be brief. ",
        ownerName: "Tristan",
        timeZone: BRISBANE,
        quietHours: { start: "21:30", end: "06:00" },
      }),
    ).toEqual({
      name: "Matey",
      persona: "Be brief.",
      ownerName: "Tristan",
      timeZone: BRISBANE,
      quietHours: { start: "21:30", end: "06:00", allowApprovals: true },
    });
  });

  it("uses null to reset the persona, clear the owner's name and turn quiet hours off", () => {
    expect(
      parsePersonaPatch({ persona: null, ownerName: "", quietHours: null }),
    ).toEqual({ persona: null, ownerName: null, quietHours: null });
  });

  it.each([
    [{ colour: "teal" }, "persona_field_unknown"],
    [{ name: "" }, "persona_name_invalid"],
    [{ name: "a\nb" }, "persona_name_invalid"],
    [{ name: "x".repeat(41) }, "persona_name_invalid"],
    [{ persona: "" }, "persona_text_invalid"],
    [{ persona: "x".repeat(2_001) }, "persona_text_invalid"],
    [{ ownerName: "x".repeat(61) }, "persona_owner_name_invalid"],
    [{ timeZone: "Mars/Olympus" }, "persona_time_zone_invalid"],
    [
      { quietHours: { start: "22:00", end: "22:00" } },
      "persona_quiet_hours_invalid",
    ],
    [
      { quietHours: { start: "25:00", end: "07:00" } },
      "persona_quiet_hours_invalid",
    ],
    [
      { quietHours: { start: "22:00", end: "07:00", allowApprovals: "yes" } },
      "persona_quiet_hours_invalid",
    ],
  ])("rejects %j with %s", (input, code) => {
    expect(() => parsePersonaPatch(input)).toThrow(code);
  });
});

describe("applyPersonaPatch and describePersonaChanges", () => {
  const current: PersonaSettings = {
    ...defaultPersona(BRISBANE),
    ownerName: "Tristan",
    updatedAt: 5,
  };

  it("applies changes, resets and clears", () => {
    const next = applyPersonaPatch(
      { ...current, persona: "Custom" },
      { persona: null, ownerName: null, quietHours: null, name: "Matey" },
      9,
    );
    expect(next).toEqual({
      name: "Matey",
      persona: DEFAULT_PERSONA_TEXT,
      timeZone: BRISBANE,
      updatedAt: 9,
    });
  });

  it("lists every change with old and new values, and nothing for a no-op", () => {
    expect(
      describePersonaChanges(current, {
        name: "Matey",
        ownerName: null,
        timeZone: "Australia/Sydney",
        quietHours: null,
      }),
    ).toEqual([
      `Name: ${DEFAULT_ASSISTANT_NAME} → Matey`,
      "Your name: Tristan → (not set)",
      `Time zone: ${BRISBANE} → Australia/Sydney`,
      "Quiet hours: 22:00 to 07:00, approval requests still notify → off",
    ]);
    expect(
      describePersonaChanges(current, { name: DEFAULT_ASSISTANT_NAME }),
    ).toEqual([]);
  });
});

describe("personaInstructions", () => {
  const settings: PersonaSettings = {
    ...defaultPersona(BRISBANE),
    ownerName: "Tristan",
    persona: "Talk like a pirate.",
  };

  it("gives owner chats the name, voice, local date and the policy boundary", () => {
    const text = personaInstructions(settings, "owner", brisbane(9));
    expect(text).toContain(
      `Your name is ${DEFAULT_ASSISTANT_NAME}, and you work for Tristan.`,
    );
    expect(text).toContain("Talk like a pirate.");
    expect(text).toContain(
      "Tristan's time zone is Australia/Brisbane; today is Friday 16 October 2026.",
    );
    expect(text).toContain("changes nothing about what you may do");
    expect(text).toContain("propose_persona_change");
  });

  it("gives task chats the name and time zone without the voice", () => {
    const text = personaInstructions(settings, "task", brisbane(9));
    expect(text).toContain(`Your name is ${DEFAULT_ASSISTANT_NAME}.`);
    expect(text).toContain("Australia/Brisbane");
    expect(text).not.toContain("pirate");
    expect(text).not.toContain("propose_persona_change");
  });

  it("uses the owner's local date, not UTC's", () => {
    // 23:30 UTC on Thursday is already Friday in Brisbane.
    const text = personaInstructions(
      settings,
      "task",
      Date.UTC(2026, 9, 15, 23, 30),
    );
    expect(text).toContain("Friday 16 October 2026");
  });
});

describe("quiet hours", () => {
  it("spans midnight, start inclusive and end exclusive", () => {
    expect(isQuietTime(QUIET, BRISBANE, brisbane(21, 59))).toBe(false);
    expect(isQuietTime(QUIET, BRISBANE, brisbane(22))).toBe(true);
    expect(isQuietTime(QUIET, BRISBANE, brisbane(3))).toBe(true);
    expect(isQuietTime(QUIET, BRISBANE, brisbane(6, 59))).toBe(true);
    expect(isQuietTime(QUIET, BRISBANE, brisbane(7))).toBe(false);
    expect(isQuietTime(undefined, BRISBANE, brisbane(3))).toBe(false);
  });

  it("works within one day too", () => {
    const lunch = { start: "12:00", end: "13:00", allowApprovals: false };
    expect(isQuietTime(lunch, BRISBANE, brisbane(12, 30))).toBe(true);
    expect(isQuietTime(lunch, BRISBANE, brisbane(13, 30))).toBe(false);
  });

  it("reads the clock in the persona's time zone", () => {
    // 03:00 in Brisbane is 18:00 the day before in London (BST).
    expect(isQuietTime(QUIET, "Europe/London", brisbane(3))).toBe(false);
  });

  it("says how long until the quiet hours end", () => {
    expect(untilQuietEnds(QUIET, BRISBANE, brisbane(22))).toBe(9 * 3_600_000);
    expect(untilQuietEnds(QUIET, BRISBANE, brisbane(6, 30))).toBe(1_800_000);
  });
});

describe("openPersonaStore", () => {
  it("starts from the defaults and the server's time zone without writing", async () => {
    const file = await tempFile();
    const store = await openPersonaStore({ file, defaultTimeZone: BRISBANE });
    expect(store.get()).toEqual(defaultPersona(BRISBANE));
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("saves changes and reads them back", async () => {
    const file = await tempFile();
    const onChanged = vi.fn();
    const store = await openPersonaStore({
      file,
      defaultTimeZone: BRISBANE,
      onChanged,
    });
    const saved = await store.update(
      { name: "Matey", ownerName: "Tristan", quietHours: null },
      42,
    );
    expect(onChanged).toHaveBeenCalledWith(saved);
    const reopened = await openPersonaStore({
      file,
      defaultTimeZone: "UTC",
    });
    expect(reopened.get()).toEqual({
      name: "Matey",
      persona: DEFAULT_PERSONA_TEXT,
      ownerName: "Tristan",
      timeZone: BRISBANE,
      updatedAt: 42,
    });
  });

  it("refuses a file it cannot read rather than dropping the owner's settings", async () => {
    const file = await tempFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 2 }));
    await expect(
      openPersonaStore({ file, defaultTimeZone: BRISBANE }),
    ).rejects.toThrow("not a persona file");
    await fs.writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { timeZone: "Nowhere" } }),
    );
    await expect(
      openPersonaStore({ file, defaultTimeZone: BRISBANE }),
    ).rejects.toThrow("persona_time_zone_invalid");
  });
});
