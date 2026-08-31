import {
  BROWSER_GATEWAY_COMMAND_DEADLINE_MS_BY_CLASS,
  BROWSER_GATEWAY_DATA_PLANE_LIMITS,
  BROWSER_GATEWAY_DATA_PLANE_LIMIT_OWNERS,
  browserGatewayDetailResponseByteLimit,
} from "./browserGatewayDataPlaneLimits.js";
import { describe, expect, it } from "vitest";

describe("browser gateway data-plane limits", () => {
  it("keeps every limit assigned to an owner", () => {
    expect(Object.keys(BROWSER_GATEWAY_DATA_PLANE_LIMIT_OWNERS).sort()).toEqual(
      Object.keys(BROWSER_GATEWAY_DATA_PLANE_LIMITS).sort(),
    );
  });

  it("keeps aggregate transport limits internally consistent", () => {
    expect(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationRequestBytes,
    ).toBeGreaterThanOrEqual(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchBytes,
    );
    expect(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationQueueBytes,
    ).toBeLessThan(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchBytes,
    );
    expect(BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs).toBe(
      4 * BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
    );
  });

  it("maps every command deadline class to its owned limit", () => {
    expect(BROWSER_GATEWAY_COMMAND_DEADLINE_MS_BY_CLASS).toEqual({
      default: BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
      long: BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs,
    });
    expect(Object.isFrozen(BROWSER_GATEWAY_COMMAND_DEADLINE_MS_BY_CLASS)).toBe(
      true,
    );
  });

  it("uses the larger authenticated response budget only for session details", () => {
    expect(browserGatewayDetailResponseByteLimit("session")).toBe(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedSessionDetailResponseBytes,
    );
    expect(browserGatewayDetailResponseByteLimit("message")).toBe(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes,
    );
  });
});
