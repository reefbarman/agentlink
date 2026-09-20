import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const extensionSource = fs.readFileSync(
  path.join(__dirname, "extension.ts"),
  "utf8",
);

function extractCallArguments(source: string, callee: string): string {
  const start = source.indexOf(`${callee}(`);
  expect(start, `${callee} call in src/extension.ts`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = start + callee.length; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated ${callee} call`);
}

/**
 * Regression guard for the OpenAI-compatible credential seam. Every writer and
 * reader of OpenAI-compatible API keys must share the store selected at
 * activation (`openAiCompatibleSecrets`, the shared Keychain store when it is
 * available). Wiring one side to `context.secrets` stores keys where the
 * providers never look, so the model picker keeps asking for a key that was
 * already entered.
 */
describe("OpenAI-compatible credential wiring", () => {
  it("routes the Set/Clear API key commands through the shared credential service", () => {
    const registration = extractCallArguments(
      extensionSource,
      "registerOpenAiCompatibleAuthCommands",
    );
    expect(registration).toContain("credentials: openAiCompatibleCredentials");
    expect(registration).not.toContain("context.secrets");
    expect(registration).not.toContain("context.globalState");
  });

  it("builds the credential service and provider manager from the same store", () => {
    const service = extractCallArguments(
      extensionSource,
      "new OpenAiCompatibleCredentialService",
    );
    const manager = extractCallArguments(
      extensionSource,
      "new OpenAiCompatibleProviderManager",
    );
    expect(service).toContain("secrets: openAiCompatibleSecrets");
    expect(manager).toContain("secrets: openAiCompatibleSecrets");
  });
});
