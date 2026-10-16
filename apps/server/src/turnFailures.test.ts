import {
  MAX_FAILURE_DETAIL_LENGTH,
  createTurnFailureLog,
  describeTurnFailure,
} from "./turnFailures.js";
import { describe, expect, it } from "vitest";

describe("turn failure details", () => {
  it("describes an error with its status, code and causes", () => {
    const error = Object.assign(
      new Error("The model is overloaded", {
        cause: Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        }),
      }),
      { status: 503 },
    );
    expect(describeTurnFailure(error)).toBe(
      "The model is overloaded (HTTP 503): socket hang up (ECONNRESET)",
    );
    expect(describeTurnFailure("plain text reason")).toBe("plain text reason");
  });

  it("says nothing when the error says nothing", () => {
    expect(describeTurnFailure(undefined)).toBeUndefined();
    expect(describeTurnFailure(new Error(""))).toBeUndefined();
    expect(describeTurnFailure(new Error("Turn execution failed"))).toBe(
      undefined,
    );
  });

  it("redacts credentials and private request detail", () => {
    const detail = describeTurnFailure(
      new Error(
        [
          "Request to https://api.example.com/v1/responses?key=abc123&x=1 failed",
          "Authorization: Bearer abc.def.ghi",
          'api_key="sk-proj-0123456789abcdef"',
          "token=hunter2",
          `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl`,
          `blob ${"A".repeat(60)}`,
        ].join(" "),
      ),
    );
    expect(detail).toContain("https://api.example.com/v1/responses?…");
    for (const secret of [
      "abc123",
      "abc.def.ghi",
      "sk-proj-0123456789abcdef",
      "hunter2",
      "eyJhbGciOiJIUzI1NiJ9",
      "A".repeat(60),
    ]) {
      expect(detail).not.toContain(secret);
    }
    expect(detail).toContain("[redacted]");
  });

  it("bounds long messages", () => {
    const detail = describeTurnFailure(new Error("word ".repeat(400)));
    expect(detail?.length).toBe(MAX_FAILURE_DETAIL_LENGTH);
    expect(detail?.endsWith("…")).toBe(true);
  });

  it("keeps the latest failure per chat until it is read", () => {
    const log = createTurnFailureLog();
    log.record("home", "s1", "first");
    log.record("home", "s1", "second");
    log.record("work", "s1", "other project");
    expect(log.take("home", "s1")).toBe("second");
    expect(log.take("home", "s1")).toBeUndefined();
    expect(log.take("work", "s1")).toBe("other project");
    for (let index = 0; index < 250; index += 1) {
      log.record("home", `chat-${index}`, `failure ${index}`);
    }
    expect(log.take("home", "chat-0")).toBeUndefined();
    expect(log.take("home", "chat-249")).toBe("failure 249");
  });
});
