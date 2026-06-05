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
      // Derive from the real tmpdir so the test matches this machine's prefix
      // (the folder hash differs per machine), not a hardcoded one.
      const base = os.tmpdir();
      const varBase = base.startsWith("/private/")
        ? base.slice("/private".length)
        : base;
      const varPath = path.join(varBase, "agentlink-output-abc123", "output.txt");
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
