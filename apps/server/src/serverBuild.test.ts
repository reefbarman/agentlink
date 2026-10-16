import { describe, expect, it } from "vitest";

import {
  describeBuild,
  parseBuild,
  versionProblems,
  type ServerBuild,
} from "./serverBuild.js";

const SELF: ServerBuild = { version: "0.1.0", commit: "abcd1234", id: "b1" };

describe("service versions", () => {
  it("describes builds", () => {
    expect(describeBuild(SELF)).toBe("0.1.0 (abcd1234)");
    expect(describeBuild({ version: "0.1.0", id: "x" })).toBe("0.1.0");
    expect(describeBuild(undefined)).toBe("an older version");
    expect(parseBuild({ version: "0.1.0", id: "b1", commit: 7 })).toEqual({
      version: "0.1.0",
      id: "b1",
    });
    expect(parseBuild("0.1.0")).toBeUndefined();
  });

  it("finds nothing wrong when every service runs this build", () => {
    expect(
      versionProblems(SELF, [
        {
          name: "publisher",
          reachable: true,
          build: SELF,
          protocol: 1,
          expectedProtocol: 1,
        },
      ]),
    ).toEqual([]);
  });

  it("names unreachable services, other protocols and other builds in plain words", () => {
    expect(
      versionProblems(SELF, [
        {
          name: "command worker",
          reachable: false,
          error: "worker_ECONNREFUSED",
        },
        {
          name: "publisher",
          reachable: true,
          build: SELF,
          protocol: 2,
          expectedProtocol: 1,
        },
        {
          name: "backup sidecar",
          reachable: true,
          build: { version: "0.0.9", commit: "ffff0000", id: "b0" },
          protocol: 1,
          expectedProtocol: 1,
        },
        { name: "runner manager", reachable: true },
      ]),
    ).toEqual([
      "command worker is not reachable (worker_ECONNREFUSED)",
      "publisher speaks protocol 2, the assistant 1: rebuild both",
      "backup sidecar is version 0.0.9 (ffff0000), the assistant is 0.1.0 (abcd1234): rebuild both",
      "runner manager reports no version, so it is older than the assistant (0.1.0 (abcd1234)): rebuild both",
    ]);
  });

  it("skips the build comparison when running from source", () => {
    expect(
      versionProblems({ version: "dev", id: "dev" }, [
        { name: "publisher", reachable: true },
      ]),
    ).toEqual([]);
  });
});
