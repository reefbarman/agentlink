import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES,
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES,
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_OWNER_COMMAND_KINDS,
  type BrowserGatewayCommandDeadlineClass,
  type BrowserGatewayCommandIdempotency,
  type BrowserGatewayOwnerCommandKind,
} from "./browserGatewayOwnerCommandMetadata.js";

describe("browser gateway owner command metadata", () => {
  it("pins and freezes the complete owner-command kind set", () => {
    expect(BROWSER_GATEWAY_OWNER_COMMAND_KINDS).toEqual([
      "session.select",
      "session.detail",
      "session.send",
      "session.stop",
      "approval.respond",
      "question.respond",
      "history.load",
      "diff.detail",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_OWNER_COMMAND_KINDS)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_OWNER_COMMAND_KINDS as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayOwnerCommandKind>().toEqualTypeOf<
      | "session.select"
      | "session.detail"
      | "session.send"
      | "session.stop"
      | "approval.respond"
      | "question.respond"
      | "history.load"
      | "diff.detail"
    >();
  });

  it("pins and freezes command idempotency values", () => {
    expect(BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES).toEqual([
      "idempotent",
      "non_idempotent",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayCommandIdempotency>().toEqualTypeOf<
      "idempotent" | "non_idempotent"
    >();
  });

  it("pins and freezes command deadline classes", () => {
    expect(BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES).toEqual([
      "default",
      "long",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES)).toBe(
      true,
    );
    expect(() =>
      (BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayCommandDeadlineClass>().toEqualTypeOf<
      "default" | "long"
    >();
  });

  it("pins and freezes command idempotency metadata", () => {
    expect(BROWSER_GATEWAY_COMMAND_IDEMPOTENCY).toEqual({
      "session.select": "idempotent",
      "session.detail": "idempotent",
      "session.send": "non_idempotent",
      "session.stop": "idempotent",
      "approval.respond": "non_idempotent",
      "question.respond": "non_idempotent",
      "history.load": "idempotent",
      "diff.detail": "idempotent",
    });
    expect(Object.isFrozen(BROWSER_GATEWAY_COMMAND_IDEMPOTENCY)).toBe(true);
    expect(() =>
      Object.assign(BROWSER_GATEWAY_COMMAND_IDEMPOTENCY, {
        "session.select": "non_idempotent",
      }),
    ).toThrow(TypeError);
  });
});
