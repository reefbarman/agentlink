import {
  alwaysAskReason,
  argumentsMatch,
  describeArgumentRules,
  nameWords,
  normaliseAlwaysAskPatterns,
  normaliseArgumentRules,
} from "./mcpToolGuard.js";
import { describe, expect, it } from "vitest";

describe("nameWords", () => {
  it("splits snake, kebab, dotted and camel case names", () => {
    expect(nameWords("gmail_sendMessage")).toEqual([
      "gmail",
      "send",
      "message",
    ]);
    expect(nameWords("calendar.events.insert")).toEqual([
      "calendar",
      "events",
      "insert",
    ]);
    expect(nameWords("HTTPGetEvents")).toEqual(["http", "get", "events"]);
  });
});

describe("alwaysAskReason", () => {
  const reason = (name: string, destructiveHint?: boolean) =>
    alwaysAskReason("google", {
      name,
      ...(destructiveHint !== undefined ? { destructiveHint } : {}),
    });

  it("puts sending, deleting and changing email and calendar items on the list", () => {
    for (const name of [
      "send_email",
      "gmail_reply",
      "forwardMessage",
      "archive_thread",
      "trash_message",
      "delete_event",
      "modify_labels",
      "create_event",
      "update_event",
      "calendar.events.insert",
      "create_draft",
      "draft_email",
      "invite_attendees",
      "rsvp",
      "mark_as_read",
      "add_label",
    ]) {
      expect(reason(name), name).toBeDefined();
    }
  });

  it("leaves reads alone, including reads of drafts and labels", () => {
    for (const name of [
      "search_messages",
      "get_message",
      "list_events",
      "get_draft",
      "list_drafts",
      "list_labels",
      "read_thread",
      "freebusy_query",
      "create_page",
    ]) {
      expect(reason(name), name).toBeUndefined();
    }
  });

  it("follows the server's destructive hint", () => {
    expect(reason("list_events", true)).toContain("destructive");
    expect(reason("list_events", false)).toBeUndefined();
  });

  it("lets only reading tools run on a server on the owner's network", () => {
    const network = (name: string) =>
      alwaysAskReason("home", { name }, [], { network: true });
    for (const name of [
      "HassTurnOn",
      "HassTurnOff",
      "HassLightSet",
      "HassSetPosition",
      "HassListAddItem",
      "HassListCompleteItem",
      "HassMediaPause",
      "HassBroadcast",
      "HassCancelAllTimers",
      "call_service",
      "lock_door",
    ]) {
      expect(network(name), name).toContain("on your network");
    }
    for (const name of ["GetLiveContext", "GetDateTime", "get_history"]) {
      expect(network(name), name).toBeUndefined();
    }
    // The same names elsewhere follow the ordinary list.
    expect(alwaysAskReason("other", { name: "HassTurnOn" })).toBeUndefined();
  });

  it("adds the owner's patterns, by tool or server/tool", () => {
    expect(
      alwaysAskReason("linear", { name: "create_issue" }, ["create_*"]),
    ).toContain("create_*");
    expect(
      alwaysAskReason("linear", { name: "save_issue" }, ["notion/*"]),
    ).toBeUndefined();
    expect(
      alwaysAskReason("notion", { name: "save_issue" }, ["Notion/*"]),
    ).toContain("Notion/*");
  });
});

describe("normaliseAlwaysAskPatterns", () => {
  it("trims, drops duplicates and refuses patterns that match everything", () => {
    expect(normaliseAlwaysAskPatterns([" create_* ", "create_*", ""])).toEqual([
      "create_*",
    ]);
    expect(() => normaliseAlwaysAskPatterns(["*"])).toThrow();
    expect(() => normaliseAlwaysAskPatterns(["a b"])).toThrow();
    expect(() => normaliseAlwaysAskPatterns("x")).toThrow();
  });
});

describe("argument rules", () => {
  const schema = {
    type: "object",
    properties: { calendarId: { type: "string" }, entity_id: {} },
  };

  it("checks names against the schema and refuses a bare *", () => {
    expect(
      normaliseArgumentRules(schema, { calendarId: [" primary ", "primary"] }),
    ).toEqual({ calendarId: ["primary"] });
    expect(() => normaliseArgumentRules(schema, { other: ["x"] })).toThrow(
      /no argument/u,
    );
    expect(() => normaliseArgumentRules(schema, { calendarId: [] })).toThrow();
    expect(() =>
      normaliseArgumentRules(schema, { calendarId: ["*"] }),
    ).toThrow();
    expect(() => normaliseArgumentRules(schema, {})).toThrow();
  });

  it("matches exact values and prefixes, and asks for anything else", () => {
    const rules = { calendarId: ["primary"], entity_id: ["sensor.*"] };
    expect(
      argumentsMatch(rules, {
        calendarId: "primary",
        entity_id: "sensor.garage",
      }),
    ).toEqual({ ok: true });
    expect(
      argumentsMatch(rules, {
        calendarId: "work@example.com",
        entity_id: "sensor.garage",
      }),
    ).toEqual({ ok: false, argument: "calendarId" });
    // A missing argument is not a match.
    expect(argumentsMatch(rules, { calendarId: "primary" })).toEqual({
      ok: false,
      argument: "entity_id",
    });
    // Every item of a list must match; objects never do.
    expect(
      argumentsMatch(
        { entity_id: ["sensor.*"] },
        { entity_id: ["sensor.a", "switch.b"] },
      ).ok,
    ).toBe(false);
    expect(
      argumentsMatch({ entity_id: ["sensor.*"] }, { entity_id: { a: 1 } }).ok,
    ).toBe(false);
  });

  it("describes rules in words", () => {
    expect(
      describeArgumentRules({
        calendarId: ["primary"],
        entity_id: ["sensor.*", "light.kitchen"],
      }),
    ).toBe(
      "calendarId is primary; entity_id is light.kitchen or starts with sensor.",
    );
  });
});
