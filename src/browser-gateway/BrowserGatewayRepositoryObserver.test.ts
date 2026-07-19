import { beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserGatewayRepositoryObserver } from "./BrowserGatewayRepositoryObserver.js";

vi.mock("vscode", () => {
  type Listener<T> = (event: T) => unknown;

  class EventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();

    event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return { EventEmitter };
});

function eventHarness<T = void>() {
  const listeners = new Set<(event: T) => unknown>();
  return {
    event: (listener: (event: T) => unknown) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (event: T) => {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function repository(
  root: string,
  overrides: Record<string, unknown> = {},
): any {
  const stateChange = eventHarness<void>();
  return {
    rootUri: { fsPath: root },
    state: {
      HEAD: { name: "main", commit: "0123456789abcdef" },
      workingTreeChanges: [],
      indexChanges: [],
      mergeChanges: [],
      untrackedChanges: [],
      onDidChange: stateChange.event,
      ...overrides,
    },
    stateChange,
  };
}

describe("BrowserGatewayRepositoryObserver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects branch, detached HEAD, and every dirty collection", async () => {
    const repo = repository("/workspace", {
      untrackedChanges: [{}],
    });
    const api = { repositories: [repo] };
    const observer = new BrowserGatewayRepositoryObserver({
      getProject: () => ({
        projectId: "project-a",
        rootPath: "/workspace/project",
      }),
      getGitExtension: () => ({
        isActive: true,
        exports: { getAPI: () => api },
        activate: vi.fn(),
      }),
    });

    await observer.initialize();
    expect(observer.getRepositoryInfo()).toEqual({
      projectId: "project-a",
      branch: "main",
      dirty: true,
    });

    repo.state.HEAD = { commit: "fedcba9876543210" };
    repo.state.untrackedChanges = [];
    expect(observer.getRepositoryInfo()).toEqual({
      projectId: "project-a",
      branch: "fedcba98",
      dirty: false,
    });

    for (const field of [
      "mergeChanges",
      "indexChanges",
      "workingTreeChanges",
      "untrackedChanges",
    ] as const) {
      repo.state[field] = [{}];
      expect(observer.getRepositoryInfo()?.dirty).toBe(true);
      repo.state[field] = [];
    }

    observer.dispose();
  });

  it("selects the deepest matching repository without unrelated fallback", async () => {
    const unrelated = repository("/other");
    const parent = repository("/workspace");
    const nested = repository("/workspace/project");
    const api = { repositories: [unrelated, parent, nested] };
    const observer = new BrowserGatewayRepositoryObserver({
      getProject: () => ({
        projectId: "project-a",
        rootPath: "/workspace/project/packages/app",
      }),
      getGitExtension: () => ({
        isActive: true,
        exports: { getAPI: () => api },
        activate: vi.fn(),
      }),
    });

    await observer.initialize();
    expect(nested.stateChange.listenerCount()).toBe(1);
    expect(parent.stateChange.listenerCount()).toBe(0);
    expect(observer.getRepositoryInfo()?.branch).toBe("main");

    const unmatched = new BrowserGatewayRepositoryObserver({
      getProject: () => ({ projectId: "project-a", rootPath: "/missing" }),
      getGitExtension: () => ({
        isActive: true,
        exports: { getAPI: () => api },
        activate: vi.fn(),
      }),
    });
    await unmatched.initialize();
    expect(unmatched.getRepositoryInfo()).toBeNull();

    observer.dispose();
    unmatched.dispose();
  });

  it("rebinds selected state when the foreground project changes", async () => {
    const first = repository("/workspace/a");
    const second = repository("/workspace/b");
    const api = { repositories: [first, second] };
    let project = { projectId: "project-a", rootPath: "/workspace/a" };
    const observer = new BrowserGatewayRepositoryObserver({
      getProject: () => project,
      getGitExtension: () => ({
        isActive: true,
        exports: { getAPI: () => api },
        activate: vi.fn(),
      }),
    });
    const listener = vi.fn();
    observer.onDidChange(listener);

    await observer.initialize();
    expect(observer.getRepositoryInfo()?.projectId).toBe("project-a");
    expect(first.stateChange.listenerCount()).toBe(1);

    project = { projectId: "project-b", rootPath: "/workspace/b" };
    observer.rebindProject();

    expect(observer.getRepositoryInfo()?.projectId).toBe("project-b");
    expect(first.stateChange.listenerCount()).toBe(0);
    expect(second.stateChange.listenerCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(2);

    observer.dispose();
  });

  it("rebinds selected state on repository open and close events", async () => {
    const opened = eventHarness<any>();
    const closed = eventHarness<any>();
    const first = repository("/workspace");
    const api = {
      repositories: [first],
      onDidOpenRepository: opened.event,
      onDidCloseRepository: closed.event,
    };
    const observer = new BrowserGatewayRepositoryObserver({
      getProject: () => ({
        projectId: "project-a",
        rootPath: "/workspace/project",
      }),
      getGitExtension: () => ({
        isActive: true,
        exports: { getAPI: () => api },
        activate: vi.fn(),
      }),
    });
    const listener = vi.fn();
    observer.onDidChange(listener);

    await observer.initialize();
    expect(listener).toHaveBeenCalledTimes(1);
    first.stateChange.fire();
    expect(listener).toHaveBeenCalledTimes(2);

    const nested = repository("/workspace/project");
    api.repositories.push(nested);
    opened.fire(nested);
    expect(first.stateChange.listenerCount()).toBe(0);
    expect(nested.stateChange.listenerCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(3);

    api.repositories.splice(api.repositories.indexOf(nested), 1);
    closed.fire(nested);
    expect(nested.stateChange.listenerCount()).toBe(0);
    expect(first.stateChange.listenerCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(4);

    observer.dispose();
  });

  it("activates inactive Git and degrades to null when unavailable", async () => {
    const repo = repository("/workspace");
    const api = { repositories: [repo] };
    const activate = vi.fn().mockResolvedValue({ getAPI: () => api });
    const observer = new BrowserGatewayRepositoryObserver({
      getProject: () => ({ projectId: "project-a", rootPath: "/workspace" }),
      getGitExtension: () => ({
        isActive: false,
        exports: undefined as never,
        activate,
      }),
    });

    await observer.initialize();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(observer.getRepositoryInfo()).toEqual({
      projectId: "project-a",
      branch: "main",
      dirty: false,
    });

    const unavailable = new BrowserGatewayRepositoryObserver({
      getProject: () => ({ projectId: "project-a", rootPath: "/workspace" }),
      getGitExtension: () => undefined,
    });
    await unavailable.initialize();
    expect(unavailable.getRepositoryInfo()).toBeNull();

    observer.dispose();
    unavailable.dispose();
  });

  it("contains activation and rebinding failures while publishing null state", async () => {
    const listener = vi.fn();
    const activationFailure = new BrowserGatewayRepositoryObserver({
      getProject: () => ({ projectId: "project-a", rootPath: "/workspace" }),
      getGitExtension: () => ({
        isActive: false,
        exports: undefined as never,
        activate: vi.fn().mockRejectedValue(new Error("Git activation failed")),
      }),
    });
    activationFailure.onDidChange(listener);

    await expect(activationFailure.initialize()).resolves.toBeUndefined();
    expect(activationFailure.getRepositoryInfo()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    activationFailure.dispose();
  });

  it("disposes API and selected repository listeners without late events", async () => {
    const opened = eventHarness<any>();
    const closed = eventHarness<any>();
    const repo = repository("/workspace");
    const api = {
      repositories: [repo],
      onDidOpenRepository: opened.event,
      onDidCloseRepository: closed.event,
    };
    const observer = new BrowserGatewayRepositoryObserver({
      getProject: () => ({ projectId: "project-a", rootPath: "/workspace" }),
      getGitExtension: () => ({
        isActive: true,
        exports: { getAPI: () => api },
        activate: vi.fn(),
      }),
    });
    const listener = vi.fn();
    observer.onDidChange(listener);
    await observer.initialize();
    listener.mockClear();

    observer.dispose();
    repo.stateChange.fire();
    opened.fire(repo);
    closed.fire(repo);

    expect(listener).not.toHaveBeenCalled();
    expect(repo.stateChange.listenerCount()).toBe(0);
    expect(opened.listenerCount()).toBe(0);
    expect(closed.listenerCount()).toBe(0);
  });
});
