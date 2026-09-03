import * as os from "node:os";

import {
  CODEX_ORIGINATOR_OVERRIDE_ENV_VAR,
  CODEX_USER_AGENT_OVERRIDE_ENV_VAR,
  DEFAULT_CODEX_ORIGINATOR,
  getCodexOriginator,
  getCodexUserAgent,
} from "./clientIdentity.js";
import { describe, expect, it } from "vitest";

describe("Codex client identity", () => {
  it("defaults the originator to agentlink", () => {
    expect(getCodexOriginator({})).toBe(DEFAULT_CODEX_ORIGINATOR);
  });

  it("uses the originator env override when set", () => {
    expect(
      getCodexOriginator({
        [CODEX_ORIGINATOR_OVERRIDE_ENV_VAR]: "codex_cli_rs",
      }),
    ).toBe("codex_cli_rs");
  });

  it("ignores a whitespace-only originator override", () => {
    expect(
      getCodexOriginator({ [CODEX_ORIGINATOR_OVERRIDE_ENV_VAR]: "   " }),
    ).toBe(DEFAULT_CODEX_ORIGINATOR);
  });

  it("derives the default User-Agent product token from the effective originator", () => {
    const expectedSuffix = `(${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`;
    expect(getCodexUserAgent({})).toBe(`agentlink/1.0 ${expectedSuffix}`);
    expect(
      getCodexUserAgent({
        [CODEX_ORIGINATOR_OVERRIDE_ENV_VAR]: "codex_cli_rs",
      }),
    ).toBe(`codex_cli_rs/1.0 ${expectedSuffix}`);
  });

  it("prefers an explicit User-Agent override over derivation", () => {
    expect(
      getCodexUserAgent({
        [CODEX_ORIGINATOR_OVERRIDE_ENV_VAR]: "codex_cli_rs",
        [CODEX_USER_AGENT_OVERRIDE_ENV_VAR]:
          "codex_cli_rs/0.144.1 (Darwin 25.5.0; arm64) iTerm.app/3.6.10",
      }),
    ).toBe("codex_cli_rs/0.144.1 (Darwin 25.5.0; arm64) iTerm.app/3.6.10");
  });
});
