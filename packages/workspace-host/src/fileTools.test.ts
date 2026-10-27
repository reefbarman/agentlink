import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeHostLocalFileSystem } from "@agentlink/node-host";

import {
  createWorkspaceFileTools,
  normalizeWorkspaceGitStatus,
  type WorkspaceFileApprovalDisplay,
} from "./fileTools.js";
import type {
  WorkspaceExecutionBackend,
  WorkspaceProcessLaunchRequest,
} from "./workspaceExecutionBackend.js";

const principal = { tenantId: "local", subjectId: "project" };
const discovery = {
  principal,
  sessionId: "session",
  turnId: "turn",
  input: { text: "test", attachments: undefined },
};
const model = {
  model: { providerId: "fixture", modelId: "model" },
  source: "runtime" as const,
};

/** A one-page PDF with a single line of Helvetica text and a valid xref. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "workspace-files-"),
  );
  const sessionGrants = new Map<
    string,
    { contentHash: string; scopeDigest: string; policyRevision: string }
  >();
  const files = createWorkspaceFileTools({
    projectRoot: root,
    approvalPolicy: {
      hasSessionGrant: (proposal) => {
        const grant = sessionGrants.get(
          JSON.stringify([proposal.toolName, proposal.path]),
        );
        if (!grant) return false;
        return (
          grant.contentHash === proposal.expectedContentHash &&
          grant.scopeDigest === proposal.scopeDigest &&
          grant.policyRevision === proposal.policyRevision
        );
      },
    },
  });
  const tools = await files.resolveTools(discovery);
  return {
    root,
    files,
    sessionGrants,
    toolNames: tools.map((tool) => tool.definition.name),
    tool(name: string) {
      const tool = tools.find(
        (candidate) => candidate.definition.name === name,
      );
      if (!tool) throw new Error(`Missing tool ${name}`);
      return tool;
    },
  };
}

function context() {
  return {
    principal,
    sessionId: "session",
    turnId: "turn",
    model,
    signal: undefined,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("workspace file tools", () => {
  it("normalizes porcelain Git status with VS Code's priority", () => {
    expect(normalizeWorkspaceGitStatus("")).toBe("clean");
    expect(normalizeWorkspaceGitStatus("## main...origin/main\n")).toBe(
      "clean",
    );
    expect(normalizeWorkspaceGitStatus("?? new.ts\n")).toBe("untracked");
    expect(normalizeWorkspaceGitStatus(" M changed.ts\n")).toBe("modified");
    expect(normalizeWorkspaceGitStatus("M  staged.ts\n M changed.ts\n")).toBe(
      "staged",
    );
    expect(
      normalizeWorkspaceGitStatus("UU conflicted.ts\nM  staged.ts\n"),
    ).toBe("unmerged");
  });

  it("enriches the read_file context view without changing file access", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-lsp-"),
    );
    try {
      await fs.writeFile(
        path.join(root, "index.ts"),
        "export const value = 1;\n",
      );
      let observedSignal: AbortSignal | undefined;
      const files = createWorkspaceFileTools({
        projectRoot: root,
        enrichReadFileContext: async (_request, _relativePath, options) => {
          observedSignal = options.signal;
          return {
            diagnostics: { errors: 0, warnings: 1, note: "fixture" },
            symbols: { variable: ["value (line 1)"] },
          };
        },
      });
      const tools = await files.resolveTools(discovery);
      const controller = new AbortController();
      const result = await tools
        .find((tool) => tool.definition.name === "read_file")!
        .execute(
          { path: "index.ts", view: "context" },
          { ...context(), signal: controller.signal },
        );
      expect(observedSignal).toBe(controller.signal);
      expect(JSON.parse(String(result.modelContent))).toMatchObject({
        path: "index.ts",
        content: expect.stringContaining("export const value"),
        diagnostics: { errors: 0, warnings: 1 },
        symbols: { variable: ["value (line 1)"] },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy enrichContext SDK callback and payload", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-legacy-lsp-"),
    );
    try {
      await fs.writeFile(path.join(root, "index.ts"), "export {};\n");
      let observedSignal: AbortSignal | undefined;
      const files = createWorkspaceFileTools({
        projectRoot: root,
        enrichContext: (_request, _relativePath, signal) => {
          observedSignal = signal;
          return { state: "ready", legacy: true };
        },
      });
      const controller = new AbortController();
      const result = await (
        await files.resolveTools(discovery)
      )
        .find((tool) => tool.definition.name === "read_file")!
        .execute(
          { path: "index.ts", view: "context" },
          { ...context(), signal: controller.signal },
        );
      expect(observedSignal).toBe(controller.signal);
      expect(JSON.parse(String(result.modelContent))).toMatchObject({
        languageIntelligence: { state: "ready", legacy: true },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reads project-relative context with a baseline and hides protected search results", async () => {
    const test = await fixture();
    await fs.writeFile(path.join(test.root, "visible.txt"), "hello\nworld\n");
    await fs.writeFile(path.join(test.root, ".env"), "TOKEN=secret\n");
    await fs.mkdir(path.join(test.root, "node_modules"));
    await fs.writeFile(
      path.join(test.root, "node_modules/ignored.js"),
      "secret",
    );
    const settingsContent =
      '{\n  // keep this line\n  "theme": "dark",\n  "apiKey": "secret",\n}\n';
    await fs.writeFile(path.join(test.root, "settings.json"), settingsContent);

    const result = await test
      .tool("read_file")
      .execute({ path: "visible.txt", view: "context" }, context());
    expect(JSON.parse(String(result.modelContent))).toMatchObject({
      path: "visible.txt",
      content: "1 | hello\n2 | world\n3 | ",
      working_set: {
        status: "new",
        content_hash: hash("hello\nworld\n"),
        should_include_content: true,
      },
    });
    const redacted = await test
      .tool("read_file")
      .execute({ path: "settings.json", view: "context" }, context());
    expect(JSON.parse(String(redacted.modelContent))).toMatchObject({
      content:
        '1 | {\n2 |   // keep this line\n3 |   "theme": "dark",\n4 |   "apiKey": "[REDACTED]",\n5 | }\n6 | ',
      redaction: { type: "structured_secret_values" },
      working_set: { content_hash: hash(settingsContent) },
    });
    expect(test.toolNames).not.toContain("get_context");
    expect(
      (
        test.tool("read_file").definition.input_schema.properties as Record<
          string,
          { enum?: string[] }
        >
      ).view?.enum,
    ).toEqual(["content", "context"]);
    for (const view of ["content", "context"] as const) {
      await expect(
        test.tool("read_file").execute({ path: ".env", view }, context()),
      ).resolves.toMatchObject({ isError: true });
      await expect(
        test
          .tool("read_file")
          .execute({ path: "node_modules/ignored.js", view }, context()),
      ).resolves.toMatchObject({ isError: true });
    }
    await expect(
      test
        .tool("read_file")
        .execute({ path: "visible.txt", refresh: true }, context()),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining(
        "context_options_require_context_view",
      ),
    });
    await expect(
      test
        .tool("read_file")
        .execute(
          { path: "visible.txt", view: "context", anchor: "world" },
          context(),
        ),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining(
        "content_options_require_content_view",
      ),
    });
    const omitted = await test.tool("read_file").execute(
      {
        path: "visible.txt",
        view: "context",
        dedupe_unchanged_content: true,
      },
      context(),
    );
    expect(JSON.parse(String(omitted.modelContent))).toMatchObject({
      working_set: {
        status: "omitted_unchanged",
        should_include_content: false,
      },
    });
    expect(JSON.parse(String(omitted.modelContent))).not.toHaveProperty(
      "content",
    );
    const refreshed = await test.tool("read_file").execute(
      {
        path: "visible.txt",
        view: "context",
        dedupe_unchanged_content: true,
        refresh: true,
      },
      context(),
    );
    expect(JSON.parse(String(refreshed.modelContent))).toMatchObject({
      content: "1 | hello\n2 | world\n3 | ",
      working_set: { status: "unchanged", should_include_content: true },
    });

    // Without packaged ripgrep this is node-host's VS Code-shaped fallback.
    // Secrets are redacted before matching, so settings.json does not match.
    const search = await test
      .tool("search_files")
      .execute({ path: ".", regex: "secret|hello", context: 0 }, context());
    expect(JSON.parse(String(search.modelContent))).toEqual({
      total_matches: 1,
      truncated: false,
      results: "## visible.txt (1 match)\n> 1 | hello\n---",
    });
    const files = await test.tool("search_files").execute(
      {
        path: ".",
        regex: "theme|hello",
        output_mode: "files_with_matches",
      },
      context(),
    );
    expect(JSON.parse(String(files.modelContent))).toEqual({
      total_files: 2,
      truncated: false,
      files: ["settings.json", "visible.txt"],
    });
    const listed = await test
      .tool("list_files")
      .execute({ path: "." }, context());
    expect(JSON.parse(String(listed.modelContent)).entries).toEqual([
      "settings.json",
      "visible.txt",
    ]);
  });

  it("returns VS Code's read_file content view with anchors, images, and PDF text", async () => {
    const test = await fixture();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    await fs.writeFile(path.join(test.root, "notes.txt"), lines.join("\n"));
    const read = (input: Record<string, unknown>) =>
      test.tool("read_file").execute(input, context());
    const parsed = async (input: Record<string, unknown>) =>
      JSON.parse(String((await read(input)).modelContent)) as Record<
        string,
        unknown
      >;

    const whole = await parsed({ path: "notes.txt", include_symbols: false });
    expect(whole).toMatchObject({
      total_lines: 30,
      showing: "1-30",
      size: lines.join("\n").length,
      content: expect.stringMatching(/^1 \| line 1\n2 \| line 2/u),
    });
    expect(whole).not.toHaveProperty("truncated");
    expect(whole).not.toHaveProperty("path");

    expect(
      await parsed({
        path: "notes.txt",
        anchor: "line 20",
        anchor_offset: -2,
        limit: 3,
      }),
    ).toMatchObject({
      showing: "18-20",
      truncated: true,
      anchor_match: {
        mode: "literal",
        pattern: "line 20",
        line: 20,
        anchor_offset: -2,
      },
      content: "18 | line 18\n19 | line 19\n20 | line 20",
    });
    expect(
      await parsed({
        path: "notes.txt",
        anchor_regex: "^line 2\\d$",
        limit: 1,
      }),
    ).toMatchObject({
      showing: "20-20",
      anchor_match: { mode: "regex", line: 20 },
    });
    expect(
      await parsed({ path: "notes.txt", anchor: "absent", limit: 1 }),
    ).toMatchObject({
      showing: "1-1",
      anchor_match: { status: "not_found", mode: "literal" },
    });
    await expect(
      read({ path: "notes.txt", anchor: "a", anchor_regex: "b" }),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({
        error: "Specify only one of 'anchor' or 'anchor_regex' (not both).",
        path: "notes.txt",
      }),
    });
    expect(await parsed({ path: "notes.txt", offset: 99 })).toMatchObject({
      total_lines: 30,
      showing: "0-0",
      content: "",
      path: "notes.txt",
    });

    // A window past the standalone output budget ends early with next_read.
    const wide = Array.from({ length: 300 }, () => "x".repeat(1_000));
    await fs.writeFile(path.join(test.root, "wide.txt"), wide.join("\n"));
    const budgeted = await parsed({ path: "wide.txt" });
    expect(budgeted).toMatchObject({
      truncated: true,
      content_truncation: {
        reason: "output_budget",
        next_read: { offset: expect.any(Number) },
      },
    });
    expect(String(budgeted.content).length).toBeLessThanOrEqual(128_000);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(path.join(test.root, "pixel.png"), png);
    await expect(read({ path: "pixel.png" })).resolves.toMatchObject({
      modelContent: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: png.toString("base64"),
          },
        },
      ],
      displayContent: { path: "pixel.png", image: "image/png" },
    });
    await fs.writeFile(
      path.join(test.root, "pixel.ppm"),
      Buffer.from("P3\n1 1\n255\n255 0 0\n", "ascii"),
    );
    await expect(read({ path: "pixel.ppm" })).resolves.toMatchObject({
      modelContent: [{ type: "image", source: { media_type: "image/png" } }],
    });
    await fs.writeFile(
      path.join(test.root, "blob.bin"),
      Buffer.from([1, 0, 2]),
    );
    await expect(read({ path: "blob.bin" })).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({
        error: "Binary file detected",
        path: "blob.bin",
      }),
    });

    await fs.writeFile(
      path.join(test.root, "brief.pdf"),
      minimalPdf("Hello PDF"),
    );
    const pdf = await parsed({ path: "brief.pdf" });
    expect(pdf).toMatchObject({ file_type: "pdf", showing: "1-1" });
    expect(String(pdf.content)).toContain("Hello PDF");
  });

  it("suggests and auto-follows missing read_file paths like VS Code, only within read policy", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-follow-"),
    );
    try {
      await fs.mkdir(path.join(root, "src/deep"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
      await fs.mkdir(path.join(root, "hidden"));
      await fs.writeFile(path.join(root, "src/deep/target.ts"), "found\n");
      await fs.writeFile(path.join(root, "node_modules/pkg/target.ts"), "x\n");
      await fs.writeFile(path.join(root, "hidden/target.ts"), "scoped out\n");
      await fs.writeFile(path.join(root, ".env"), "TOKEN=1\n");
      await fs.mkdir(path.join(root, "config"));
      await fs.writeFile(path.join(root, "config/.env"), "TOKEN=2\n");
      const files = createWorkspaceFileTools({
        projectRoot: root,
        resolveScopes: () => [
          { path: "src", kind: "directory" },
          { path: "config", kind: "directory" },
          { path: ".env", kind: "file" },
        ],
      });
      const read = (await files.resolveTools(discovery)).find(
        (tool) => tool.definition.name === "read_file",
      )!;

      await expect(
        read.execute({ path: "target.ts" }, context()),
      ).resolves.toMatchObject({
        isError: true,
        modelContent: JSON.stringify({
          error: `File not found: target.ts. Working directory: ${root}`,
          path: "target.ts",
          suggestions: ["src/deep/target.ts"],
        }),
      });
      // Protected files are never suggested, even when in scope.
      const protectedMiss = JSON.parse(
        String(
          (await read.execute({ path: "other/.env" }, context())).modelContent,
        ),
      ) as Record<string, unknown>;
      expect(protectedMiss).not.toHaveProperty("suggestions");

      const followed = JSON.parse(
        String(
          (
            await read.execute(
              { path: "deep/target.ts", auto_follow_suggestion: true },
              context(),
            )
          ).modelContent,
        ),
      ) as Record<string, unknown>;
      expect(followed).toMatchObject({
        content: "1 | found\n2 | ",
        resolution: "auto_followed_suggestion",
        auto_followed_from: "deep/target.ts",
        resolved_path: "src/deep/target.ts",
      });
      await expect(
        read.execute(
          { path: "x.ts", view: "context", auto_follow_suggestion: true },
          context(),
        ),
      ).resolves.toMatchObject({
        isError: true,
        modelContent: expect.stringContaining(
          "content_options_require_content_view",
        ),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks read scope for both read_file views", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-scope-"),
    );
    try {
      await fs.writeFile(path.join(root, "allowed.txt"), "allowed\n");
      await fs.writeFile(path.join(root, "denied.txt"), "denied\n");
      const files = createWorkspaceFileTools({
        projectRoot: root,
        resolveScopes: () => [{ path: "allowed.txt", kind: "file" }],
      });
      const read = (await files.resolveTools(discovery)).find(
        (tool) => tool.definition.name === "read_file",
      )!;
      for (const view of ["content", "context"] as const) {
        await expect(
          read.execute({ path: "denied.txt", view }, context()),
        ).resolves.toMatchObject({
          isError: true,
          modelContent: expect.stringContaining("path_not_scoped"),
        });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs packaged ripgrep with VS Code's search_files contract and filters protected results", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-ripgrep-"),
    );
    try {
      const executable = path.join(root, "fake-rg.mjs");
      const argumentsPath = path.join(root, "ripgrep-arguments.json");
      await fs.writeFile(
        path.join(root, "settings.json"),
        '{\n  "token": "abc123secret"\n}\n',
      );
      const at = (name: string) => JSON.stringify(path.join(root, name));
      await fs.writeFile(
        executable,
        `#!${process.execPath}\n` +
          `import { writeFileSync } from "node:fs";\n` +
          `const args = process.argv.slice(2);\n` +
          `writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(args));\n` +
          `const out = (line) => process.stdout.write(line + "\\n");\n` +
          `if (args.includes("(")) { process.stderr.write("regex parse error\\n"); process.exit(2); }\n` +
          `if (args.includes("--files-with-matches")) { for (const f of [${at(".env")}, ${at("visible.txt")}, ${at("other.txt")}]) out(f); process.exit(0); }\n` +
          `if (args.includes("--count")) { out(${at(".env")} + ":1"); out(${at("visible.txt")} + ":1"); out(${at("other.txt")} + ":2"); process.exit(0); }\n` +
          `const event = (type, file, line, text) => out(JSON.stringify({ type, data: { path: { text: file }, line_number: line, lines: { text } } }));\n` +
          `for (const [file, lines] of [\n` +
          `  [${at(".env")}, [["match", 1, "TOKEN=secret\\n"]]],\n` +
          `  [${at("visible.txt")}, [["context", 1, "before\\n"], ["match", 2, "Needle\\n"]]],\n` +
          `  [${at("settings.json")}, [["match", 2, '  "token": "abc123secret"\\n']]],\n` +
          `  [${at("other.txt")}, [["match", 3, "Needle again\\n"]]],\n` +
          `]) { out(JSON.stringify({ type: "begin", data: { path: { text: file } } })); for (const [type, line, text] of lines) event(type, file, line, text); out(JSON.stringify({ type: "end", data: { path: { text: file } } })); }\n`,
      );
      await fs.chmod(executable, 0o755);
      const files = createWorkspaceFileTools({
        projectRoot: root,
        ripgrepExecutable: executable,
      });
      const tools = await files.resolveTools(discovery);
      const search = tools.find(
        (tool) => tool.definition.name === "search_files",
      )!;
      expect(search.definition.input_schema).toMatchObject({
        required: ["path", "regex"],
        properties: {
          output_mode: { enum: ["content", "files_with_matches", "count"] },
          file_pattern: expect.any(Object),
          offset: expect.any(Object),
        },
      });
      const run = async (input: Record<string, unknown>) =>
        JSON.parse(
          String((await search.execute(input, context())).modelContent),
        ) as Record<string, any>;

      await expect(
        run({
          path: ".",
          regex: "needle",
          case_insensitive: true,
          max_results: 1,
        }),
      ).resolves.toEqual({
        total_matches: 1,
        truncated: true,
        results: "## visible.txt (1 match)\n  1 | before\n> 2 | Needle\n---",
      });
      expect(JSON.parse(await fs.readFile(argumentsPath, "utf8"))).toEqual([
        "--no-config",
        "--max-filesize",
        "1000K",
        "--json",
        "-e",
        "needle",
        "--no-messages",
        "--context",
        "1",
        "--ignore-case",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/node_modules/**",
        "--",
        root,
      ]);

      const redacted = await run({
        path: ".",
        regex: "token",
        file_pattern: "*.{json,txt}",
        context: 0,
        offset: 1,
      });
      expect(redacted).toMatchObject({
        total_matches: 3,
        truncated: false,
        offset: 1,
        redaction: { type: "structured_secret_values", count: 1 },
      });
      expect(redacted.results).toContain("## settings.json (1 match)");
      expect(redacted.results).not.toContain("abc123secret");
      expect(redacted.results).not.toContain(".env");
      expect(JSON.parse(await fs.readFile(argumentsPath, "utf8"))).toEqual(
        expect.arrayContaining(["--context", "0", "--glob", "*.json"]),
      );

      await expect(
        run({ path: ".", regex: "needle", output_mode: "files_with_matches" }),
      ).resolves.toEqual({
        total_files: 2,
        truncated: false,
        files: ["visible.txt", "other.txt"],
      });
      await expect(
        run({ path: ".", regex: "needle", output_mode: "count", offset: 1 }),
      ).resolves.toEqual({
        total_files: 1,
        total_matches: 3,
        truncated: false,
        offset: 1,
        counts: [{ file: "other.txt", count: 2 }],
      });

      const invalid = await search.execute(
        { path: ".", regex: "(" },
        context(),
      );
      expect(invalid.isError).toBe(true);
      expect(JSON.parse(String(invalid.modelContent))).toMatchObject({
        error: "ripgrep error: regex parse error",
        regex: "(",
      });

      const controller = new AbortController();
      controller.abort();
      const cancelled = await search.execute(
        { path: ".", regex: "needle" },
        { ...context(), signal: controller.signal },
      );
      expect(cancelled.isError).toBe(true);
      expect(String(cancelled.modelContent)).toContain("search_cancelled");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("waits for post-commit synchronization without making writes depend on it", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-commit-sync-"),
    );
    try {
      const filePath = path.join(root, "index.ts");
      await fs.writeFile(filePath, "export const value = 1;\n");
      const committed: string[] = [];
      const files = createWorkspaceFileTools({
        projectRoot: root,
        onFileCommitted: async (_request, relativePath) => {
          committed.push(
            `${relativePath}:${await fs.readFile(filePath, "utf8")}`,
          );
        },
      });
      const tools = await files.resolveTools(discovery);
      const write = tools.find(
        (tool) => tool.definition.name === "write_file",
      )!;
      const synchronizedWrite = await write.execute(
        {
          path: "index.ts",
          content: "export const value = 2;\n",
          expectedContentHash: hash("export const value = 1;\n"),
        },
        context(),
      );
      expect(synchronizedWrite.isError).not.toBe(true);
      expect(committed).toEqual(["index.ts:export const value = 2;\n"]);

      const resilient = createWorkspaceFileTools({
        projectRoot: root,
        onFileCommitted: async () => {
          throw new Error("language server unavailable");
        },
      });
      const resilientTools = await resilient.resolveTools(discovery);
      const resilientWrite = await resilientTools
        .find((tool) => tool.definition.name === "write_file")!
        .execute(
          {
            path: "index.ts",
            content: "export const value = 3;\n",
            expectedContentHash: hash("export const value = 2;\n"),
          },
          context(),
        );
      expect(resilientWrite.isError).not.toBe(true);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
        "export const value = 3;\n",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepares an exact review and rejects a changed baseline at execution", async () => {
    const test = await fixture();
    const file = path.join(test.root, "file.txt");
    await fs.writeFile(file, "before\n");
    const input = {
      path: "file.txt",
      content: "after\n",
      expectedContentHash: hash("before\n"),
    };

    const approval = await test.files.authorizeToolCall({
      principal,
      sessionId: "session",
      turnId: "turn",
      model,
      toolCallId: "call",
      toolName: "write_file",
      input,
      effect: "write",
    });
    expect(approval.decision).toBe("require_user");
    const display =
      approval.decision === "require_user"
        ? (approval.displayContent as WorkspaceFileApprovalDisplay)
        : undefined;
    expect(display).toMatchObject({
      path: "file.txt",
      expectedContentHash: hash("before\n"),
      proposedContentHash: hash("after\n"),
      protected: false,
      policyRevision: "standalone-cli-files-v1",
    });
    expect(display?.diff).toContain("-before");
    expect(display?.diff).toContain("+after");

    await fs.writeFile(file, "external\n");
    const result = await test.tool("write_file").execute(input, context());
    expect(result.isError).toBe(true);
    expect(String(result.modelContent)).toContain("content_hash_mismatch");
    await expect(fs.readFile(file, "utf8")).resolves.toBe("external\n");
  });

  it("creates safe parents after approval and keeps protected files human-only", async () => {
    const test = await fixture();
    const createInput = {
      path: "nested/deeper/new.txt",
      content: "created\n",
      expectedAbsent: true,
    };
    const approval = await test.files.authorizeToolCall({
      principal,
      sessionId: "session",
      turnId: "turn",
      model,
      toolCallId: "create",
      toolName: "write_file",
      input: createInput,
      effect: "write",
    });
    expect(approval.decision).toBe("require_user");
    const written = await test
      .tool("write_file")
      .execute(createInput, context());
    expect(written.isError).not.toBe(true);
    expect(JSON.parse(String(written.modelContent))).toMatchObject({
      contentHash: hash("created\n"),
      durability: {
        status: "durable",
        outcome: "exact",
        final_content_hash: hash("created\n"),
      },
    });
    await expect(
      fs.readFile(path.join(test.root, "nested/deeper/new.txt"), "utf8"),
    ).resolves.toBe("created\n");

    await fs.writeFile(path.join(test.root, ".env.local"), "TOKEN=secret\n");
    await expect(
      test.files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "environment",
        toolName: "write_file",
        input: {
          path: ".env.local",
          content: "TOKEN=changed\n",
          expectedContentHash: hash("TOKEN=secret\n"),
        },
        effect: "write",
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: "Writes to environment_file are not supported",
    });

    await fs.writeFile(path.join(test.root, "AGENTS.md"), "rules\n");
    test.sessionGrants.set(JSON.stringify(["write_file", "AGENTS.md"]), {
      contentHash: hash("rules\n"),
      scopeDigest: "ignored-for-protected-path",
      policyRevision: "standalone-cli-files-v1",
    });
    const protectedApproval = await test.files.authorizeToolCall({
      principal,
      sessionId: "session",
      turnId: "turn",
      model,
      toolCallId: "protected",
      toolName: "write_file",
      input: {
        path: "AGENTS.md",
        content: "changed\n",
        expectedContentHash: hash("rules\n"),
      },
      effect: "write",
    });
    expect(protectedApproval).toMatchObject({ decision: "require_user" });
    if (protectedApproval.decision === "require_user") {
      expect(protectedApproval.displayContent).toMatchObject({
        protected: true,
        protectionReason: "instruction_file",
      });
    }
  });

  it("reviews VS Code-shaped apply_diff input and pins the reviewed baseline when the hash is omitted", async () => {
    const test = await fixture();
    const filePath = path.join(test.root, "edit.txt");
    const original = "one\ntwo\none\n";
    await fs.writeFile(filePath, original);
    const block = (search: string, replace: string) =>
      [
        "<<<<<<< SEARCH",
        search,
        "======= DIVIDER =======",
        replace,
        ">>>>>>> REPLACE",
      ].join("\n");
    const authorize = (toolCallId: string, input: Record<string, unknown>) =>
      test.files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId,
        toolName: "apply_diff",
        input,
        effect: "write",
      });

    const reviewed = await authorize("occurrence", {
      path: "edit.txt",
      diff: block("one", "ONE"),
      block_options: [{ index: 0, occurrence: 2 }],
    });
    expect(reviewed).toMatchObject({
      decision: "require_user",
      preparedInput: { expectedContentHash: hash(original) },
      displayContent: {
        expectedContentHash: hash(original),
        proposedContentHash: hash("one\ntwo\nONE\n"),
      },
    });
    if (reviewed.decision !== "require_user" || !reviewed.preparedInput) {
      throw new Error("Expected a pinned review");
    }
    const written = await test
      .tool("apply_diff")
      .execute({ ...reviewed.preparedInput }, context());
    expect(written.isError).not.toBe(true);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      "one\ntwo\nONE\n",
    );

    // A diff that cannot apply writes nothing, so it skips review and
    // returns VS Code's recovery payload against the pinned baseline.
    const failing = await authorize("missing", {
      path: "edit.txt",
      diff: block("absent", "x"),
    });
    expect(failing).toMatchObject({ decision: "allow" });
    if (failing.decision !== "allow" || !failing.preparedInput) {
      throw new Error("Expected a pinned failure");
    }
    const failed = await test
      .tool("apply_diff")
      .execute({ ...failing.preparedInput }, context());
    expect(failed.isError).toBe(true);
    expect(JSON.parse(String(failed.modelContent))).toMatchObject({
      failed_block_details: [expect.objectContaining({ reason: "not_found" })],
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      "one\ntwo\nONE\n",
    );

    await expect(
      authorize("stale", {
        path: "edit.txt",
        diff: block("two", "TWO"),
        expectedContentHash: hash(original),
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: "File baseline changed before review",
    });
  });

  it("reviews VS Code's find_and_replace across globbed files and writes exactly the pinned baselines", async () => {
    const test = await fixture();
    await fs.mkdir(path.join(test.root, "src", "nested"), { recursive: true });
    await fs.mkdir(path.join(test.root, "node_modules", "dep"), {
      recursive: true,
    });
    await fs.writeFile(path.join(test.root, "top.ts"), "oldName();\n");
    await fs.writeFile(
      path.join(test.root, "src", "a.ts"),
      "const x = oldName;\noldName();\n",
    );
    await fs.writeFile(
      path.join(test.root, "src", "nested", "b.ts"),
      "export { oldName };\n",
    );
    await fs.writeFile(path.join(test.root, "src", "c.md"), "oldName\n");
    await fs.writeFile(
      path.join(test.root, "node_modules", "dep", "d.ts"),
      "oldName\n",
    );
    const tool = test.tool("find_and_replace");
    expect(tool.definition.input_schema).toMatchObject({
      required: ["find", "replace"],
      properties: {
        glob: expect.any(Object),
        regex: expect.any(Object),
        max_replacements: expect.any(Object),
      },
    });
    const authorize = (toolCallId: string, input: Record<string, unknown>) =>
      test.files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId,
        toolName: "find_and_replace",
        input,
        effect: "write",
      });
    const input = {
      find: "old(\\w+)",
      replace: "new$1",
      regex: true,
      glob: "src/**/*.ts",
    };

    const reviewed = await authorize("glob", input);
    expect(reviewed).toMatchObject({
      decision: "require_user",
      displayContent: {
        kind: "file_write",
        toolName: "find_and_replace",
        path: "2 files",
        replacements: 3,
        files: [
          { path: "src/a.ts", changes: 2 },
          { path: "src/nested/b.ts", changes: 1 },
        ],
      },
    });
    if (reviewed.decision !== "require_user" || !reviewed.preparedInput) {
      throw new Error("Expected a pinned review");
    }
    expect(reviewed.preparedInput.expectedContentHashes).toEqual({
      "src/a.ts": hash("const x = oldName;\noldName();\n"),
      "src/nested/b.ts": hash("export { oldName };\n"),
    });
    const display = reviewed.displayContent as WorkspaceFileApprovalDisplay;
    expect(display.diff).toContain("+const x = newName;");
    await expect(
      test.files.validatePendingWrite({
        principal,
        sessionId: "session",
        turnId: "turn",
        toolName: "find_and_replace",
        input: reviewed.preparedInput,
        displayContent: display,
      }),
    ).resolves.toEqual({ ok: true });

    // Execution refuses an unpinned call and a baseline that drifted.
    await expect(tool.execute(input, context())).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({
        error: "expected_content_hashes_required",
      }),
    });
    const written = await tool.execute(
      { ...reviewed.preparedInput },
      context(),
    );
    expect(written.isError).not.toBe(true);
    expect(JSON.parse(String(written.modelContent))).toMatchObject({
      status: "applied",
      find: "old(\\w+)",
      replace: "new$1",
      files_changed: 2,
      total_replacements: 3,
      files: [
        {
          path: "src/a.ts",
          changes: 2,
          post_edit_content_hash: hash("const x = newName;\nnewName();\n"),
        },
        { path: "src/nested/b.ts", changes: 1 },
      ],
    });
    await expect(
      fs.readFile(path.join(test.root, "top.ts"), "utf8"),
    ).resolves.toBe("oldName();\n");
    await expect(
      fs.readFile(path.join(test.root, "node_modules", "dep", "d.ts"), "utf8"),
    ).resolves.toBe("oldName\n");

    await fs.writeFile(path.join(test.root, "top.ts"), "oldName();\n");
    const single = await authorize("single", {
      find: "oldName",
      replace: "x",
      path: "top.ts",
    });
    if (single.decision !== "require_user" || !single.preparedInput) {
      throw new Error("Expected a pinned review");
    }
    await fs.writeFile(path.join(test.root, "top.ts"), "oldName(); oldName\n");
    await expect(
      test
        .tool("find_and_replace")
        .execute({ ...single.preparedInput }, context()),
    ).resolves.toMatchObject({
      modelContent: expect.stringContaining('"status":"stale_proposal"'),
    });
    await expect(
      fs.readFile(path.join(test.root, "top.ts"), "utf8"),
    ).resolves.toBe("oldName(); oldName\n");

    // Nothing to write skips review and returns VS Code's payloads.
    const none = await authorize("none", {
      find: "absent",
      replace: "x",
      glob: "**/*.ts",
    });
    expect(none).toMatchObject({ decision: "allow" });
    if (none.decision !== "allow" || !none.preparedInput) {
      throw new Error("Expected an allowed no-op");
    }
    await expect(
      tool.execute({ ...none.preparedInput }, context()),
    ).resolves.toMatchObject({
      modelContent: JSON.stringify({
        status: "no_matches",
        find: "absent",
        files_searched: 3,
      }),
    });
    await expect(
      tool.execute(
        {
          find: "oldName",
          replace: "x",
          glob: "**/*.ts",
          max_replacements: 1,
          expectedContentHashes: {},
        },
        context(),
      ),
    ).resolves.toMatchObject({
      modelContent: expect.stringContaining('"status":"too_many_matches"'),
    });
    await expect(
      tool.execute({ find: "x", replace: "y", glob: "*.nope" }, context()),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: JSON.stringify({
        error: "No files matched glob pattern: *.nope",
      }),
    });

    await fs.writeFile(path.join(test.root, "AGENTS.md"), "oldName\n");
    await expect(
      authorize("protected", { find: "oldName", replace: "x", glob: "*.md" }),
    ).resolves.toMatchObject({
      decision: "require_user",
      displayContent: { protected: true, protectionReason: "instruction_file" },
    });
  });

  it("limits session grants to one tool and a verified content-hash chain", async () => {
    const test = await fixture();
    const filePath = path.join(test.root, "granted.txt");
    await fs.writeFile(filePath, "before\n");
    const initialInput = {
      path: "granted.txt",
      content: "after\n",
      expectedContentHash: hash("before\n"),
    };
    const initial = await test.files.authorizeToolCall({
      principal,
      sessionId: "session",
      turnId: "turn",
      model,
      toolCallId: "initial",
      toolName: "write_file",
      input: initialInput,
      effect: "write",
    });
    expect(initial.decision).toBe("require_user");
    if (initial.decision !== "require_user") throw new Error("Expected review");
    const proposal = initial.displayContent as WorkspaceFileApprovalDisplay;
    expect(proposal.toolName).toBe("write_file");
    await test.tool("write_file").execute(initialInput, context());
    test.sessionGrants.set(JSON.stringify([proposal.toolName, proposal.path]), {
      contentHash: proposal.proposedContentHash,
      scopeDigest: proposal.scopeDigest,
      policyRevision: proposal.policyRevision,
    });

    const chainedInput = {
      path: "granted.txt",
      content: "next\n",
      expectedContentHash: hash("after\n"),
    };
    await expect(
      test.files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "chained",
        toolName: "write_file",
        input: chainedInput,
        effect: "write",
      }),
    ).resolves.toEqual({ decision: "allow" });
    await expect(
      test.files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "different-tool",
        toolName: "apply_diff",
        input: {
          path: "granted.txt",
          expectedContentHash: hash("after\n"),
          diff: [
            "<<<<<<< SEARCH",
            "after",
            "======= DIVIDER =======",
            "patched",
            ">>>>>>> REPLACE",
          ].join("\n"),
        },
        effect: "write",
      }),
    ).resolves.toMatchObject({ decision: "require_user" });

    await fs.writeFile(filePath, "external\n");
    await expect(
      test.files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "external-baseline",
        toolName: "write_file",
        input: {
          path: "granted.txt",
          content: "unreviewed\n",
          expectedContentHash: hash("external\n"),
        },
        effect: "write",
      }),
    ).resolves.toMatchObject({ decision: "require_user" });
  });

  it("enforces exact read and write scopes, including absent files", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-"),
    );
    await fs.writeFile(path.join(root, "read.txt"), "readable\n");
    await fs.writeFile(path.join(root, "write.txt"), "before\n");
    const files = createWorkspaceFileTools({
      projectRoot: root,
      resolveScopes: () => [
        { path: "read.txt", kind: "file", access: "read" },
        { path: "write.txt", kind: "file", access: "write" },
        { path: "new.txt", kind: "file", access: "write" },
      ],
    });
    const tools = await files.resolveTools(discovery);
    const tool = (name: string) => {
      const found = tools.find(
        (candidate) => candidate.definition.name === name,
      );
      if (!found) throw new Error(`Missing tool ${name}`);
      return found;
    };

    await expect(
      tool("read_file").execute({ path: "read.txt" }, context()),
    ).resolves.not.toHaveProperty("isError");
    for (const denied of ["write.txt", "other.txt"]) {
      await expect(
        tool("read_file").execute({ path: denied }, context()),
      ).resolves.toMatchObject({ isError: true });
    }
    await expect(
      files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "denied",
        toolName: "write_file",
        input: {
          path: "read.txt",
          content: "changed\n",
          expectedContentHash: hash("readable\n"),
        },
        effect: "write",
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "new",
        toolName: "write_file",
        input: { path: "new.txt", content: "new\n", expectedAbsent: true },
        effect: "write",
      }),
    ).resolves.toMatchObject({ decision: "require_user" });
  });

  it("keeps the complete resulting diff in the approval record", async () => {
    const test = await fixture();
    const before = Array.from(
      { length: 260 },
      (_, index) => `old-${index}`,
    ).join("\n");
    const after = Array.from(
      { length: 260 },
      (_, index) => `new-${index}`,
    ).join("\n");
    await fs.writeFile(path.join(test.root, "large.txt"), before);
    const approval = await test.files.authorizeToolCall({
      principal,
      sessionId: "session",
      turnId: "turn",
      model,
      toolCallId: "large",
      toolName: "write_file",
      input: {
        path: "large.txt",
        content: after,
        expectedContentHash: hash(before),
      },
      effect: "write",
    });
    expect(approval.decision).toBe("require_user");
    if (approval.decision === "require_user") {
      const display = approval.displayContent as WorkspaceFileApprovalDisplay;
      expect(display.diff).toContain("-old-259");
      expect(display.diff).toContain("+new-259");
      expect(display.diff).not.toContain("diff truncated");
    }
  });

  it("rejects path escapes, symlink aliases, and hard-linked write targets", async () => {
    const test = await fixture();
    const outside = path.join(path.dirname(test.root), "outside.txt");
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, path.join(test.root, "alias.txt"));
    await fs.link(outside, path.join(test.root, "linked.txt"));
    await fs.writeFile(path.join(test.root, "inside.txt"), "inside\n");
    await fs.symlink(
      path.join(test.root, "inside.txt"),
      path.join(test.root, "inside-alias.txt"),
    );

    for (const requested of [
      "../outside.txt",
      "alias.txt",
      "inside-alias.txt",
    ]) {
      const result = await test
        .tool("read_file")
        .execute({ path: requested }, context());
      expect(result.isError).toBe(true);
    }
    const linkedContext = await test
      .tool("read_file")
      .execute({ path: "linked.txt", view: "context" }, context());
    expect(linkedContext.isError).toBe(true);
    expect(String(linkedContext.modelContent)).toContain(
      "not_a_private_regular_file",
    );
    const linked = await test.tool("write_file").execute(
      {
        path: "linked.txt",
        content: "changed\n",
        expectedContentHash: hash("outside\n"),
      },
      context(),
    );
    expect(linked.isError).toBe(true);
    expect(String(linked.modelContent)).toContain("not_a_private_regular_file");
  });

  it("delegates file access, search and git status to an injected execution backend", async () => {
    const realRoot = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-backend-"),
    );
    // Exists only inside the backend; any direct host I/O would fail.
    const projectRoot = "/agentlink-virtual-backend/project";
    const ripgrep = "/backend/bin/rg";
    try {
      await fs.writeFile(path.join(realRoot, "notes.txt"), "alpha\nbeta\n");
      const launches: WorkspaceProcessLaunchRequest[] = [];
      const executionBackend: WorkspaceExecutionBackend = {
        fileSystem: mappedFileSystem(projectRoot, realRoot, [
          ripgrep,
          "/usr/bin/git",
        ]),
        launchProcess(launch) {
          launches.push(launch.request);
          const exited = new Promise<{ exitCode: number }>((resolve) => {
            setTimeout(() => {
              launch.onOutput(
                "stdout",
                Buffer.from(
                  launch.request.executable === ripgrep
                    ? [
                        {
                          type: "begin",
                          data: { path: { text: `${projectRoot}/notes.txt` } },
                        },
                        {
                          type: "match",
                          data: {
                            path: { text: `${projectRoot}/notes.txt` },
                            line_number: 2,
                            lines: { text: "beta\n" },
                          },
                        },
                        {
                          type: "end",
                          data: { path: { text: `${projectRoot}/notes.txt` } },
                        },
                      ]
                        .map((event) => `${JSON.stringify(event)}\n`)
                        .join("")
                    : " M notes.txt\n",
                ),
              );
              resolve({ exitCode: 0 });
            }, 0);
          });
          return {
            pid: 7,
            started: Promise.resolve(),
            exited,
            signal: () => true,
          };
        },
      };
      const files = createWorkspaceFileTools({
        projectRoot,
        ripgrepExecutable: ripgrep,
        executionBackend,
        processOwnerId: "workspace:backend-test",
      });
      const tools = await files.resolveTools(discovery);
      const tool = (name: string) =>
        tools.find((candidate) => candidate.definition.name === name)!;

      const contextResult = await tool("read_file").execute(
        { path: "notes.txt", view: "context" },
        context(),
      );
      expect(JSON.parse(String(contextResult.modelContent))).toMatchObject({
        path: "notes.txt",
        content: "1 | alpha\n2 | beta\n3 | ",
        git_status: "modified",
        working_set: { content_hash: hash("alpha\nbeta\n") },
      });

      const search = await tool("search_files").execute(
        { path: ".", regex: "beta" },
        context(),
      );
      expect(JSON.parse(String(search.modelContent))).toEqual({
        total_matches: 1,
        truncated: false,
        results: "## notes.txt (1 match)\n> 2 | beta\n---",
      });

      const authorization = await files.authorizeToolCall({
        principal,
        sessionId: "session",
        turnId: "turn",
        model,
        toolCallId: "call",
        toolName: "write_file",
        input: {
          path: "nested/new.txt",
          content: "created\n",
          expectedAbsent: true,
        },
        effect: "write",
      });
      expect(authorization).toMatchObject({ decision: "require_user" });
      const created = await tool("write_file").execute(
        { path: "nested/new.txt", content: "created\n", expectedAbsent: true },
        context(),
      );
      expect(created.isError).toBeFalsy();
      await expect(
        fs.readFile(path.join(realRoot, "nested", "new.txt"), "utf8"),
      ).resolves.toBe("created\n");
      const stale = await tool("write_file").execute(
        {
          path: "notes.txt",
          content: "changed\n",
          expectedContentHash: hash("stale"),
        },
        context(),
      );
      expect(String(stale.modelContent)).toContain("content_hash_mismatch");

      const identity = {
        ownerId: "workspace:backend-test",
        sessionId: "session",
        turnId: "turn",
        cwd: projectRoot,
      };
      expect(launches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...identity,
            executable: "/usr/bin/git",
            environment: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0" },
          }),
          expect.objectContaining({
            ...identity,
            executable: ripgrep,
            environment: { PATH: "/usr/bin:/bin" },
            args: expect.arrayContaining(["--", projectRoot]),
          }),
        ]),
      );
      expect(launches).toHaveLength(2);
    } finally {
      await fs.rm(realRoot, { recursive: true, force: true });
    }
  });
});

/** Maps a virtual project root onto a real directory, like a remote backend. */
function mappedFileSystem(
  virtualRoot: string,
  realRoot: string,
  executables: readonly string[],
): WorkspaceExecutionBackend["fileSystem"] {
  const local = createNodeHostLocalFileSystem();
  const toReal = (target: string): string => {
    if (target === virtualRoot) return realRoot;
    if (target.startsWith(`${virtualRoot}/`)) {
      return path.join(realRoot, target.slice(virtualRoot.length + 1));
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const toVirtual = (target: string): string =>
    target === realRoot
      ? virtualRoot
      : target.startsWith(`${realRoot}/`)
        ? path.join(virtualRoot, target.slice(realRoot.length + 1))
        : target;
  return {
    realpath: async (target) => toVirtual(await local.realpath(toReal(target))),
    stat: async (target) => await local.stat(toReal(target)),
    lstat: async (target) => await local.lstat(toReal(target)),
    readFile: async (target) => await local.readFile(toReal(target)),
    readDirectory: async (target) => await local.readDirectory(toReal(target)),
    mkdir: async (target, options) =>
      await local.mkdir(toReal(target), options),
    createFile: async (target, content, options) =>
      await local.createFile(toReal(target), content, options),
    link: async (from, to) => await local.link(toReal(from), toReal(to)),
    rename: async (from, to) => await local.rename(toReal(from), toReal(to)),
    unlink: async (target) => await local.unlink(toReal(target)),
    chmod: async (target, mode) => await local.chmod(toReal(target), mode),
    syncDirectory: async (target) => await local.syncDirectory(toReal(target)),
    canExecute: async (target) => executables.includes(target),
  };
}
