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
