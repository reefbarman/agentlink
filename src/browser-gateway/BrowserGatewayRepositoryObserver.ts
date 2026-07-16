import * as path from "path";
import * as vscode from "vscode";

export interface BrowserGatewayRepositoryInfo {
  branch?: string;
  dirty?: boolean;
}

type GitEvent<T = void> = (
  listener: (event: T) => unknown,
) => vscode.Disposable;

interface GitRepositoryState {
  HEAD?: { name?: string; commit?: string };
  workingTreeChanges?: unknown[];
  indexChanges?: unknown[];
  mergeChanges?: unknown[];
  untrackedChanges?: unknown[];
  onDidChange?: GitEvent;
}

interface GitRepository {
  rootUri: { fsPath: string };
  state: GitRepositoryState;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository?: GitEvent<GitRepository>;
  onDidCloseRepository?: GitEvent<GitRepository>;
}

interface GitExports {
  getAPI(version: 1): GitApi;
}

type GitExtension = Pick<
  vscode.Extension<GitExports>,
  "isActive" | "exports" | "activate"
>;

export interface BrowserGatewayRepositoryObserverDependencies {
  getFirstWorkspaceRootPath(): string | undefined;
  getGitExtension(): GitExtension | undefined;
}

function containsPath(repositoryRoot: string, workspaceRoot: string): boolean {
  const relative = path.relative(repositoryRoot, workspaceRoot);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function defaultDependencies(): BrowserGatewayRepositoryObserverDependencies {
  return {
    getFirstWorkspaceRootPath: () =>
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    getGitExtension: () =>
      vscode.extensions.getExtension<GitExports>("vscode.git"),
  };
}

export class BrowserGatewayRepositoryObserver implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly apiDisposables: vscode.Disposable[] = [];
  private repositoryStateDisposable: vscode.Disposable | undefined;
  private api: GitApi | undefined;
  private selectedRepository: GitRepository | undefined;
  private disposed = false;

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly dependencies: BrowserGatewayRepositoryObserverDependencies = defaultDependencies(),
  ) {}

  async initialize(): Promise<void> {
    try {
      const extension = this.dependencies.getGitExtension();
      if (extension) {
        const exports = extension.isActive
          ? extension.exports
          : await extension.activate();
        if (this.disposed) return;
        this.api = exports.getAPI(1);
        this.bindApiEvents();
      }

      if (this.disposed) return;
      this.rebindSelectedRepository();
      this.onDidChangeEmitter.fire();
    } catch {
      this.api = undefined;
      this.selectedRepository = undefined;
      if (!this.disposed) this.onDidChangeEmitter.fire();
    }
  }

  getRepositoryInfo(): BrowserGatewayRepositoryInfo | null {
    const state = this.selectedRepository?.state;
    if (!state) return null;

    const branch = state.HEAD?.name || state.HEAD?.commit?.slice(0, 8);
    const dirty = Boolean(
      state.mergeChanges?.length ||
      state.indexChanges?.length ||
      state.workingTreeChanges?.length ||
      state.untrackedChanges?.length,
    );
    return { ...(branch ? { branch } : {}), dirty };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.repositoryStateDisposable?.dispose();
    this.repositoryStateDisposable = undefined;
    for (const disposable of this.apiDisposables.splice(0)) {
      disposable.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }

  private bindApiEvents(): void {
    const rebind = () => {
      if (this.disposed) return;
      this.rebindSelectedRepository();
      this.onDidChangeEmitter.fire();
    };
    if (this.api?.onDidOpenRepository) {
      this.apiDisposables.push(this.api.onDidOpenRepository(rebind));
    }
    if (this.api?.onDidCloseRepository) {
      this.apiDisposables.push(this.api.onDidCloseRepository(rebind));
    }
  }

  private rebindSelectedRepository(): void {
    this.repositoryStateDisposable?.dispose();
    this.repositoryStateDisposable = undefined;

    const workspaceRoot = this.dependencies.getFirstWorkspaceRootPath();
    this.selectedRepository = workspaceRoot
      ? this.api?.repositories
          .filter((repository) =>
            containsPath(repository.rootUri.fsPath, workspaceRoot),
          )
          .sort(
            (left, right) =>
              right.rootUri.fsPath.length - left.rootUri.fsPath.length,
          )[0]
      : undefined;

    const onDidChange = this.selectedRepository?.state.onDidChange;
    if (onDidChange) {
      this.repositoryStateDisposable = onDidChange(() => {
        if (!this.disposed) this.onDidChangeEmitter.fire();
      });
    }
  }
}
