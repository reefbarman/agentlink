import {
  CODEX_OAUTH_CREDENTIALS_STORAGE_KEY,
  CodexOAuthFlowError,
  CodexOAuthManager,
  codexOAuthManager,
} from "./CodexOAuthManager.js";
import { describe, expect, it } from "vitest";

describe("CodexOAuthManager compatibility exports", () => {
  it("preserves the public manager surface at the old extension path", () => {
    expect(CODEX_OAUTH_CREDENTIALS_STORAGE_KEY).toBe("codex-oauth-credentials");
    expect(CodexOAuthFlowError.name).toBe("CodexOAuthFlowError");
    expect(CodexOAuthManager.name).toBe("CodexOAuthManager");
    expect(codexOAuthManager).toBeInstanceOf(CodexOAuthManager);
  });
});
