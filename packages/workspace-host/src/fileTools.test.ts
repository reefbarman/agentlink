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
        .execute({ path: "visible.txt", limit: 201 }, context()),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining("content_limit_exceeds_200"),
    });
    await expect(
      test
        .tool("read_file")
        .execute({ path: "visible.txt", include_symbols: false }, context()),
    ).resolves.toMatchObject({
      isError: true,
      modelContent: expect.stringContaining(
        "context_options_require_context_view",
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

    const search = await test
      .tool("search_files")
      .execute({ path: ".", regex: "secret|hello", maxResults: 1 }, context());
    expect(JSON.parse(String(search.modelContent)).matches).toEqual([
      expect.objectContaining({ path: "visible.txt", line: 1 }),
    ]);
    const listed = await test
      .tool("list_files")
      .execute({ path: "." }, context());
    expect(JSON.parse(String(listed.modelContent)).entries).toEqual([
      "settings.json",
      "visible.txt",
    ]);
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

  it("uses fixed packaged ripgrep arguments and filters protected bounded results", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "workspace-files-ripgrep-"),
    );
    try {
      const executable = path.join(root, "fake-rg.mjs");
      const argumentsPath = path.join(root, "ripgrep-arguments.json");
      await fs.writeFile(
        executable,
        `#!${process.execPath}\n` +
          `import { writeFileSync } from "node:fs";\n` +
          `writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));\n` +
          `for (const match of [\n` +
          `  { path: ".env", line: 1, text: "TOKEN=secret\\n" },\n` +
          `  { path: "visible.txt", line: 2, text: "Needle\\n" },\n` +
          `  { path: "other.txt", line: 3, text: "Needle again\\n" },\n` +
          `]) process.stdout.write(JSON.stringify({ type: "match", data: { path: { text: match.path }, line_number: match.line, lines: { text: match.text } } }) + "\\n");\n`,
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

      const result = await search.execute(
        { path: ".", regex: "needle", maxResults: 1 },
        context(),
      );
      expect(JSON.parse(String(result.modelContent))).toEqual({
        path: ".",
        matches: [{ path: "visible.txt", line: 2, text: "Needle" }],
        count: 1,
        truncated: true,
      });
      expect(JSON.parse(await fs.readFile(argumentsPath, "utf8"))).toEqual([
        "--json",
        "--ignore-case",
        "--no-config",
        "--max-filesize",
        "1000K",
        "--glob",
        "!.git/**",
        "--glob",
        "!node_modules/**",
        "--regexp",
        "needle",
        "--",
        root,
      ]);

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
                    ? `${JSON.stringify({
                        type: "match",
                        data: {
                          path: { text: `${projectRoot}/notes.txt` },
                          line_number: 2,
                          lines: { text: "beta\n" },
                        },
                      })}\n`
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
      expect(JSON.parse(String(search.modelContent))).toMatchObject({
        matches: [{ path: "notes.txt", line: 2, text: "beta" }],
        count: 1,
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
