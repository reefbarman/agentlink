import {
  BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID,
  normalizeBrowserGatewayModelCredentialProviderId,
} from "./browserGatewayModelProviderIdentity.js";
import { describe, expect, it } from "vitest";

describe("browser gateway model-provider identity", () => {
  it("maps the VS Code Codex provider alias to the credential family", () => {
    expect(BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID).toBe("openai-codex");
    expect(normalizeBrowserGatewayModelCredentialProviderId("codex")).toBe(
      BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID,
    );
    expect(normalizeBrowserGatewayModelCredentialProviderId(" codex ")).toBe(
      BROWSER_GATEWAY_CODEX_CREDENTIAL_PROVIDER_ID,
    );
    // Provider aliases are intentionally case-sensitive; the VS Code registry
    // emits lowercase `codex`, while unknown identities remain unchanged.
    expect(normalizeBrowserGatewayModelCredentialProviderId(" Codex ")).toBe(
      "Codex",
    );
  });

  it("trims and preserves every other provider identity", () => {
    for (const providerId of [
      "openai-codex",
      "anthropic",
      "openai-compatible:local",
      "browser-gateway",
      "",
    ]) {
      expect(
        normalizeBrowserGatewayModelCredentialProviderId(` ${providerId} `),
      ).toBe(providerId);
    }
  });
});
