import { expect, expectTypeOf, it } from "vitest";

import { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";

it("pins the browser gateway data-plane protocol version", () => {
  expect(BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION).toBe("1");
  expectTypeOf<
    typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION
  >().toEqualTypeOf<"1">();
});
