import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener<T> = (value: T) => void;

class MockEventEmitter<T> {
  private listeners = new Set<Listener<T>>();

  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const configurationValues = new Map<string, Record<string, unknown>>();
const mockWorkspace = {
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  createFileSystemWatcher: vi.fn(() => ({
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  getConfiguration: vi.fn(
    (_section: string, resource?: { fsPath?: string }) => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        const values = resource?.fsPath
          ? configurationValues.get(resource.fsPath)
          : undefined;
        return values && key in values ? values[key] : fallback;
      }),
    }),
  ),
};

vi.mock("vscode", () => ({
  EventEmitter: MockEventEmitter,
  workspace: mockWorkspace,
  window: {
    createOutputChannel: vi.fn(() => ({
      info: vi.fn(),
      dispose: vi.fn(),
    })),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showTextDocument: vi.fn(() => Promise.resolve(undefined)),
  },
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      toString: () => `file://${fsPath}`,
    }),
    parse: (value: string) => ({
      fsPath: value.replace(/^file:\/\//, ""),
      toString: () => value,
    }),
  },
}));

class MockMemento {
  private store = new Map<string, unknown>();
  private pending: Promise<void> = Promise.resolve();
  private writeGate: Promise<void> | null = null;
  private releaseWriteGate: (() => void) | null = null;
  private rejectedUpdateKeys = new Set<string>();

  keys(): readonly string[] {
    return Array.from(this.store.keys());
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
  }

  update(key: string, value: unknown): Promise<void> {
    const snapshot = value === undefined ? undefined : structuredClone(value);
    const write = this.pending.then(async () => {
      await this.writeGate;
      if (this.rejectedUpdateKeys.delete(key)) {
        throw new Error(`Rejected update for ${key}`);
      }
      if (snapshot === undefined) {
        this.store.delete(key);
        return;
      }
      this.store.set(key, snapshot);
    });
    this.pending = write.catch(() => undefined);
    return write;
  }

  rejectNextUpdate(key: string): void {
    this.rejectedUpdateKeys.add(key);
  }

  pauseWrites(): void {
    this.writeGate = new Promise((resolve) => {
      this.releaseWriteGate = resolve;
    });
  }

  resumeWrites(): void {
    this.releaseWriteGate?.();
    this.writeGate = null;
    this.releaseWriteGate = null;
  }

  async flush(): Promise<void> {
    while (true) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) return;
    }
  }
}

describe("ApprovalManager session approval persistence", () => {
  const originalHome = process.env.HOME;
  let tempDir: string;
  let workspaceDir: string;
  const activeResources: Array<{
    approvalManager: { dispose(): void };
    configStore: { dispose(): void };
  }> = [];

  beforeEach(async () => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentlink-approval-test-"),
    );
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    process.env.HOME = tempDir;
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: workspaceDir } }];
    configurationValues.clear();
  });

  function disposeManagers(resource: (typeof activeResources)[number]): void {
    const index = activeResources.indexOf(resource);
    if (index >= 0) {
      activeResources.splice(index, 1);
    }
    resource.approvalManager.dispose();
    resource.configStore.dispose();
  }

  afterEach(() => {
    for (const resource of activeResources.splice(0)) {
      disposeManagers(resource);
    }
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createManagers(memento: MockMemento) {
    const { ConfigStore } = await import("./ConfigStore.js");
    const { ApprovalManager } = await import("./ApprovalManager.js");
    const configStore = new ConfigStore();
    const approvalManager = new ApprovalManager(memento as never, configStore);
    const resource = { configStore, approvalManager };
    activeResources.push(resource);
    return resource;
  }

  it("persists built-in tool approval for only the selected session", async () => {
    const memento = new MockMemento();
    const first = await createManagers(memento);

    first.approvalManager.approveBuiltInTool("session-a", "generate_image");
    await memento.flush();

    expect(
      first.approvalManager.isBuiltInToolApproved(
        "session-a",
        "generate_image",
      ),
    ).toBe(true);
    expect(
      first.approvalManager.isBuiltInToolApproved(
        "session-b",
        "generate_image",
      ),
    ).toBe(false);

    disposeManagers(first);
    const second = await createManagers(memento);
    expect(
      second.approvalManager.isBuiltInToolApproved(
        "session-a",
        "generate_image",
      ),
    ).toBe(true);
  });

  it("approves an entire MCP server for only the selected session", async () => {
    const { approvalManager } = await createManagers(new MockMemento());

    approvalManager.approveMcpServer("session-a", "linear");

    expect(
      approvalManager.isMcpApproved("session-a", "linear__list_issues"),
    ).toBe(true);
    expect(
      approvalManager.isMcpApproved("session-a", "linear__create_issue"),
    ).toBe(true);
    expect(
      approvalManager.isMcpApproved("session-b", "linear__list_issues"),
    ).toBe(false);
    expect(
      approvalManager.isMcpApproved("session-a", "github__list_issues"),
    ).toBe(false);
    expect(approvalManager.isMcpServerApproved("session-a", "linear")).toBe(
      true,
    );
    expect(approvalManager.isMcpServerApproved("session-b", "linear")).toBe(
      false,
    );

    approvalManager.clearSession("session-a");
    expect(
      approvalManager.isMcpApproved("session-a", "linear__list_issues"),
    ).toBe(false);
    expect(approvalManager.isMcpServerApproved("session-a", "linear")).toBe(
      false,
    );
  });

  it.each([
    {
      mode: "exact" as const,
      pattern: "npm test",
      matches: ["npm test", "  npm test  "],
      misses: ["npm test -- --runInBand"],
    },
    {
      mode: "prefix" as const,
      pattern: "npm test",
      matches: ["npm test", "npm  test -- --runInBand"],
      misses: ["npm run test", "npm testing"],
    },
    {
      mode: "regex" as const,
      pattern: "^npm (?:test|run test)(?:\\s|$)",
      matches: ["npm test", "npm run test -- --watch"],
      misses: ["pnpm test"],
    },
  ])(
    "matches $mode command rules",
    async ({ mode, pattern, matches, misses }) => {
      const memento = new MockMemento();
      const { approvalManager, configStore } = await createManagers(memento);
      approvalManager.addCommandRule(
        "command-match",
        { pattern, mode },
        "session",
      );

      for (const command of matches) {
        expect(
          approvalManager.isCommandApproved("command-match", command),
        ).toBe(true);
      }
      for (const command of misses) {
        expect(
          approvalManager.isCommandApproved("command-match", command),
        ).toBe(false);
      }

      disposeManagers({ approvalManager, configStore });
    },
  );

  it("matches command prefixes by shell word instead of string prefix", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addCommandRule(
      "word-prefix",
      { pattern: "git", mode: "prefix" },
      "session",
    );

    expect(approvalManager.isCommandApproved("word-prefix", "git status")).toBe(
      true,
    );
    expect(
      approvalManager.isCommandApproved("word-prefix", "github auth"),
    ).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("ignores malformed command regex rules", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addCommandRule(
      "invalid-regex",
      { pattern: "[", mode: "regex" },
      "session",
    );

    expect(approvalManager.isCommandApproved("invalid-regex", "anything")).toBe(
      false,
    );

    disposeManagers({ approvalManager, configStore });
  });

  it("orders command matches by scope then insertion order", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    const sessionId = "ordered-command-rules";

    approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm", mode: "prefix" },
      "global",
    );
    approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm test", mode: "prefix" },
      "project",
    );
    approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm test --", mode: "prefix" },
      "session",
    );
    approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm test -- --runInBand", mode: "exact" },
      "session",
    );

    expect(
      approvalManager.findMatchingCommandRule(
        sessionId,
        "npm test -- --runInBand",
      ),
    ).toEqual({
      rule: { pattern: "npm test --", mode: "prefix" },
      scope: "session",
    });

    approvalManager.removeCommandRule("npm test --", "session", sessionId);
    expect(
      approvalManager.findMatchingCommandRule(
        sessionId,
        "npm test -- --runInBand",
      ),
    ).toEqual({
      rule: { pattern: "npm test -- --runInBand", mode: "exact" },
      scope: "session",
    });

    approvalManager.clearSessionCommandRules(sessionId);
    expect(
      approvalManager.findMatchingCommandRule(
        sessionId,
        "npm test -- --runInBand",
      ),
    ).toEqual({
      rule: { pattern: "npm test", mode: "prefix" },
      scope: "project",
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("upgrades a legacy command rule decision in place", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    const sessionId = "command-decision-upgrade";

    approvalManager.addCommandRule(
      sessionId,
      { pattern: "dotnet build", mode: "exact" },
      "session",
    );
    approvalManager.addCommandRule(
      sessionId,
      { pattern: "dotnet build", mode: "exact", decision: "allow" },
      "session",
    );

    expect(approvalManager.getCommandRules(sessionId).session).toEqual([
      { pattern: "dotnet build", mode: "exact", decision: "allow" },
    ]);
    expect(
      approvalManager.evaluateCommandRules(sessionId, "dotnet build")
        .allSegmentsExplicitlyAllowed,
    ).toBe(true);

    disposeManagers({ approvalManager, configStore });
  });

  it("edits and removes same-pattern command modes by exact identity", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    const sessionId = "command-rule-identity";

    approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm test", mode: "exact", decision: "allow" },
      "session",
    );
    approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm test", mode: "prefix", decision: "prompt" },
      "session",
    );
    approvalManager.editCommandRule(
      "npm test",
      { pattern: "npm run test", mode: "prefix", decision: "forbidden" },
      "session",
      sessionId,
      { mode: "prefix", decision: "prompt" },
    );
    expect(approvalManager.getCommandRules(sessionId).session).toEqual([
      { pattern: "npm test", mode: "exact", decision: "allow" },
      { pattern: "npm run test", mode: "prefix", decision: "forbidden" },
    ]);

    approvalManager.removeCommandRule("npm test", "session", sessionId, {
      mode: "exact",
      decision: "allow",
    });
    expect(approvalManager.getCommandRules(sessionId).session).toEqual([
      { pattern: "npm run test", mode: "prefix", decision: "forbidden" },
    ]);

    disposeManagers({ approvalManager, configStore });
  });

  it.each(
    (["command", "path", "write"] as const).flatMap((channel) =>
      (["session", "project", "global"] as const).map((scope) => ({
        channel,
        scope,
      })),
    ),
  )(
    "deduplicates, edits, and removes $channel rules in $scope scope",
    async ({ channel, scope }) => {
      const memento = new MockMemento();
      const { approvalManager, configStore } = await createManagers(memento);
      const sessionId = `rule-mutations-${channel}-${scope}`;
      const add = (mode: "exact" | "prefix") => {
        const rule = { pattern: "shared-pattern", mode };
        if (channel === "command") {
          approvalManager.addCommandRule(sessionId, rule, scope);
        } else if (channel === "path") {
          approvalManager.addPathRule(sessionId, rule, scope);
        } else {
          approvalManager.addWriteRule(sessionId, rule, scope);
        }
      };
      const get = () => {
        if (channel === "command") {
          return approvalManager.getCommandRules(sessionId)[scope];
        }
        if (channel === "path") {
          return approvalManager.getPathRules(sessionId)[scope];
        }
        return approvalManager.getWriteRules(sessionId)[scope];
      };

      add("exact");
      add("exact");
      add("prefix");
      expect(get()).toEqual([
        { pattern: "shared-pattern", mode: "exact" },
        { pattern: "shared-pattern", mode: "prefix" },
      ]);

      const edited = { pattern: "edited-pattern", mode: "prefix" as const };
      if (channel === "command") {
        approvalManager.editCommandRule(
          "shared-pattern",
          edited,
          scope,
          sessionId,
        );
      } else if (channel === "path") {
        approvalManager.editPathRule(
          "shared-pattern",
          edited,
          scope,
          sessionId,
        );
      } else {
        approvalManager.editWriteRule(
          "shared-pattern",
          edited,
          scope,
          sessionId,
        );
      }
      expect(get()).toEqual([
        edited,
        { pattern: "shared-pattern", mode: "prefix" },
      ]);

      if (channel === "command") {
        approvalManager.removeCommandRule("shared-pattern", scope, sessionId);
      } else if (channel === "path") {
        approvalManager.removePathRule("shared-pattern", scope, sessionId);
      } else {
        approvalManager.removeWriteRule("shared-pattern", scope, sessionId);
      }
      expect(get()).toEqual([edited]);

      if (scope !== "session") {
        const configPath =
          scope === "global"
            ? path.join(tempDir, ".agentlink", "agentlink.json")
            : path.join(workspaceDir, ".agentlink", "agentlink.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
          commandRules?: unknown[];
          pathRules?: unknown[];
          writeRules?: unknown[];
        };
        const key = `${channel}Rules` as
          | "commandRules"
          | "pathRules"
          | "writeRules";
        expect(config[key]).toEqual([edited]);
      }

      disposeManagers({ approvalManager, configStore });
    },
  );

  it.each([
    {
      channel: "path" as const,
      mode: "exact" as const,
      pattern: "outside/exact.txt",
      matches: ["outside/exact.txt"],
      misses: ["outside/exact.txt.bak", "outside/nested/exact.txt"],
    },
    {
      channel: "path" as const,
      mode: "prefix" as const,
      pattern: "outside/prefix",
      matches: ["outside/prefix", "outside/prefix/nested.txt"],
      misses: ["outside/prefix-sibling/file.txt"],
    },
    {
      channel: "write" as const,
      mode: "glob" as const,
      pattern: "src/generated/**/*.ts",
      matches: ["src/generated/a.ts", "src/generated/nested/a.ts"],
      misses: ["src/generated/a.js", "src/other/a.ts"],
    },
  ])(
    "matches $channel $mode rules",
    async ({ channel, mode, pattern, matches, misses }) => {
      const memento = new MockMemento();
      const { approvalManager, configStore } = await createManagers(memento);
      const sessionId = `path-match-${channel}-${mode}`;
      const rule = { pattern, mode };
      if (channel === "path") {
        approvalManager.addPathRule(sessionId, rule, "session");
      } else {
        approvalManager.addWriteRule(sessionId, rule, "session");
      }

      for (const filePath of matches) {
        const actual =
          channel === "path"
            ? approvalManager.isPathTrusted(sessionId, filePath)
            : approvalManager.isFileWriteApproved(sessionId, filePath);
        expect(actual).toBe(true);
      }
      for (const filePath of misses) {
        const actual =
          channel === "path"
            ? approvalManager.isPathTrusted(sessionId, filePath)
            : approvalManager.isFileWriteApproved(sessionId, filePath);
        expect(actual).toBe(false);
      }

      disposeManagers({ approvalManager, configStore });
    },
  );

  it.each(["command", "path", "write"] as const)(
    "persists %s rules independently across session, project, and global scopes",
    async (channel) => {
      const memento = new MockMemento();
      const sessionId = `persisted-${channel}`;
      const rules = {
        session: { pattern: `${channel}-session`, mode: "exact" as const },
        project: { pattern: `${channel}-project`, mode: "prefix" as const },
        global: { pattern: `${channel}-global`, mode: "exact" as const },
      };
      const addRules = (approvalManager: {
        addCommandRule: typeof import("./ApprovalManager.js").ApprovalManager.prototype.addCommandRule;
        addPathRule: typeof import("./ApprovalManager.js").ApprovalManager.prototype.addPathRule;
        addWriteRule: typeof import("./ApprovalManager.js").ApprovalManager.prototype.addWriteRule;
      }) => {
        for (const scope of ["session", "project", "global"] as const) {
          if (channel === "command") {
            approvalManager.addCommandRule(sessionId, rules[scope], scope);
          } else if (channel === "path") {
            approvalManager.addPathRule(sessionId, rules[scope], scope);
          } else {
            approvalManager.addWriteRule(sessionId, rules[scope], scope);
          }
        }
      };
      const getRules = (approvalManager: {
        getCommandRules: typeof import("./ApprovalManager.js").ApprovalManager.prototype.getCommandRules;
        getPathRules: typeof import("./ApprovalManager.js").ApprovalManager.prototype.getPathRules;
        getWriteRules: typeof import("./ApprovalManager.js").ApprovalManager.prototype.getWriteRules;
      }) => {
        if (channel === "command") {
          return approvalManager.getCommandRules(sessionId);
        }
        if (channel === "path") {
          return approvalManager.getPathRules(sessionId);
        }
        return approvalManager.getWriteRules(sessionId);
      };

      {
        const { approvalManager, configStore } = await createManagers(memento);
        addRules(approvalManager);
        await memento.flush();
        disposeManagers({ approvalManager, configStore });
      }

      {
        const { approvalManager, configStore } = await createManagers(memento);
        expect(getRules(approvalManager)).toMatchObject({
          session: [rules.session],
          project: [rules.project],
          global: [rules.global],
        });
        disposeManagers({ approvalManager, configStore });
      }
    },
  );

  it.each(["command", "path", "write"] as const)(
    "isolates %s project rules by immutable session project binding",
    async (channel) => {
      const memento = new MockMemento();
      const secondWorkspaceDir = path.join(tempDir, "workspace-second");
      fs.mkdirSync(secondWorkspaceDir, { recursive: true });
      mockWorkspace.workspaceFolders = [
        { uri: { fsPath: workspaceDir } },
        { uri: { fsPath: secondWorkspaceDir } },
      ];
      const { approvalManager, configStore } = await createManagers(memento);
      const sessionA = `project-a-${channel}`;
      const sessionB = `project-b-${channel}`;
      approvalManager.bindSessionProject(sessionA, {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-a",
        workspaceFolderUri: `file://${workspaceDir}`,
        displayName: "Project A",
        rootPath: workspaceDir,
      });
      approvalManager.bindSessionProject(sessionB, {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-b",
        workspaceFolderUri: `file://${secondWorkspaceDir}`,
        displayName: "Project B",
        rootPath: secondWorkspaceDir,
      });
      const ruleA = { pattern: "project-a-only", mode: "exact" as const };
      const ruleB = { pattern: "project-b-only", mode: "exact" as const };

      const addRule = (sessionId: string, rule: typeof ruleA) => {
        if (channel === "command") {
          approvalManager.addCommandRule(sessionId, rule, "project");
        } else if (channel === "path") {
          approvalManager.addPathRule(sessionId, rule, "project");
        } else {
          approvalManager.addWriteRule(sessionId, rule, "project");
        }
      };
      const getProjectRules = (sessionId: string) =>
        channel === "command"
          ? approvalManager.getCommandRules(sessionId).project
          : channel === "path"
            ? approvalManager.getPathRules(sessionId).project
            : approvalManager.getWriteRules(sessionId).project;

      addRule(sessionA, ruleA);
      addRule(sessionB, ruleB);

      expect(getProjectRules(sessionA)).toEqual([ruleA]);
      expect(getProjectRules(sessionB)).toEqual([ruleB]);
      expect(() =>
        approvalManager.bindSessionProject(sessionA, {
          schemaVersion: 1,
          kind: "project",
          projectId: "project-b",
          workspaceFolderUri: `file://${secondWorkspaceDir}`,
          displayName: "Project B",
          rootPath: secondWorkspaceDir,
        }),
      ).toThrow("cannot be rebound");

      disposeManagers({ approvalManager, configStore });
    },
  );

  it("uses target-project settings and relativizes sibling-root targets", async () => {
    const memento = new MockMemento();
    const secondWorkspaceDir = path.join(tempDir, "workspace-second");
    fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(secondWorkspaceDir, "src"), { recursive: true });
    mockWorkspace.workspaceFolders = [workspaceDir, secondWorkspaceDir].map(
      (fsPath) => ({
        uri: {
          fsPath,
          toString: () => `file://${fsPath}`,
        },
      }),
    );
    configurationValues.set(workspaceDir, { writeRules: [] });
    configurationValues.set(secondWorkspaceDir, { writeRules: ["src/**"] });
    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.bindSessionProject("project-a-session", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    });
    approvalManager.bindSessionProject("project-b-session", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-b",
      workspaceFolderUri: `file://${secondWorkspaceDir}`,
      displayName: "Project B",
      rootPath: secondWorkspaceDir,
    });

    expect(
      approvalManager.isFileWriteApproved(
        "project-a-session",
        path.join(workspaceDir, "src", "blocked.ts"),
      ),
    ).toBe(false);
    expect(
      approvalManager.isFileWriteApproved(
        "project-a-session",
        path.join(secondWorkspaceDir, "src", "allowed.ts"),
      ),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(
        "project-b-session",
        path.join(secondWorkspaceDir, "src", "allowed.ts"),
      ),
    ).toBe(true);

    expect(mockWorkspace.getConfiguration).toHaveBeenCalledWith(
      "agentlink",
      expect.objectContaining({ fsPath: secondWorkspaceDir }),
    );
    disposeManagers({ approvalManager, configStore });
  });

  it("migrates legacy global rules by appending unique entries in order", async () => {
    const memento = new MockMemento();
    await memento.update("globalCommandRules", [
      { pattern: "existing", mode: "exact" },
      { pattern: "legacy-command", mode: "prefix" },
      { pattern: "legacy-command", mode: "prefix" },
    ]);
    await memento.update("globalPathRules", [
      { pattern: "legacy/path", mode: "glob" },
    ]);
    await memento.update("globalWriteRules", [
      { pattern: "legacy/write", mode: "prefix" },
    ]);
    await memento.update("globalWriteApproved", true);
    const globalConfigPath = path.join(tempDir, ".agentlink", "agentlink.json");
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        version: 1,
        commandRules: [{ pattern: "existing", mode: "exact" }],
        pathRules: [{ pattern: "existing/path", mode: "exact" }],
        writeRules: [{ pattern: "existing/write", mode: "exact" }],
      }),
      "utf-8",
    );
    const { approvalManager, configStore } = await createManagers(memento);

    await approvalManager.migrateFromGlobalState();

    expect(configStore.getGlobalConfig()).toMatchObject({
      writeApproved: true,
      commandRules: [
        { pattern: "existing", mode: "exact" },
        { pattern: "legacy-command", mode: "prefix" },
      ],
      pathRules: [
        { pattern: "existing/path", mode: "exact" },
        { pattern: "legacy/path", mode: "glob" },
      ],
      writeRules: [
        { pattern: "existing/write", mode: "exact" },
        { pattern: "legacy/write", mode: "prefix" },
      ],
    });
    expect(memento.get("globalCommandRules")).toBeUndefined();
    expect(memento.get("globalPathRules")).toBeUndefined();
    expect(memento.get("globalWriteRules")).toBeUndefined();
    expect(memento.get("globalWriteApproved")).toBeUndefined();
    expect(memento.get("configMigrated")).toBe(true);

    await memento.update("globalCommandRules", [
      { pattern: "late-legacy", mode: "exact" },
    ]);
    await approvalManager.migrateFromGlobalState();
    expect(configStore.getGlobalConfig().commandRules).not.toContainEqual({
      pattern: "late-legacy",
      mode: "exact",
    });
    expect(memento.get("globalCommandRules")).toEqual([
      { pattern: "late-legacy", mode: "exact" },
    ]);

    disposeManagers({ approvalManager, configStore });
  });

  it("preserves legacy migration state when the config write fails", async () => {
    const memento = new MockMemento();
    const legacyRule = { pattern: "retry-later", mode: "exact" as const };
    await memento.update("globalCommandRules", [legacyRule]);
    const { approvalManager, configStore } = await createManagers(memento);
    fs.writeFileSync(
      path.join(tempDir, ".agentlink"),
      "blocks directory creation",
    );

    await approvalManager.migrateFromGlobalState();

    expect(memento.get("globalCommandRules")).toEqual([legacyRule]);
    expect(memento.get("configMigrated")).toBeUndefined();
    expect(configStore.getGlobalConfig().commandRules).toBeUndefined();

    disposeManagers({ approvalManager, configStore });
  });

  it("exposes session persistence only after the memento commit completes", async () => {
    const memento = new MockMemento();
    const sessionId = "pending-persistence";
    const first = await createManagers(memento);
    memento.pauseWrites();

    first.approvalManager.addCommandRule(
      sessionId,
      { pattern: "pending-rule", mode: "exact" },
      "session",
    );
    const beforeCommit = await createManagers(memento);
    expect(
      beforeCommit.approvalManager.getCommandRules(sessionId).session,
    ).toEqual([]);

    memento.resumeWrites();
    await memento.flush();
    const afterCommit = await createManagers(memento);
    expect(
      afterCommit.approvalManager.getCommandRules(sessionId).session,
    ).toEqual([{ pattern: "pending-rule", mode: "exact" }]);
  });

  it("persists session-scoped agent write approval across manager recreation", async () => {
    const memento = new MockMemento();
    const sessionId = "session-1";

    {
      const { approvalManager, configStore } = await createManagers(memento);
      approvalManager.setAgentWriteApproval(sessionId, "session");
      await memento.flush();
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(true);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "session",
      );
      disposeManagers({ approvalManager, configStore });
    }

    {
      const { approvalManager, configStore } = await createManagers(memento);
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(true);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "session",
      );
      disposeManagers({ approvalManager, configStore });
    }
  });

  it("persists unrelated session changes independently across live managers", async () => {
    const memento = new MockMemento();
    const first = await createManagers(memento);
    const second = await createManagers(memento);

    first.approvalManager.setAgentWriteApproval("session-a", "session");
    second.approvalManager.setAgentWriteApproval("session-b", "session");
    await memento.flush();

    const restored = await createManagers(memento);
    expect(
      restored.approvalManager.getAgentWriteApprovalState("session-a"),
    ).toBe("session");
    expect(
      restored.approvalManager.getAgentWriteApprovalState("session-b"),
    ).toBe("session");

    disposeManagers(first);
    disposeManagers(second);
    disposeManagers(restored);
  });

  it("merges same-session changes and stale activity touches across live managers", async () => {
    const memento = new MockMemento();
    await memento.update("approvalSessionStorageVersion", 3);
    const first = await createManagers(memento);
    const second = await createManagers(memento);
    const sessionId = "shared-live-session";

    first.approvalManager.setAgentWriteApproval(sessionId, "session");
    await memento.flush();
    second.approvalManager.addCommandRule(
      sessionId,
      { pattern: "npm test", mode: "exact", decision: "allow" },
      "session",
    );
    await memento.flush();
    first.approvalManager.touchSession(sessionId);
    await memento.flush();

    const restored = await createManagers(memento);
    expect(restored.approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
      "session",
    );
    expect(restored.approvalManager.getCommandRules(sessionId).session).toEqual(
      [{ pattern: "npm test", mode: "exact", decision: "allow" }],
    );

    disposeManagers(first);
    disposeManagers(second);
    disposeManagers(restored);
  });

  it("merges concurrent MCP session grants across live managers", async () => {
    const memento = new MockMemento();
    await memento.update("approvalSessionStorageVersion", 3);
    const first = await createManagers(memento);
    const second = await createManagers(memento);

    first.approvalManager.approveMcpTool(
      "shared-mcp-session",
      "linear__create_issue",
    );
    await memento.flush();
    second.approvalManager.approveMcpServer("shared-mcp-session", "github");
    await memento.flush();

    const restored = await createManagers(memento);
    expect(
      restored.approvalManager.isMcpApproved(
        "shared-mcp-session",
        "linear__create_issue",
      ),
    ).toBe(true);
    expect(
      restored.approvalManager.isMcpApproved(
        "shared-mcp-session",
        "github__get_issue",
      ),
    ).toBe(true);

    disposeManagers(first);
    disposeManagers(second);
    disposeManagers(restored);
  });

  it("retries a failed per-session persistence write on the next touch", async () => {
    const memento = new MockMemento();
    await memento.update("approvalSessionStorageVersion", 3);
    const first = await createManagers(memento);
    memento.rejectNextUpdate("approvalSession:retry-session");

    first.approvalManager.setAgentWriteApproval("retry-session", "session");
    await memento.flush();
    const beforeRetry = await createManagers(memento);
    expect(
      beforeRetry.approvalManager.getAgentWriteApprovalState("retry-session"),
    ).toBe("prompt");

    first.approvalManager.touchSession("retry-session");
    await memento.flush();
    const afterRetry = await createManagers(memento);
    expect(
      afterRetry.approvalManager.getAgentWriteApprovalState("retry-session"),
    ).toBe("session");

    disposeManagers(first);
    disposeManagers(beforeRetry);
    disposeManagers(afterRetry);
  });

  it("migrates the legacy whole-session map to per-session records", async () => {
    const memento = new MockMemento();
    await memento.update("approvalSessions", {
      version: 1,
      sessions: {
        legacy: {
          writeApproved: false,
          agentWriteApproved: true,
          commandRules: [],
          networkRules: [],
          pathRules: [],
          writeRules: [],
          lastActivity: Date.now(),
        },
      },
    });

    const migrated = await createManagers(memento);
    expect(migrated.approvalManager.getAgentWriteApprovalState("legacy")).toBe(
      "session",
    );
    await vi.waitFor(() => {
      expect(memento.get("approvalSessionStorageVersion")).toBe(3);
      expect(memento.get("approvalSessions")).toBeUndefined();
    });
    expect(memento.keys()).toContain("approvalSession:legacy");

    const restored = await createManagers(memento);
    expect(restored.approvalManager.getAgentWriteApprovalState("legacy")).toBe(
      "session",
    );

    disposeManagers(migrated);
    disposeManagers(restored);
  });

  it("changes the selected write scope without clearing another session", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.setAgentWriteApproval("session-a", "session");
    approvalManager.setAgentWriteApproval("session-b", "session");

    expect(
      approvalManager.setAgentWriteApprovalSelection("session-b", "session"),
    ).toBe(true);
    expect(approvalManager.getAgentWriteApprovalState("session-a")).toBe(
      "session",
    );
    expect(approvalManager.getAgentWriteApprovalState("session-b")).toBe(
      "session",
    );

    expect(
      approvalManager.setAgentWriteApprovalSelection("session-b", "prompt"),
    ).toBe(true);
    expect(approvalManager.getAgentWriteApprovalState("session-a")).toBe(
      "session",
    );
    expect(approvalManager.getAgentWriteApprovalState("session-b")).toBe(
      "prompt",
    );

    disposeManagers({ approvalManager, configStore });
  });

  it("refreshes active session approval TTL and publishes expiration", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-07-01T00:00:00Z");
      vi.setSystemTime(startedAt);
      const memento = new MockMemento();
      const { approvalManager, configStore } = await createManagers(memento);
      approvalManager.bindSessionProject("active-session", {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-a",
        workspaceFolderUri: `file://${workspaceDir}`,
        displayName: "Project A",
        rootPath: workspaceDir,
      });
      approvalManager.setAgentWriteApproval("active-session", "session");

      vi.setSystemTime(startedAt + 24 * 60 * 60_000 - 1_000);
      approvalManager.touchSession("active-session");
      vi.setSystemTime(startedAt + 24 * 60 * 60_000 + 1_000);
      approvalManager.pruneExpiredSessions();
      expect(approvalManager.getAgentWriteApprovalState("active-session")).toBe(
        "session",
      );

      const onDidChange = vi.fn();
      const listener = approvalManager.onDidChange(onDidChange);
      vi.setSystemTime(startedAt + 2 * 24 * 60 * 60_000 + 1_000);
      approvalManager.pruneExpiredSessions();
      expect(approvalManager.getAgentWriteApprovalState("active-session")).toBe(
        "prompt",
      );
      expect(onDidChange).toHaveBeenCalledOnce();
      listener.dispose();
      disposeManagers({ approvalManager, configStore });
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires stale restored authority when the session becomes active", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-07-01T00:00:00Z");
      vi.setSystemTime(startedAt);
      const memento = new MockMemento();
      const first = await createManagers(memento);
      first.approvalManager.setAgentWriteApproval(
        "restored-session",
        "session",
      );
      await memento.flush();
      disposeManagers(first);

      vi.setSystemTime(startedAt + 24 * 60 * 60_000 + 1);
      const restored = await createManagers(memento);
      restored.approvalManager.bindSessionProject("restored-session", {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-a",
        workspaceFolderUri: `file://${workspaceDir}`,
        displayName: "Project A",
        rootPath: workspaceDir,
      });
      restored.approvalManager.touchSession("restored-session");

      expect(
        restored.approvalManager.getAgentWriteApprovalState("restored-session"),
      ).toBe("prompt");
      disposeManagers(restored);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not carry session-scoped agent write approval into another session", async () => {
    const { approvalManager, configStore } = await createManagers(
      new MockMemento(),
    );

    approvalManager.setAgentWriteApproval("session-old", "session");

    expect(approvalManager.getAgentWriteApprovalState("session-old")).toBe(
      "session",
    );
    expect(approvalManager.getAgentWriteApprovalState("session-new")).toBe(
      "prompt",
    );
    expect(approvalManager.isAgentWriteApproved("session-new")).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("supports file-level agent write approval when a matching write rule exists", async () => {
    const memento = new MockMemento();
    const sessionId = "session-file-rule";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isAgentWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isAgentWriteApproved(
        sessionId,
        "src/feature/nested/file.ts",
      ),
    ).toBe(true);
    expect(
      approvalManager.isAgentWriteApproved(sessionId, "src/other/file.ts"),
    ).toBe(false);
    expect(
      approvalManager.getAgentWriteAuthorization(
        sessionId,
        "src/feature/file.ts",
      ),
    ).toEqual({
      allowed: true,
      basis: "write_rule",
      scope: "session",
      rule: { pattern: "src/feature", mode: "glob" },
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("does not auto-approve agent writes without file path unless blanket trust exists", async () => {
    const memento = new MockMemento();
    const sessionId = "session-no-file";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(false);
    expect(approvalManager.getAgentWriteAuthorization(sessionId)).toEqual({
      allowed: false,
      basis: "none",
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("does not restore cleared session approval state", async () => {
    const memento = new MockMemento();
    const sessionId = "session-2";

    {
      const { approvalManager, configStore } = await createManagers(memento);
      approvalManager.setAgentWriteApproval(sessionId, "session");
      approvalManager.clearSession(sessionId);
      await memento.flush();
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(false);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "prompt",
      );
      disposeManagers({ approvalManager, configStore });
    }

    {
      const { approvalManager, configStore } = await createManagers(memento);
      expect(approvalManager.isAgentWriteApproved(sessionId)).toBe(false);
      expect(approvalManager.getAgentWriteApprovalState(sessionId)).toBe(
        "prompt",
      );
      disposeManagers({ approvalManager, configStore });
    }
  });

  it("treats a bare directory glob rule as recursive for descendant files", async () => {
    const memento = new MockMemento();
    const sessionId = "session-3";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(
        sessionId,
        "src/feature/nested/file.ts",
      ),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(
        sessionId,
        "src/feature-other/file.ts",
      ),
    ).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("surfaces session write rules in active session state", async () => {
    const memento = new MockMemento();
    const sessionId = "session-4";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(approvalManager.getWriteRules(sessionId).session).toEqual([
      { pattern: "src/feature", mode: "glob" },
    ]);
    expect(approvalManager.getActiveSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          writeApproved: false,
          agentWriteApproved: false,
          writeRuleCount: 1,
        }),
      ]),
    );

    disposeManagers({ approvalManager, configStore });
  });

  it("surfaces session agent write approval in active session state", async () => {
    const memento = new MockMemento();
    const sessionId = "session-agent-approval";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.setAgentWriteApproval(sessionId, "session");

    expect(approvalManager.getActiveSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          writeApproved: false,
          agentWriteApproved: true,
        }),
      ]),
    );

    disposeManagers({ approvalManager, configStore });
  });

  it("treats a bare directory prefix rule as recursive without overmatching siblings", async () => {
    const memento = new MockMemento();
    const sessionId = "session-5";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src/feat", mode: "prefix" },
      "session",
    );

    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feat/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feat/nested/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("applies the bare directory heuristic to trusted path rules", async () => {
    const memento = new MockMemento();
    const sessionId = "session-6";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addPathRule(
      sessionId,
      { pattern: "src/feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isPathTrusted(sessionId, "src/feature/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isPathTrusted(sessionId, "src/feature/nested/file.ts"),
    ).toBe(true);
    expect(
      approvalManager.isPathTrusted(sessionId, "src/feature-other/file.ts"),
    ).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("normalizes backslashes in custom directory rules", async () => {
    const memento = new MockMemento();
    const sessionId = "session-7";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      sessionId,
      { pattern: "src\\feature", mode: "glob" },
      "session",
    );

    expect(
      approvalManager.isFileWriteApproved(sessionId, "src/feature/file.ts"),
    ).toBe(true);

    disposeManagers({ approvalManager, configStore });
  });

  it("treats trailing-slash prefix path rules as directory prefixes", async () => {
    const memento = new MockMemento();
    const sessionId = "session-8";

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addPathRule(
      sessionId,
      { pattern: "/home/trist/.gram/", mode: "prefix" },
      "session",
    );

    expect(approvalManager.isPathTrusted(sessionId, "/home/trist/.gram")).toBe(
      true,
    );
    expect(
      approvalManager.isPathTrusted(sessionId, "/home/trist/.gram/file.txt"),
    ).toBe(true);
    expect(
      approvalManager.isPathTrusted(sessionId, "/home/trist/.grammar/file.txt"),
    ).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("keeps parent and child session approvals independently scoped", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);

    approvalManager.setAgentWriteApproval("parent", "session");
    approvalManager.setWriteApproval("parent", "session");
    approvalManager.addWriteRule(
      "parent",
      { pattern: "src/parent", mode: "prefix" },
      "session",
    );
    approvalManager.addPathRule(
      "parent",
      { pattern: "/outside/parent", mode: "prefix" },
      "session",
    );
    approvalManager.addCommandRule(
      "parent",
      { pattern: "npm test", mode: "prefix" },
      "session",
    );
    approvalManager.addCommandRule(
      "parent",
      { pattern: "git push", mode: "exact", decision: "allow" },
      "session",
    );
    approvalManager.approveMcpTool("parent", "linear__list_issues");
    approvalManager.approveMcpServer("parent", "github");

    approvalManager.addWriteRule(
      "child",
      { pattern: "src/child", mode: "prefix" },
      "session",
    );
    approvalManager.addPathRule(
      "child",
      { pattern: "/outside/child", mode: "prefix" },
      "session",
    );
    approvalManager.addCommandRule(
      "child",
      { pattern: "git status", mode: "exact", decision: "allow" },
      "session",
    );
    approvalManager.approveMcpTool("child", "linear__get_issue");

    expect(approvalManager.getAgentWriteApprovalState("child")).toBe("prompt");
    expect(approvalManager.getWriteApprovalState("child")).toBe("prompt");
    expect(approvalManager.getWriteRules("child").session).toEqual([
      { pattern: "src/child", mode: "prefix" },
    ]);
    expect(approvalManager.getPathRules("child").session).toEqual([
      { pattern: "/outside/child", mode: "prefix" },
    ]);
    expect(approvalManager.getCommandRules("child").session).toEqual([
      { pattern: "git status", mode: "exact", decision: "allow" },
    ]);
    expect(approvalManager.isMcpApproved("child", "linear__get_issue")).toBe(
      true,
    );
    expect(approvalManager.isMcpApproved("child", "linear__list_issues")).toBe(
      false,
    );
    expect(approvalManager.isMcpApproved("child", "github__create_issue")).toBe(
      false,
    );

    approvalManager.addWriteRule(
      "parent",
      { pattern: "src/parent-later", mode: "prefix" },
      "session",
    );
    approvalManager.addPathRule(
      "parent",
      { pattern: "/outside/parent-later", mode: "prefix" },
      "session",
    );
    approvalManager.addCommandRule(
      "parent",
      { pattern: "rm -rf build", mode: "exact", decision: "allow" },
      "session",
    );
    approvalManager.approveMcpTool("parent", "linear__create_issue");

    expect(approvalManager.getWriteRules("child").session).toEqual([
      { pattern: "src/child", mode: "prefix" },
    ]);
    expect(approvalManager.getPathRules("child").session).toEqual([
      { pattern: "/outside/child", mode: "prefix" },
    ]);
    expect(approvalManager.getCommandRules("child").session).toEqual([
      { pattern: "git status", mode: "exact", decision: "allow" },
    ]);
    expect(approvalManager.isMcpApproved("child", "linear__create_issue")).toBe(
      false,
    );
    expect(approvalManager.getWriteRules("parent").session).not.toContainEqual({
      pattern: "src/child",
      mode: "prefix",
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("snapshots all same-project session approval authority into a child", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    };
    approvalManager.bindSessionProject("parent", projectScope);
    approvalManager.bindSessionProject("child", projectScope);
    approvalManager.setWriteApproval("parent", "session");
    approvalManager.setAgentWriteApproval("parent", "session");
    approvalManager.addCommandRule(
      "parent",
      { pattern: "npm test", mode: "prefix" },
      "session",
    );
    approvalManager.addNetworkRule(
      "parent",
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "allow",
      },
      "session",
    );
    approvalManager.addPathRule(
      "parent",
      { pattern: "/outside/review", mode: "prefix" },
      "session",
    );
    approvalManager.addWriteRule(
      "parent",
      { pattern: "src/**", mode: "glob" },
      "session",
    );
    approvalManager.approveMcpTool("parent", "linear__list_issues");
    approvalManager.approveMcpServer("parent", "github");

    expect(approvalManager.inheritSessionState("parent", "child")).toBe(true);

    expect(approvalManager.getWriteApprovalState("child")).toBe("session");
    expect(approvalManager.getAgentWriteApprovalState("child")).toBe("session");
    expect(approvalManager.getCommandRules("child").session).toEqual([
      { pattern: "npm test", mode: "prefix" },
    ]);
    expect(approvalManager.getNetworkRules("child").session).toEqual([
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "allow",
      },
    ]);
    expect(approvalManager.getPathRules("child").session).toEqual([
      { pattern: "/outside/review", mode: "prefix" },
    ]);
    expect(
      approvalManager.isPathTrusted("child", "/outside/review/example.ts"),
    ).toBe(true);
    expect(approvalManager.getWriteRules("child").session).toEqual([
      { pattern: "src/**", mode: "glob" },
    ]);
    expect(
      approvalManager.getAgentWriteApprovalDiagnostics(
        "child",
        path.join(workspaceDir, "src", "example.ts"),
      ),
    ).toMatchObject({
      effectiveScope: "session",
      globalBlanketApproved: false,
      projectBlanketApproved: false,
      sessionBlanketApproved: true,
      legacyGlobalBlanketApproved: false,
      legacyProjectBlanketApproved: false,
      legacySessionBlanketApproved: true,
      sessionProjectBound: true,
      sessionStatePresent: true,
      writeRuleCounts: {
        session: 1,
        project: 0,
        global: 0,
        settings: 0,
      },
    });
    expect(approvalManager.isMcpApproved("child", "linear__list_issues")).toBe(
      true,
    );
    expect(approvalManager.isMcpApproved("child", "github__create_issue")).toBe(
      true,
    );
    expect(approvalManager.inheritSessionState("parent", "child")).toBe(false);

    approvalManager.addWriteRule(
      "parent",
      { pattern: "later/**", mode: "glob" },
      "session",
    );
    approvalManager.addNetworkRule(
      "parent",
      {
        pattern: "https://api.github.com:443",
        mode: "exact",
        decision: "allow",
      },
      "session",
    );
    approvalManager.approveMcpTool("parent", "linear__create_issue");
    expect(approvalManager.getWriteRules("child").session).not.toContainEqual({
      pattern: "later/**",
      mode: "glob",
    });
    expect(approvalManager.getNetworkRules("child").session).toHaveLength(1);
    expect(approvalManager.isMcpApproved("child", "linear__create_issue")).toBe(
      false,
    );
    expect(approvalManager.inheritSessionState("parent", "child")).toBe(true);
    expect(approvalManager.getWriteRules("child").session).toContainEqual({
      pattern: "later/**",
      mode: "glob",
    });
    expect(approvalManager.getNetworkRules("child").session).toContainEqual({
      pattern: "https://api.github.com:443",
      mode: "exact",
      decision: "allow",
    });
    expect(approvalManager.isMcpApproved("child", "linear__create_issue")).toBe(
      true,
    );

    approvalManager.addWriteRule(
      "child",
      { pattern: "child-only/**", mode: "glob" },
      "session",
    );
    expect(approvalManager.getWriteRules("parent").session).not.toContainEqual({
      pattern: "child-only/**",
      mode: "glob",
    });
    approvalManager.resetSessionAgentWriteApproval("parent");
    expect(approvalManager.getAgentWriteApprovalState("parent")).toBe("prompt");
    expect(approvalManager.getAgentWriteApprovalState("child")).toBe("session");

    disposeManagers({ approvalManager, configStore });
  });

  it("does not inherit stale authority from a restored parent session", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-07-01T00:00:00Z");
      vi.setSystemTime(startedAt);
      const memento = new MockMemento();
      await memento.update("approvalSessionStorageVersion", 3);
      const first = await createManagers(memento);
      first.approvalManager.setAgentWriteApproval("parent", "session");
      first.approvalManager.addWriteRule(
        "parent",
        { pattern: "src/**", mode: "glob" },
        "session",
      );
      await memento.flush();
      disposeManagers(first);

      vi.setSystemTime(startedAt + 24 * 60 * 60_000 + 1);
      const restored = await createManagers(memento);
      const projectScope = {
        schemaVersion: 1 as const,
        kind: "project" as const,
        projectId: "project-a",
        workspaceFolderUri: `file://${workspaceDir}`,
        displayName: "Project A",
        rootPath: workspaceDir,
      };
      restored.approvalManager.bindSessionProject("parent", projectScope);
      restored.approvalManager.bindSessionProject("child", projectScope);

      expect(
        restored.approvalManager.inheritSessionState("parent", "child"),
      ).toBe(false);
      expect(
        restored.approvalManager.getAgentWriteApprovalState("parent"),
      ).toBe("prompt");
      expect(restored.approvalManager.getAgentWriteApprovalState("child")).toBe(
        "prompt",
      );
      expect(restored.approvalManager.getWriteRules("child").session).toEqual(
        [],
      );

      disposeManagers(restored);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires MCP-only authority with its bound session", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-07-01T00:00:00Z");
      vi.setSystemTime(startedAt);
      const { approvalManager, configStore } = await createManagers(
        new MockMemento(),
      );
      approvalManager.bindSessionProject("mcp-only", {
        schemaVersion: 1,
        kind: "project",
        projectId: "project-a",
        workspaceFolderUri: `file://${workspaceDir}`,
        displayName: "Project A",
        rootPath: workspaceDir,
      });
      approvalManager.approveMcpServer("mcp-only", "github");
      expect(
        approvalManager.isMcpApproved("mcp-only", "github__get_issue"),
      ).toBe(true);

      vi.setSystemTime(startedAt + 24 * 60 * 60_000 + 1);
      approvalManager.pruneExpiredSessions();

      expect(
        approvalManager.isMcpApproved("mcp-only", "github__get_issue"),
      ).toBe(false);
      disposeManagers({ approvalManager, configStore });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores MCP session authority after an extension reload", async () => {
    const memento = new MockMemento();
    const first = await createManagers(memento);
    first.approvalManager.approveMcpTool(
      "restored-mcp",
      "linear__create_issue",
    );
    first.approvalManager.approveMcpServer("restored-mcp", "github");
    await memento.flush();
    disposeManagers(first);

    const restored = await createManagers(memento);
    expect(
      restored.approvalManager.isMcpApproved(
        "restored-mcp",
        "linear__create_issue",
      ),
    ).toBe(true);
    expect(
      restored.approvalManager.isMcpApproved(
        "restored-mcp",
        "github__get_issue",
      ),
    ).toBe(true);
    expect(
      restored.approvalManager.isMcpApproved(
        "restored-mcp",
        "slack__send_message",
      ),
    ).toBe(false);

    disposeManagers(restored);
  });

  it("refreshes inherited command and network rule decisions", async () => {
    const { approvalManager, configStore } = await createManagers(
      new MockMemento(),
    );
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    };
    approvalManager.bindSessionProject("parent", projectScope);
    approvalManager.bindSessionProject("child", projectScope);
    approvalManager.addCommandRule(
      "parent",
      { pattern: "npm test", mode: "exact", decision: "prompt" },
      "session",
    );
    approvalManager.addNetworkRule(
      "parent",
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "prompt",
      },
      "session",
    );
    expect(approvalManager.inheritSessionState("parent", "child")).toBe(true);

    approvalManager.addCommandRule(
      "parent",
      { pattern: "npm test", mode: "exact", decision: "allow" },
      "session",
    );
    approvalManager.addNetworkRule(
      "parent",
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "allow",
      },
      "session",
    );

    expect(approvalManager.inheritSessionState("parent", "child")).toBe(true);
    expect(approvalManager.getCommandRules("child").session).toEqual([
      { pattern: "npm test", mode: "exact", decision: "allow" },
    ]);
    expect(approvalManager.getNetworkRules("child").session).toEqual([
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "allow",
      },
    ]);

    disposeManagers({ approvalManager, configStore });
  });

  it("rejects session approval inheritance across project boundaries", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    const secondWorkspaceDir = path.join(tempDir, "workspace-b");
    fs.mkdirSync(secondWorkspaceDir, { recursive: true });
    approvalManager.bindSessionProject("parent", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    });
    approvalManager.bindSessionProject("child", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-b",
      workspaceFolderUri: `file://${secondWorkspaceDir}`,
      displayName: "Project B",
      rootPath: secondWorkspaceDir,
    });
    approvalManager.setAgentWriteApproval("parent", "session");

    expect(() =>
      approvalManager.inheritSessionState("parent", "child"),
    ).toThrow("cannot inherit authority from another project");
    expect(approvalManager.getAgentWriteApprovalState("child")).toBe("prompt");

    disposeManagers({ approvalManager, configStore });
  });

  it("inherits MCP-only session authority without creating blanket write trust", async () => {
    const memento = new MockMemento();
    const { approvalManager, configStore } = await createManagers(memento);
    const projectScope = {
      schemaVersion: 1 as const,
      kind: "project" as const,
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    };
    approvalManager.bindSessionProject("parent", projectScope);
    approvalManager.bindSessionProject("child", projectScope);
    approvalManager.approveMcpServer("parent", "github");

    expect(approvalManager.inheritSessionState("parent", "child")).toBe(true);
    expect(approvalManager.isMcpApproved("child", "github__get_issue")).toBe(
      true,
    );
    expect(approvalManager.getAgentWriteApprovalState("child")).toBe("prompt");
    expect(approvalManager.inheritSessionState("parent", "child")).toBe(false);

    disposeManagers({ approvalManager, configStore });
  });

  it("routes project config through canonical workspace roots", async () => {
    const memento = new MockMemento();
    const realWorkspace = path.join(tempDir, "real-workspace");
    const workspaceAlias = path.join(tempDir, "workspace-alias");
    fs.mkdirSync(realWorkspace, { recursive: true });
    fs.symlinkSync(realWorkspace, workspaceAlias, "dir");
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: workspaceAlias } }];

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.bindSessionProject("canonical-session", {
      schemaVersion: 1,
      kind: "project",
      projectId: "canonical-project",
      workspaceFolderUri: `file://${workspaceAlias}`,
      displayName: "Canonical Project",
      rootPath: fs.realpathSync.native(realWorkspace),
    });

    approvalManager.setAgentWriteApproval("canonical-session", "project");

    expect(
      configStore.getProjectConfig(fs.realpathSync.native(realWorkspace))
        .agentWriteApproved,
    ).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(realWorkspace, ".agentlink", "agentlink.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ agentWriteApproved: true });

    disposeManagers({ approvalManager, configStore });
  });

  it("routes project write approvals and rules to the target workspace root", async () => {
    const memento = new MockMemento();
    const secondWorkspaceDir = path.join(tempDir, "workspace-b");
    fs.mkdirSync(secondWorkspaceDir, { recursive: true });
    mockWorkspace.workspaceFolders = [workspaceDir, secondWorkspaceDir].map(
      (fsPath) => ({
        uri: {
          fsPath,
          toString: () => `file://${fsPath}`,
        },
      }),
    );

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.bindSessionProject("multi-root-write", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    });
    const targetPath = path.join(secondWorkspaceDir, "src", "feature.ts");

    approvalManager.setAgentWriteApproval(
      "multi-root-write",
      "project",
      targetPath,
    );
    approvalManager.addWriteRule(
      "multi-root-write",
      { pattern: "src/**/*.ts", mode: "glob" },
      "project",
      targetPath,
    );

    expect(configStore.getProjectConfig(workspaceDir)).toEqual({ version: 1 });
    expect(configStore.getProjectConfig(secondWorkspaceDir)).toMatchObject({
      agentWriteApproved: true,
      writeRules: [{ pattern: "src/**/*.ts", mode: "glob" }],
    });
    expect(
      approvalManager.isAgentWriteApproved("multi-root-write", targetPath),
    ).toBe(true);
    expect(
      approvalManager.getAgentWriteApprovalDiagnostics(
        "multi-root-write",
        targetPath,
      ),
    ).toMatchObject({
      effectiveScope: "project",
      projectBlanketApproved: true,
      writeRuleCounts: { project: 1 },
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("preserves existing authority when project selection has no multi-root target", async () => {
    const secondWorkspaceDir = path.join(tempDir, "workspace-b");
    fs.mkdirSync(secondWorkspaceDir, { recursive: true });
    mockWorkspace.workspaceFolders = [workspaceDir, secondWorkspaceDir].map(
      (fsPath) => ({ uri: { fsPath } }),
    );
    const { approvalManager, configStore } = await createManagers(
      new MockMemento(),
    );
    approvalManager.setAgentWriteApproval("unbound-session", "session");
    approvalManager.setAgentWriteApproval("unbound-session", "global");

    expect(
      approvalManager.setAgentWriteApprovalSelection(
        "unbound-session",
        "project",
      ),
    ).toBe(false);
    expect(
      approvalManager.getAgentWriteApprovalDiagnostics("unbound-session"),
    ).toMatchObject({
      effectiveScope: "global",
      globalBlanketApproved: true,
      sessionBlanketApproved: true,
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("routes project command rules by command cwd", async () => {
    const memento = new MockMemento();
    const secondWorkspaceDir = path.join(tempDir, "workspace-b");
    fs.mkdirSync(secondWorkspaceDir, { recursive: true });
    mockWorkspace.workspaceFolders = [workspaceDir, secondWorkspaceDir].map(
      (fsPath) => ({
        uri: {
          fsPath,
          toString: () => `file://${fsPath}`,
        },
      }),
    );

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.bindSessionProject("multi-root-command", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    });
    approvalManager.addCommandRule(
      "multi-root-command",
      { pattern: "npm test", mode: "exact", decision: "allow" },
      "project",
      secondWorkspaceDir,
    );

    const projectAEvaluation = approvalManager.evaluateCommandRules(
      "multi-root-command",
      "npm test",
      workspaceDir,
    );
    expect(projectAEvaluation).toMatchObject({
      decision: "unmatched",
      allSegmentsExplicitlyAllowed: false,
      allSegmentsApprovedByRule: false,
    });
    expect(
      approvalManager.isCommandApproved(
        "multi-root-command",
        "npm test",
        workspaceDir,
      ),
    ).toBe(false);

    const projectBEvaluation = approvalManager.evaluateCommandRules(
      "multi-root-command",
      "npm test",
      secondWorkspaceDir,
    );
    expect(projectBEvaluation).toMatchObject({
      decision: "allow",
      allSegmentsExplicitlyAllowed: true,
      allSegmentsApprovedByRule: true,
    });
    expect(
      approvalManager.isCommandApproved(
        "multi-root-command",
        "npm test",
        secondWorkspaceDir,
      ),
    ).toBe(true);
    expect(configStore.getProjectConfig(secondWorkspaceDir)).toMatchObject({
      commandRules: [{ pattern: "npm test", mode: "exact", decision: "allow" }],
    });

    disposeManagers({ approvalManager, configStore });
  });

  it("rejects conflicting project migration before mutating destination state", async () => {
    const memento = new MockMemento();
    const secondWorkspaceDir = path.join(tempDir, "workspace-b");
    fs.mkdirSync(secondWorkspaceDir, { recursive: true });
    mockWorkspace.workspaceFolders = [
      { uri: { fsPath: workspaceDir } },
      { uri: { fsPath: secondWorkspaceDir } },
    ];

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      "source-session",
      { pattern: "src/source", mode: "prefix" },
      "session",
    );
    approvalManager.addWriteRule(
      "destination-session",
      { pattern: "src/destination", mode: "prefix" },
      "session",
    );
    approvalManager.bindSessionProject("source-session", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-a",
      workspaceFolderUri: `file://${workspaceDir}`,
      displayName: "Project A",
      rootPath: workspaceDir,
    });
    approvalManager.bindSessionProject("destination-session", {
      schemaVersion: 1,
      kind: "project",
      projectId: "project-b",
      workspaceFolderUri: `file://${secondWorkspaceDir}`,
      displayName: "Project B",
      rootPath: secondWorkspaceDir,
    });

    expect(() =>
      approvalManager.migrateSessionState(
        "source-session",
        "destination-session",
      ),
    ).toThrow("already bound to another project");
    expect(
      approvalManager.getWriteRules("destination-session").session,
    ).toEqual([{ pattern: "src/destination", mode: "prefix" }]);
    expect(approvalManager.getWriteRules("source-session").session).toEqual([
      { pattern: "src/source", mode: "prefix" },
    ]);

    disposeManagers({ approvalManager, configStore });
  });

  it("merges placeholder approval state into an existing real session", async () => {
    const memento = new MockMemento();

    const { approvalManager, configStore } = await createManagers(memento);
    approvalManager.addWriteRule(
      "agent",
      { pattern: "src/from-placeholder", mode: "glob" },
      "session",
    );
    approvalManager.addWriteRule(
      "real-session",
      { pattern: "src/from-real", mode: "glob" },
      "session",
    );
    approvalManager.addPathRule(
      "agent",
      { pattern: "outside/path", mode: "glob" },
      "session",
    );
    approvalManager.addNetworkRule(
      "agent",
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "allow",
      },
      "session",
    );
    approvalManager.setAgentWriteApproval("agent", "session");

    approvalManager.migrateSessionState("agent", "real-session");

    expect(approvalManager.getWriteRules("real-session").session).toEqual(
      expect.arrayContaining([
        { pattern: "src/from-placeholder", mode: "glob" },
        { pattern: "src/from-real", mode: "glob" },
      ]),
    );
    expect(approvalManager.getPathRules("real-session").session).toEqual([
      { pattern: "outside/path", mode: "glob" },
    ]);
    expect(approvalManager.getNetworkRules("real-session").session).toEqual([
      {
        pattern: "https://registry.npmjs.org:443",
        mode: "exact",
        decision: "allow",
      },
    ]);
    expect(approvalManager.getAgentWriteApprovalState("real-session")).toBe(
      "session",
    );
    expect(approvalManager.getWriteRules("agent").session).toEqual([]);
    expect(approvalManager.getPathRules("agent").session).toEqual([]);
    expect(approvalManager.getNetworkRules("agent").session).toEqual([]);

    disposeManagers({ approvalManager, configStore });
  });
});
