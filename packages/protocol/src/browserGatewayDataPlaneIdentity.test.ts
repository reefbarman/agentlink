import {
  BROWSER_GATEWAY_DETAIL_HANDLE_KINDS,
  type BrowserGatewayDataPlaneIdentity,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayDetailHandleKind,
} from "./browserGatewayDataPlaneIdentity.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("browser gateway data-plane identity", () => {
  it("pins the complete identity contract", () => {
    expectTypeOf<BrowserGatewayDataPlaneIdentity>().toEqualTypeOf<{
      helperGenerationId: string;
      ownerId: string;
      ownerGenerationId: string;
    }>();
  });

  it("pins and freezes the complete detail-handle kind set", () => {
    expect(BROWSER_GATEWAY_DETAIL_HANDLE_KINDS).toEqual([
      "message",
      "diff",
      "media",
      "interaction",
      "session",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_DETAIL_HANDLE_KINDS)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_DETAIL_HANDLE_KINDS as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayDetailHandleKind>().toEqualTypeOf<
      "message" | "diff" | "media" | "interaction" | "session"
    >();
  });

  it("pins the complete detail-handle contract", () => {
    expectTypeOf<BrowserGatewayDetailHandle>().toEqualTypeOf<{
      helperGenerationId: string;
      ownerId: string;
      ownerGenerationId: string;
      handleId: string;
      kind: "message" | "diff" | "media" | "interaction" | "session";
      byteLength: number;
      expiresAt: number;
      mediaType?: string;
    }>();
  });
});
