import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BrowserGatewayProtocolError,
  type BrowserGatewayProtocolErrorCode,
} from "./browserGatewayProtocolError.js";

describe("browser gateway protocol error", () => {
  it("pins the complete protocol-error code contract", () => {
    expectTypeOf<BrowserGatewayProtocolErrorCode>().toEqualTypeOf<
      | "invalid_type"
      | "invalid_value"
      | "unknown_field"
      | "unsupported_version"
      | "unsupported_kind"
      | "resource_limit"
      | "sequence_mismatch"
      | "identity_mismatch"
    >();
  });

  it("preserves structured error identity and presentation", () => {
    const error = new BrowserGatewayProtocolError(
      "invalid_value",
      "$.sessionId",
      "must be non-empty",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BrowserGatewayProtocolError);
    expect(error).toMatchObject({
      name: "BrowserGatewayProtocolError",
      code: "invalid_value",
      path: "$.sessionId",
      message: "$.sessionId: must be non-empty",
    });
  });
});
