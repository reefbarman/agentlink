import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSearchFiles } from "./searchFiles.js";

const { execRipgrepSearch, getRipgrepBinPath } = vi.hoisted(() => ({
  execRipgrepSearch: vi.fn(),
  getRipgrepBinPath: vi.fn(),
}));

vi.mock("../util/ripgrep.js", async () => ({
  ...(await vi.importActual<typeof import("../util/ripgrep.js")>(
    "../util/ripgrep.js",
  )),
  execRipgrepSearch,
  getRipgrepBinPath,
}));

function matchOutput(file: string, content: string): string {
  return [
    { type: "begin", data: { path: { text: file } } },
    ...content.split("\n").map((text, index) => ({
      type: index === 0 ? "match" : "context",
      data: {
        path: { text: file },
        lines: { text: text + "\n" },
        line_number: index + 1,
      },
    })),
    { type: "end", data: { path: { text: file } } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

describe("search result structured-secret redaction", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "search-redaction-"));
    execRipgrepSearch.mockReset();
    getRipgrepBinPath.mockResolvedValue("rg");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function search(file: string, content: string, create = true) {
    const target = path.join(root, file);
    if (create) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    execRipgrepSearch.mockResolvedValue(matchOutput(target, content));
    return handleSearchFiles(
      { path: root, regex: "theme", context: 5 },
      {} as never,
      {} as never,
      "search-redaction",
      {
        workspaceFileProvider: {
          resolvePath: () => ({ absolutePath: root, inWorkspace: true }),
        },
        pathAccessProvider: { ensureAccess: async () => ({ approved: true }) },
      },
    );
  }

  it("redacts matched and contextual values from the full JSONC document", async () => {
    const content = [
      "{ // settings",
      '  "theme": "dark",',
      '  "agentlink.openaiApiKey": "synthetic-api-key",',
      '  "nested": { "authorization": "synthetic-bearer" },',
      '  "passwords": [',
      '    "synthetic-first",',
      '    "synthetic-second"',
      "  ],",
      "}",
    ].join("\n");
    const result = await search("settings.json", content);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "synthetic-api-key",
      "synthetic-bearer",
      "synthetic-first",
      "synthetic-second",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(result.data).toMatchObject({
      redaction: {
        type: "structured_secret_values",
        count: 3,
        withheld_files: 0,
      },
    });
    expect((result.data as { results: string }).results).toContain(
      '2 |   "theme": "dark"',
    );
    expect((result.data as { results: string }).results).toContain("9 | }");
  });

  it("redacts a credential in the matched line itself", async () => {
    const result = await search(
      "settings.json",
      '{"apiKey":"synthetic-matched-secret","theme":"dark"}',
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-matched-secret");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("withholds malformed eligible settings rather than exposing raw matches", async () => {
    const result = await search(
      "settings.jsonc",
      '{ "theme": "dark", "apiKey": "synthetic-invalid-secret"',
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-invalid-secret");
    expect(JSON.stringify(result)).toContain("CONTENT WITHHELD");
    expect(result.data).toMatchObject({ redaction: { withheld_files: 1 } });
  });

  it("withholds settings which disappear between search and safe reading", async () => {
    const result = await search(
      "settings.json",
      '{ "theme": "dark", "token": "synthetic-missing-secret" }',
      false,
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-missing-secret");
    expect(JSON.stringify(result)).toContain("CONTENT WITHHELD");
  });

  it("redacts multiline TOML secret values using the existing reader policy", async () => {
    const result = await search(
      "mise.toml",
      'theme = "dark"\napi_key = """synthetic-line-one\nsynthetic-line-two"""',
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-line-one");
    expect(JSON.stringify(result)).not.toContain("synthetic-line-two");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("keeps safe configuration lines bounded after redaction", async () => {
    const result = await search(
      "settings.json",
      JSON.stringify({
        theme: "x".repeat(4000),
        apiKey: "synthetic-long-secret",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-long-secret");
    expect((result.data as { results: string }).results.length).toBeLessThan(
      700,
    );
  });

  it("does not read arbitrary source files as structured settings", async () => {
    const result = await search("source.ts", 'const theme = "dark";', false);
    expect(result.data).not.toHaveProperty("redaction");
    expect(JSON.stringify(result)).toContain("const theme");
  });
});
