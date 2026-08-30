import * as vscode from "vscode";

import type { DiffSnapshot } from "@agentlink/protocol/diff-snapshot";

export type {
  DiffSnapshot,
  DiffSnapshotPreview,
} from "@agentlink/protocol/diff-snapshot";

class DiffSnapshotHub implements vscode.Disposable {
  private readonly snapshots = new Map<string, DiffSnapshot>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    ReadonlyArray<DiffSnapshot>
  >();

  readonly onDidChange = this.onDidChangeEmitter.event;

  upsert(snapshot: DiffSnapshot): void {
    this.snapshots.set(snapshot.requestId, snapshot);
    this.emit();
  }

  remove(requestId: string): void {
    if (this.snapshots.delete(requestId)) {
      this.emit();
    }
  }

  get(requestId: string): DiffSnapshot | undefined {
    return this.snapshots.get(requestId);
  }

  list(): DiffSnapshot[] {
    return [...this.snapshots.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  dispose(): void {
    this.snapshots.clear();
    this.onDidChangeEmitter.dispose();
  }

  private emit(): void {
    this.onDidChangeEmitter.fire(this.list());
  }
}

export const diffSnapshotHub = new DiffSnapshotHub();
