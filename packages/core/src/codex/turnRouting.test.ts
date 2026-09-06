import {
  CODEX_TURN_STATE_HEADER,
  CodexTurnState,
  captureCodexTurnState,
  isCodexRoutingRejection,
} from "./turnRouting.js";
import { describe, expect, it } from "vitest";

const identity = ["session-a", "account-a", "gpt-5.5"] as const;

describe("CodexTurnState", () => {
  it("retains the first valid header for the same binding", () => {
    const turn = new CodexTurnState();
    const binding = turn.bind(...identity);
    captureCodexTurnState(binding, "first opaque token");
    captureCodexTurnState(binding, "replacement");

    expect(turn.bind(...identity)).toBe(binding);
    expect(binding).toEqual({ disabled: false, value: "first opaque token" });
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["newline", "invalid\nheader"],
    ["control character", "invalid\u0000header"],
    ["non-ASCII", "invalid\u00e9header"],
    ["oversized", "x".repeat(8193)],
  ])(
    "ignores a %s header without preventing later capture",
    (_label, value) => {
      const binding = new CodexTurnState().bind(...identity);
      captureCodexTurnState(binding, value);
      expect(binding).toEqual({ disabled: false });

      captureCodexTurnState(binding, "valid");
      expect(binding.value).toBe("valid");
    },
  );

  it("accepts a header at the size limit", () => {
    const binding = new CodexTurnState().bind(...identity);
    const value = "x".repeat(8192);
    captureCodexTurnState(binding, value);
    expect(binding.value).toBe(value);
  });

  it("does not capture headers after routing is disabled", () => {
    const binding = new CodexTurnState().bind(...identity);
    binding.disabled = true;
    captureCodexTurnState(binding, "ignored");
    expect(binding).toEqual({ disabled: true });
  });

  it.each([
    ["session", "session-b", "account-a", "gpt-5.5"],
    ["account", "session-a", "account-b", "gpt-5.5"],
    ["model", "session-a", "account-a", "gpt-6-astra"],
  ])(
    "resets routing on a %s change and isolates late old responses",
    (_label, session, account, model) => {
      const turn = new CodexTurnState();
      const oldBinding = turn.bind(...identity);
      const current = turn.bind(session, account, model);
      expect(current).not.toBe(oldBinding);
      expect(current).toEqual({ disabled: false });

      captureCodexTurnState(oldBinding, "late-old-response");
      oldBinding.disabled = true;
      expect(turn.bind(session, account, model)).toBe(current);
      expect(current).toEqual({ disabled: false });
      captureCodexTurnState(current, "current-response");
      expect(current.value).toBe("current-response");

      const rebound = turn.bind(...identity);
      expect(rebound).not.toBe(oldBinding);
      expect(rebound).toEqual({ disabled: false });
    },
  );

  it("does not share captured or disabled state across turns", () => {
    const first = new CodexTurnState().bind(...identity);
    captureCodexTurnState(first, "first-turn");
    first.disabled = true;
    expect(new CodexTurnState().bind(...identity)).toEqual({ disabled: false });
  });
});

describe("isCodexRoutingRejection", () => {
  it.each([400, 422])(
    "recognizes explicit routing rejection with status %s",
    (status) => {
      for (const param of ["prompt_cache_key", CODEX_TURN_STATE_HEADER]) {
        expect(isCodexRoutingRejection({ status, param })).toBe(true);
        expect(isCodexRoutingRejection({ status, error: { param } })).toBe(
          true,
        );
        expect(
          isCodexRoutingRejection({ status, message: `Unsupported ${param}` }),
        ).toBe(true);
        expect(
          isCodexRoutingRejection({
            status,
            error: { message: `Invalid ${param}` },
          }),
        ).toBe(true);
      }
    },
  );

  it.each([
    undefined,
    "unsupported prompt_cache_key",
    { status: 400, message: "Invalid request" },
    { status: 422, param: "input" },
    { status: 400, message: "prompt_cache_key processing failed" },
    ...[401, 403, 429, 500].map((status) => ({
      status,
      param: "prompt_cache_key",
      message: "Unsupported prompt_cache_key",
    })),
  ])(
    "does not classify unrelated failures as routing rejection: %j",
    (error) => {
      expect(isCodexRoutingRejection(error)).toBe(false);
    },
  );
});
