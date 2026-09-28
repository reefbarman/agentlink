import * as os from "os";
import * as path from "path";

import {
  AGENTLINK_RESULT_RUN_PREFIX,
  isAgentlinkTmpArtifact,
} from "./agentlinkTmpArtifacts.js";
import { describe, expect, it, vi } from "vitest";

describe("isAgentlinkTmpArtifact", () => {
  it("recognizes terminal output files emitted under os.tmpdir", () => {
    const filePath = path.join(
      os.tmpdir(),
      "agentlink-output-abc123",
      "output.txt",
    );

    expect(isAgentlinkTmpArtifact(filePath)).toBe(true);
  });

  it("recognizes private run-scoped result artifacts under os.tmpdir", () => {
    const filePath = path.join(
      os.tmpdir(),
      `${AGENTLINK_RESULT_RUN_PREFIX}abc123`,
      "output.jsonl",
    );

    expect(isAgentlinkTmpArtifact(filePath)).toBe(true);
  });

  it("recognizes the AgentLink truncated-result root itself", () => {
    expect(isAgentlinkTmpArtifact("/tmp/agentlink-results")).toBe(true);
    expect(isAgentlinkTmpArtifact("/tmp/agentlink-results/")).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "recognizes macOS /var and /private/var aliases for terminal output files",
    async () => {
      const varBase = "/var/folders/agentlink-test/T";
      vi.stubEnv("TMPDIR", varBase);
      vi.resetModules();
      try {
        const { isAgentlinkTmpArtifact } =
          await import("./agentlinkTmpArtifacts.js");
        const varPath = path.join(
          varBase,
          "agentlink-output-abc123",
          "output.txt",
        );
        const privateVarPath = `/private${varPath}`;

        expect(isAgentlinkTmpArtifact(varPath)).toBe(true);
        expect(isAgentlinkTmpArtifact(privateVarPath)).toBe(true);

        const resultPath = path.join(
          varBase,
          `${AGENTLINK_RESULT_RUN_PREFIX}abc123`,
          "output.jsonl",
        );
        expect(isAgentlinkTmpArtifact(resultPath)).toBe(true);
        expect(isAgentlinkTmpArtifact(`/private${resultPath}`)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
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
    expect(
      isAgentlinkTmpArtifact(
        path.join(os.tmpdir(), "agentlink-result-other", "output.jsonl"),
      ),
    ).toBe(false);
  });
});
