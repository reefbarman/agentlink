import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WorkspaceFolder = { name: string; uri: { fsPath: string } };

const { mockWorkspace } = vi.hoisted(() => ({
  mockWorkspace: {
    workspaceFolders: [] as WorkspaceFolder[],
  },
}));

vi.mock("vscode", () => ({
  workspace: mockWorkspace,
}));

describe("getRelativePath", () => {
  beforeEach(() => {
    vi.resetModules();
    mockWorkspace.workspaceFolders = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a workspace-relative path for files inside the first workspace root", async () => {
    mockWorkspace.workspaceFolders = [
      {
        name: "native-claude",
        uri: { fsPath: "/workspace/native-claude" },
      },
    ];

    const { getRelativePath } = await import("./paths.js");

    expect(
      getRelativePath("/workspace/native-claude/src/agent/ChatViewProvider.ts"),
    ).toBe("src/agent/ChatViewProvider.ts");
  });

  it("returns the original absolute path for files outside the workspace", async () => {
    mockWorkspace.workspaceFolders = [
      {
        name: "native-claude",
        uri: { fsPath: "/workspace/native-claude" },
      },
    ];

    const { getRelativePath } = await import("./paths.js");

    expect(getRelativePath("/other-project/image.png")).toBe(
      "/other-project/image.png",
    );
  });

  it("returns a workspace-relative path for files inside a later workspace root", async () => {
    mockWorkspace.workspaceFolders = [
      {
        name: "first-root",
        uri: { fsPath: "/workspace/first-root" },
      },
      {
        name: "second-root",
        uri: { fsPath: "/workspace/second-root" },
      },
    ];

    const { getRelativePath } = await import("./paths.js");

    expect(getRelativePath("/workspace/second-root/assets/image.png")).toBe(
      "assets/image.png",
    );
  });

  it("currently allows an explicit workspace-folder prefix to select a later root", async () => {
    mockWorkspace.workspaceFolders = [
      {
        name: "first-root",
        uri: { fsPath: "/workspace/first-root" },
      },
      {
        name: "second-root",
        uri: { fsPath: "/workspace/second-root" },
      },
    ];

    const { resolveAndValidatePath } = await import("./paths.js");

    expect(resolveAndValidatePath("second-root/assets/image.png")).toEqual({
      absolutePath: "/workspace/second-root/assets/image.png",
      inWorkspace: true,
    });
  });

  it("isolates concurrent request-bound workspace roots", async () => {
    mockWorkspace.workspaceFolders = [
      {
        name: "first-root",
        uri: { fsPath: "/workspace/first-root" },
      },
      {
        name: "second-root",
        uri: { fsPath: "/workspace/second-root" },
      },
    ];

    const { getWorkspaceRoots, resolveAndValidatePath, withWorkspaceRoots } =
      await import("./paths.js");
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondPaused = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = withWorkspaceRoots(["/workspace/first-root"], async () => {
      await secondPaused;
      return {
        roots: getWorkspaceRoots(),
        resolved: resolveAndValidatePath("src/index.ts"),
      };
    });
    const second = withWorkspaceRoots(["/workspace/second-root"], async () => {
      releaseSecond();
      await firstPaused;
      return {
        roots: getWorkspaceRoots(),
        resolved: resolveAndValidatePath("src/index.ts"),
      };
    });
    releaseFirst();

    await expect(first).resolves.toEqual({
      roots: ["/workspace/first-root"],
      resolved: {
        absolutePath: "/workspace/first-root/src/index.ts",
        inWorkspace: true,
      },
    });
    await expect(second).resolves.toEqual({
      roots: ["/workspace/second-root"],
      resolved: {
        absolutePath: "/workspace/second-root/src/index.ts",
        inWorkspace: true,
      },
    });
    expect(getWorkspaceRoots()).toEqual([
      "/workspace/first-root",
      "/workspace/second-root",
    ]);
  });

  it("returns slash-separated workspace-relative paths", async () => {
    mockWorkspace.workspaceFolders = [
      {
        name: "native-claude",
        uri: { fsPath: "/workspace/native-claude" },
      },
    ];

    const { getRelativePath } = await import("./paths.js");

    expect(
      getRelativePath("/workspace/native-claude/src/agent/ChatViewProvider.ts"),
    ).toBe("src/agent/ChatViewProvider.ts");
    expect(
      getRelativePath("/workspace/native-claude/src/agent/webview/App.tsx"),
    ).not.toContain("\\");
  });
});
