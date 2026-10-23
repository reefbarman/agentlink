import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  ASK_AGENT_SANDBOX_TOOLS,
  AskAgentSandboxWorkspace,
  askAgentCommandFoldersPrompt,
  findNestedRepository,
  type AskAgentCommandApprovalDecision,
  type AskAgentCommandApprovalProposal,
} from "./askAgentSandboxWorkspace.js";
import { afterEach, describe, expect, it, vi } from "vitest";

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
async function localWorkspace(
  rootDirectory: string,
  hostEnvironment?: () => NodeJS.ProcessEnv,
) {
  const host = await import("@agentlink/workspace-host");
  const launches: Array<{
    workDirectory: string;
    denied: readonly string[];
    grantedRoot?: string;
  }> = [];
  const workspace = new AskAgentSandboxWorkspace({
    rootDirectory,
    extensionRoot: rootDirectory,
    platform: "darwin",
    homeDirectory: "/Users/example",
    ...(hostEnvironment ? { hostEnvironment } : {}),
    createProcessLauncher: ({
      workDirectory,
      deniedReadRoots,
      grantedRoot,
    }) => {
      launches.push({
        workDirectory,
        denied: deniedReadRoots,
        ...(grantedRoot ? { grantedRoot } : {}),
      });
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
      const trusted: Array<readonly string[]> = [];
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
        createProcessLauncher: ({ deniedReadRoots, trustedRuntimeRoots }) => {
          launches.push(deniedReadRoots);
          trusted.push(trustedRuntimeRoots);
          return host.createLocalWorkspaceExecutionBackend();
        },
      });
      cleanups.push(() => workspace.dispose());
      return { workspace, checks, launches, trusted, root };
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
      // Only apply-seccomp's directory stays readable, so a runtime under
      // /home (an extracted AppImage) still works.
      expect(test.trusted).toEqual([
        [
          path.join(
            test.root,
            "dist",
            "sandbox-runtime",
            "vendor",
            "seccomp",
            process.arch,
          ),
        ],
      ]);
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

  describe("in folders granted for commands", () => {
    function approver(decision: AskAgentCommandApprovalDecision) {
      return vi.fn(
        async (
          _proposal: AskAgentCommandApprovalProposal,
        ): Promise<AskAgentCommandApprovalDecision> => decision,
      );
    }

    it("runs a command there only after the user approves it", async () => {
      const root = await temporaryDirectory("al-ask-sbx-");
      const project = await temporaryDirectory("al-ask-project-");
      await fs.mkdir(path.join(project, "src"));
      const { workspace, launches } = await localWorkspace(root, () => ({
        PATH: process.env.PATH,
        CUSTOM_VAR: "kept",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: "/helper/node_modules",
        AGENTLINK_BROWSER_GATEWAY_STANDALONE_MCP: "1",
      }));
      const requestApproval = approver({ decision: "run" });

      const ran = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: {
          command:
            'printf "%s|%s|%s|%s" "$CUSTOM_VAR" "$ELECTRON_RUN_AS_NODE" "$NODE_PATH" "$PWD" > out.txt',
          cwd: path.join(project, "src"),
        },
        commandRoots: [project],
        requestApproval,
      });

      expect(ran.isError).toBe(false);
      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(requestApproval.mock.calls[0]![0]).toMatchObject({
        cwd: path.join(project, "src"),
        root: project,
      });
      // Helper-only variables never reach the command.
      expect(
        await fs.readFile(path.join(project, "src", "out.txt"), "utf8"),
      ).toBe(`kept|||${path.join(project, "src")}`);
      expect(launches).toContainEqual({
        workDirectory: project,
        denied: [],
        grantedRoot: project,
      });

      // get_command_output finds granted-folder commands too.
      const commandId = (parse(ran.content).record as { commandId: string })
        .commandId;
      const observed = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-2",
        toolName: "get_command_output",
        input: { commandId },
      });
      expect(observed.isError).toBe(false);
    });

    it("does not run a declined command and runs an edited one as written", async () => {
      const root = await temporaryDirectory("al-ask-sbx-");
      const project = await temporaryDirectory("al-ask-project-");
      const { workspace } = await localWorkspace(root);

      const declined = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "touch declined.txt", cwd: project },
        commandRoots: [project],
        requestApproval: approver({ decision: "reject", reason: "not now" }),
      });
      expect(declined.isError).toBe(true);
      expect(parse(declined.content)).toMatchObject({
        status: "rejected_by_user",
        reason: "not now",
      });
      await expect(
        fs.stat(path.join(project, "declined.txt")),
      ).rejects.toThrow();

      const edited = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-2",
        toolName: "execute_command",
        input: { command: "touch original.txt", cwd: project },
        commandRoots: [project],
        requestApproval: approver({
          decision: "edit",
          command: "touch edited.txt",
        }),
      });
      expect(edited.isError).toBe(false);
      await expect(
        fs.stat(path.join(project, "edited.txt")),
      ).resolves.toBeTruthy();
      await expect(
        fs.stat(path.join(project, "original.txt")),
      ).rejects.toThrow();
    });

    it("refuses folders that are not granted, and asks even without a rule", async () => {
      const root = await temporaryDirectory("al-ask-sbx-");
      const project = await temporaryDirectory("al-ask-project-");
      const other = await temporaryDirectory("al-ask-other-");
      const { workspace } = await localWorkspace(root);

      const outside = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "touch x", cwd: other },
        commandRoots: [project],
        requestApproval: approver({ decision: "run" }),
      });
      expect(outside.isError).toBe(true);
      expect(outside.content).toContain("cwd_not_granted");

      // Without an approval channel a granted-folder command cannot run.
      const unattended = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "touch x", cwd: project },
        commandRoots: [project],
      });
      expect(unattended.isError).toBe(true);
      expect(unattended.content).toContain("command_requires_approval");
      await expect(fs.stat(path.join(project, "x"))).rejects.toThrow();
    });

    it("stops running commands and refuses new ones when the grant is revoked", async () => {
      const root = await temporaryDirectory("al-ask-sbx-");
      const project = await temporaryDirectory("al-ask-project-");
      const { workspace } = await localWorkspace(root);

      const running = workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "touch started && sleep 30", cwd: project },
        commandRoots: [project],
        requestApproval: approver({ decision: "run" }),
      });
      await vi.waitFor(() => fs.stat(path.join(project, "started")), {
        timeout: 10_000,
        interval: 50,
      });
      await workspace.revokeCommandRoot(project);
      const stopped = await running;
      expect(parse(stopped.content).record).toMatchObject({
        state: "cancelled",
      });

      // A stale caller that still lists the root cannot launch there.
      const requestApproval = approver({ decision: "run" });
      const later = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-2",
        toolName: "execute_command",
        input: { command: "touch later", cwd: project },
        commandRoots: [],
        requestApproval,
      });
      expect(later.isError).toBe(true);
      expect(requestApproval).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(project, "later"))).rejects.toThrow();
    }, 20_000);

    it("refuses a command whose grant is revoked while it waits for approval", async () => {
      const root = await temporaryDirectory("al-ask-sbx-");
      const project = await temporaryDirectory("al-ask-project-");
      const { workspace } = await localWorkspace(root);
      let granted = true;

      // The caller listed the folder before the user revoked it on the card.
      const result = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "touch stale", cwd: project },
        commandRoots: [project],
        requestApproval: async () => {
          granted = false;
          await workspace.revokeCommandRoot(project);
          return { decision: "run" };
        },
        isCommandRootGranted: async () => granted,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("cwd_not_granted");
      await expect(fs.stat(path.join(project, "stale"))).rejects.toThrow();

      // The same holds when only the revocation itself is known.
      const late = await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-2",
        toolName: "execute_command",
        input: { command: "touch late", cwd: project },
        commandRoots: [project],
        requestApproval: async () => {
          await workspace.revokeCommandRoot(project);
          return { decision: "run" };
        },
      });
      expect(late.isError).toBe(true);
      await expect(fs.stat(path.join(project, "late"))).rejects.toThrow();
    });

    it("reports the macOS sandbox's local-only network on the approval", async () => {
      const root = await temporaryDirectory("al-ask-sbx-");
      const project = await temporaryDirectory("al-ask-project-");
      const { workspace } = await localWorkspace(root);
      const requestApproval = approver({ decision: "reject" });
      await workspace.execute({
        sessionId: "chat-1",
        turnId: "turn-1",
        toolName: "execute_command",
        input: { command: "true", cwd: project },
        commandRoots: [project],
        requestApproval,
      });
      expect(requestApproval.mock.calls[0]![0].network).toBe("loopback");
    });

    it("finds repositories nested in a folder", async () => {
      const project = await temporaryDirectory("al-ask-project-");
      await fs.mkdir(path.join(project, ".git"));
      await fs.mkdir(path.join(project, "node_modules", "dep", ".git"), {
        recursive: true,
      });
      expect(await findNestedRepository(project)).toBeUndefined();
      await fs.mkdir(path.join(project, "packages", "inner", ".git"), {
        recursive: true,
      });
      expect(await findNestedRepository(project)).toBe(
        path.join(project, "packages", "inner", ".git"),
      );
    });

    it("lists granted folders in the prompt only when there are some", () => {
      expect(askAgentCommandFoldersPrompt([])).toBeUndefined();
      expect(askAgentCommandFoldersPrompt(["/work/app"])).toContain(
        "- /work/app",
      );
    });
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
