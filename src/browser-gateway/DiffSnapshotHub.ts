import * as vscode from "vscode";

export interface DiffSnapshot {
  requestId: string;
  filePath: string;
  operation: "create" | "modify";
  originalContent: string;
  proposedContent: string;
  outsideWorkspace: boolean;
  createdAt: number;
}

export interface DiffSnapshotPreview {
  requestId: string;
  filePath: string;
  operation: "create" | "modify";
  originalPreview: string;
  proposedPreview: string;
  outsideWorkspace: boolean;
  createdAt: number;
}

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
