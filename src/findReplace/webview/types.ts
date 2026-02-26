/** A single match occurrence within a file */
export interface FindReplaceMatch {
  /** Unique ID: "fileIdx:matchIdx" */
  id: string;
  /** 1-based line number of the match start */
  line: number;
  /** 0-based column of match start */
  columnStart: number;
  /** 0-based column of match end */
  columnEnd: number;
  /** The matched text */
  matchText: string;
  /** The computed replacement text (after capture group substitution) */
  replaceText: string;
  /** Context lines before the match */
  contextBefore: Array<{ lineNumber: number; text: string }>;
  /** The line containing the match */
  matchLine: { lineNumber: number; text: string };
  /** Context lines after the match */
  contextAfter: Array<{ lineNumber: number; text: string }>;
}

/** All matches within a single file */
export interface FindReplaceFileGroup {
  /** Relative path to the file */
  path: string;
  /** All match occurrences in this file */
  matches: FindReplaceMatch[];
}

/** Full preview data sent to the preview webview */
export interface FindReplacePreviewData {
  findText: string;
  replaceText: string;
  isRegex: boolean;
  fileGroups: FindReplaceFileGroup[];
  totalMatches: number;
}

// Extension → Preview webview
export type PreviewExtensionMessage =
  | { type: "showPreview"; data: FindReplacePreviewData }
  | { type: "dispose" };

// Preview webview → Extension
export type PreviewWebviewMessage =
  | { type: "ready" }
  | { type: "toggleMatch"; matchId: string; accepted: boolean }
  | { type: "toggleFile"; filePath: string; accepted: boolean }
  | { type: "toggleAll"; accepted: boolean };
