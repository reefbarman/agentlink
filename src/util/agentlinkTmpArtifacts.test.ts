import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { isAgentlinkTmpArtifact } from "./agentlinkTmpArtifacts.js";

describe("isAgentlinkTmpArtifact", () => {
  it("recognizes terminal output files emitted under os.tmpdir", () => {
    const filePath = path.join(
      os.tmpdir(),
      "agentlink-output-abc123",
      "output.txt",
    );

    expect(isAgentlinkTmpArtifact(filePath)).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "recognizes macOS /var and /private/var aliases for terminal output files",
    () => {
      const varPath =
        "/var/folders/_1/fdgqf2bj3zg17zyvfpmy9y1h0000gn/T/agentlink-output-abc123/output.txt";
      const privateVarPath = `/private${varPath}`;

      expect(isAgentlinkTmpArtifact(varPath)).toBe(true);
      expect(isAgentlinkTmpArtifact(privateVarPath)).toBe(true);
    },
  );

  it("does not recognize unrelated temp files", () => {
    expect(isAgentlinkTmpArtifact("/tmp/not-agentlink-output/output.txt")).toBe(
      false,
    );
    expect(
      isAgentlinkTmpArtifact(
        path.join(os.tmpdir(), "agentlink-outputish", "output.txt"),
      ),
    ).toBe(false);
  });
});
