import * as path from "node:path";

import { DerivedSessionRetrievalService } from "../../core/session/DerivedSessionRetrievalService.js";
import { LanceDbRetrievalRepository } from "./LanceDbRetrievalRepository.js";
import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import type { WorkspaceSessionHistoryIndex } from "@agentlink/core/workspace-session-history";
import { createDerivedSessionWorkspaceHistoryIndex } from "../../core/session/workspaceSessionHistoryIndex.js";
import { createHash } from "node:crypto";

/**
 * Owns the disposable local lexical index for one workspace's session history.
 * The store is a rebuildable cache beside, never inside, canonical history.
 */
export class WorkspaceSessionHistoryIndexStore {
  private repository: LanceDbRetrievalRepository | undefined;
  private service: DerivedSessionRetrievalService | undefined;

  constructor(private readonly root: string) {}

  /** A stable per-history-directory root under extension global storage. */
  static rootFor(globalStoragePath: string, historyDirectory: string): string {
    const key = createHash("sha256")
      .update(path.resolve(historyDirectory))
      .digest("hex")
      .slice(0, 24);
    return path.join(globalStoragePath, "workspace-session-history", key);
  }

  readonly forProject = (
    scope: SessionProjectScope,
    variant?: "worktrees",
  ): WorkspaceSessionHistoryIndex => {
    this.repository ??= new LanceDbRetrievalRepository({ root: this.root });
    this.service ??= new DerivedSessionRetrievalService(this.repository);
    return createDerivedSessionWorkspaceHistoryIndex({
      service: this.service,
      // Index records are keyed by scope, so the worktree-inclusive index
      // never overwrites or leaks into the project-only index.
      scope: {
        kind: "workspace",
        id: variant ? `${scope.projectId}#${variant}` : scope.projectId,
      },
    });
  };

  async close(): Promise<void> {
    const repository = this.repository;
    this.repository = undefined;
    this.service = undefined;
    await repository?.close();
  }
}
