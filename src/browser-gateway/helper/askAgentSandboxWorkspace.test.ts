import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  ASK_AGENT_SANDBOX_TOOLS,
  AskAgentSandboxWorkspace,
} from "./askAgentSandboxWorkspace.js";
import { afterEach, describe, expect, it } from "vitest";

import { pathToFileURL } from "node:url";

// Vitest runs from the repository root.
const REPO_ROOT = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Runs commands unsandboxed so the composition is testable everywhere. */
async function localWorkspace(rootDirectory: string) {
  const host = await import("@agentlink/workspace-host");
  const launches: Array<{ workDirectory: string; denied: readonly string[] }> =
    [];
  const workspace = new AskAgentSandboxWorkspace({
    rootDirectory,
    extensionRoot: rootDirectory,
    platform: "darwin",
    homeDirectory: "/Users/example",
    createProcessLauncher: ({ workDirectory, deniedReadRoots }) => {
      launches.push({ workDirectory, denied: deniedReadRoots });
      return host.createLocalWorkspaceExecutionBackend();
    },
  });
  cleanups.push(() => workspace.dispose());
  return { workspace, launches };
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

describe("AskAgentSandboxWorkspace", () => {
  it("advertises execute_command, get_command_output, write_file and present_files", () => {
    expect(ASK_AGENT_SANDBOX_TOOLS.map((tool) => tool.name)).toEqual([
      "execute_command",
      "get_command_output",
      "write_file",
      "present_files",
    ]);
    const execute = ASK_AGENT_SANDBOX_TOOLS[0]!;
    expect(
      Object.keys(
        (execute.input_schema as { properties: Record<string, unknown> })
          .properties,
      ),
    ).not.toContain("background");
  });

  it("is unavailable on other hosts and without a staged helper", async () => {
    const root = await temporaryDirectory("al-ask-sbx-");
    for (const platform of ["win32", "linux", "darwin"] as const) {
      await expect(
        new AskAgentSandboxWorkspace({
          rootDirectory: root,
          extensionRoot: root,
          platform,
        }).isAvailable(),
      ).resolves.toBe(false);
    }
  });

  describe("on Linux", () => {
    const passing = (ripgrep: string) => ({
      available: true,
      checks: [
        { id: "platform" as const, status: "pass" as const, detail: "Linux" },
        { id: "ripgrep" as const, status: "pass" as const, detail: ripgrep },
      ],
    });

    async function linuxWorkspace(
      result: Awaited<
        ReturnType<
          NonNullable<
            ConstructorParameters<
              typeof AskAgentSandboxWorkspace
            >[0]["checkLinuxPrerequisites"]
          >
        >
      >,
      ripgrepPath?: string,
    ) {
      const root = await temporaryDirectory("al-ask-sbx-");
      const host = await import("@agentlink/workspace-host");
      const checks: unknown[] = [];
      const launches: Array<readonly string[]> = [];
      const workspace = new AskAgentSandboxWorkspace({
        rootDirectory: root,
        extensionRoot: root,
        platform: "linux",
        homeDirectory: "/home/example",
        ...(ripgrepPath ? { ripgrepPath } : {}),
        checkLinuxPrerequisites: async (options) => {
          checks.push(options);
          return result;
        },
        createProcessLauncher: ({ deniedReadRoots }) => {
          launches.push(deniedReadRoots);
          return host.createLocalWorkspaceExecutionBackend();
        },
      });
      cleanups.push(() => workspace.dispose());
      return { workspace, checks, launches, root };
    }

    it("is available only when the bubblewrap check passes, checking once", async () => {
      const ok = await linuxWorkspace(passing("/opt/rg"), "/opt/rg");
      await expect(ok.workspace.isAvailable()).resolves.toBe(true);
      await expect(ok.workspace.isAvailable()).resolves.toBe(true);
      expect(ok.checks).toEqual([
        {
          runtimeRoot: path.join(ok.root, "dist", "sandbox-runtime"),
          ripgrepPath: "/opt/rg",
        },
      ]);

      const missing = await linuxWorkspace({
        available: false,
        checks: [
          {
            id: "namespaces",
            status: "fail",
            detail: "AppArmor restricts unprivileged user namespaces.",
          },
        ],
      });
      await expect(missing.workspace.isAvailable()).resolves.toBe(false);
      await expect(
        missing.workspace.execute({
          sessionId: "chat-a",
          turnId: "turn-1",
          toolName: "execute_command",
          input: { command: "true" },
        }),
      ).resolves.toMatchObject({ isError: true });
    });

    it("hides /home and the user's home from commands", async () => {
      const test = await linuxWorkspace(passing("/usr/bin/rg"));
      await test.workspace.execute({
        sessionId: "chat-a",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "true" },
      });
      expect(test.launches).toEqual([["/home/example", "/home"]]);
    });
  });

  it("writes, runs and presents files inside one chat's work folder", async () => {
    const root = await temporaryDirectory("al-ask-sbx-");
    const { workspace, launches } = await localWorkspace(root);

    const written = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-1",
      toolName: "write_file",
      input: { path: "data/numbers.csv", content: "month,total\njan,3\n" },
    });
    expect(written.isError).toBe(false);
    expect(parse(written.content)).toMatchObject({
      ok: true,
      path: path.join("data", "numbers.csv"),
    });

    const ran = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-1",
      toolName: "execute_command",
      input: {
        command: "wc -l < data/numbers.csv && printf report > report.md && pwd",
      },
    });
    expect(ran.isError).toBe(false);
    const work = await fs.realpath(workspace.workDirectory("chat-1"));
    expect(ran.content).toContain(work);
    expect(launches).toEqual([
      { workDirectory: work, denied: ["/Users/example", "/Users"] },
    ]);

    const commandId = (parse(ran.content).record as { commandId: string })
      .commandId;
    const observed = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-2",
      toolName: "get_command_output",
      input: { commandId },
    });
    expect(observed.isError).toBe(false);

    await fs.writeFile(
      path.join(work, "chart.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const presented = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-2",
      toolName: "present_files",
      input: { paths: ["chart.png", "report.md"] },
    });
    expect(presented.isError).toBe(false);
    expect(presented.resultImages).toEqual([
      { mimeType: "image/png", data: "iVBORw==" },
    ]);
    expect(presented.resultDocuments).toEqual([
      {
        name: "report.md",
        mimeType: "text/markdown",
        data: Buffer.from("report").toString("base64"),
      },
    ]);
  });

  it("refuses writes and presented files outside the work folder", async () => {
    const root = await temporaryDirectory("al-ask-sbx-");
    const outside = await temporaryDirectory("al-ask-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    const { workspace } = await localWorkspace(root);

    const escaped = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-1",
      toolName: "write_file",
      input: { path: "../escape.txt", content: "x" },
    });
    expect(escaped.isError).toBe(true);
    expect(escaped.content).toContain("outside_scratch_folder");

    const work = await fs.realpath(workspace.workDirectory("chat-1"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(work, "link"));
    const linked = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-1",
      toolName: "present_files",
      input: { paths: ["link"] },
    });
    expect(linked.isError).toBe(true);
    const overwrite = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-1",
      toolName: "write_file",
      input: { path: "link", content: "clobber" },
    });
    expect(overwrite.isError).toBe(true);
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
      "secret",
    );

    const background = await workspace.execute({
      sessionId: "chat-1",
      turnId: "turn-1",
      toolName: "execute_command",
      input: { command: "sleep 1", background: true },
    });
    expect(background.isError).toBe(true);
  });

  it("keeps chats apart, copies attachments to inputs/ and deletes a chat", async () => {
    const root = await temporaryDirectory("al-ask-sbx-");
    const { workspace } = await localWorkspace(root);
    await workspace.syncInputs("chat-a", [
      { name: "../sales.csv", base64: Buffer.from("a,b").toString("base64") },
    ]);
    await workspace.syncInputs("chat-a", [
      { name: "sales.csv", base64: Buffer.from("changed").toString("base64") },
    ]);
    const workA = await fs.realpath(workspace.workDirectory("chat-a"));
    expect(
      await fs.readFile(path.join(workA, "inputs", "sales.csv"), "utf8"),
    ).toBe("a,b");
    expect(workspace.workDirectory("chat-b")).not.toBe(workA);
    expect(workspace.chatDirectory("../escape")).toMatch(
      new RegExp(`^${root}/[a-f0-9]{32}$`),
    );

    await workspace.execute({
      sessionId: "chat-a",
      turnId: "turn-1",
      toolName: "execute_command",
      input: { command: "true" },
    });
    await workspace.deleteChat("chat-a");
    await expect(fs.stat(workspace.chatDirectory("chat-a"))).rejects.toThrow();
  });

  it.runIf(
    process.platform === "darwin" &&
      process.env.AGENTLINK_RUN_PRODUCTION_SANDBOX_ATTESTATION === "1",
  )(
    "confines commands to the chat folder through the production sandbox",
    async () => {
      const extensionRoot = await temporaryDirectory("al-ask-runtime-");
      const { stageSandboxRuntime } = (await import(
        pathToFileURL(
          path.join(REPO_ROOT, "scripts", "package-sandbox-runtime.mjs"),
        ).href
      )) as {
        stageSandboxRuntime(options: Record<string, unknown>): Promise<unknown>;
      };
      await stageSandboxRuntime({
        repoRoot: REPO_ROOT,
        destinationRoot: path.join(extensionRoot, "dist", "sandbox-runtime"),
        target: `darwin-${process.arch}`,
        includeNodePty: false,
      });
      const home = await temporaryDirectory("al-ask-home-");
      const root = path.join(home, ".agentlink", "ask-agent-sandboxes");
      await fs.writeFile(path.join(home, "secret.txt"), "home-secret");
      const workspace = new AskAgentSandboxWorkspace({
        rootDirectory: root,
        extensionRoot,
        homeDirectory: home,
      });
      cleanups.push(() => workspace.dispose());
      await expect(workspace.isAvailable()).resolves.toBe(true);

      await workspace.execute({
        sessionId: "chat-b",
        turnId: "turn-1",
        toolName: "write_file",
        input: { path: "private.txt", content: "other-chat" },
      });
      const result = await workspace.execute({
        sessionId: "chat-a",
        turnId: "turn-1",
        toolName: "execute_command",
        input: {
          command: [
            "printf ok > made.txt",
            `cat ${JSON.stringify(path.join(home, "secret.txt"))} || echo home-denied`,
            `cat ${JSON.stringify(path.join(workspace.workDirectory("chat-b"), "private.txt"))} || echo chat-denied`,
            `printf x > ${JSON.stringify(path.join(home, "escaped.txt"))} || echo write-denied`,
          ].join("; "),
        },
      });
      expect(result.content).toContain("home-denied");
      expect(result.content).toContain("chat-denied");
      expect(result.content).toContain("write-denied");
      expect(result.content).not.toContain("home-secret");
      expect(result.content).not.toContain("other-chat");
      expect(
        await fs.readFile(
          path.join(workspace.workDirectory("chat-a"), "made.txt"),
          "utf8",
        ),
      ).toBe("ok");
      await expect(fs.stat(path.join(home, "escaped.txt"))).rejects.toThrow();
    },
    60_000,
  );
});
