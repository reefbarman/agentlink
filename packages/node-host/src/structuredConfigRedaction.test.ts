import { describe, expect, it } from "vitest";

import { redactNodeHostStructuredConfig } from "./structuredConfigRedaction.js";

describe("node-host structured config redaction", () => {
  it("does not treat source config modules as structured JSON", () => {
    const content = "export default { token: process.env.TOKEN };\n";
    expect(redactNodeHostStructuredConfig("vite.config.ts", content)).toEqual({
      content,
      redacted: false,
    });
  });

  it("keeps source settings modules readable", () => {
    const content = "TOKEN = os.environ['TOKEN']\n";
    expect(redactNodeHostStructuredConfig("settings.py", content)).toEqual({
      content,
      redacted: false,
    });
  });

  it("does not classify ordinary JSON files such as tsconfig", () => {
    const content = '{\n  // compiler options\n  "compilerOptions": {},\n}\n';
    expect(redactNodeHostStructuredConfig("tsconfig.json", content)).toEqual({
      content,
      redacted: false,
    });
  });

  it("redacts JSONC config values without changing line structure", () => {
    const content =
      '{\n  // retained comment\n  "theme": "dark",\n  "apiKey": "secret",\n}\n';
    const result = redactNodeHostStructuredConfig(
      ".vscode/settings.json",
      content,
    );
    expect(result.redacted).toBe(true);
    expect(result.content).toBe(
      '{\n  // retained comment\n  "theme": "dark",\n  "apiKey": "[REDACTED]",\n}\n',
    );
  });

  it("withholds malformed eligible config while preserving its line count", () => {
    const content = '{\n  "token": "secret"\n  broken\n}\n';
    const result = redactNodeHostStructuredConfig("settings.json", content);
    expect(result).toMatchObject({
      redacted: true,
      status: "withheld_invalid_jsonc",
    });
    expect(result.content.split("\n")).toHaveLength(content.split("\n").length);
    expect(result.content).not.toContain("secret");
  });

  it("withholds unsupported credential config formats without exposing values", () => {
    for (const filePath of [
      ".codex/config.toml",
      ".config/mise/config.toml",
      "settings.yaml",
    ]) {
      const content = "token = secret\nother = visible\n";
      const result = redactNodeHostStructuredConfig(filePath, content);
      expect(result).toMatchObject({
        redacted: true,
        status: "withheld_unsupported_config",
      });
      expect(result.content).not.toContain("secret");
      expect(result.content.split("\n")).toHaveLength(
        content.split("\n").length,
      );
    }
  });
});
