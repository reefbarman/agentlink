export type CoreWebAccessBackend = "provider" | "mcp" | "mixed" | "disabled";
export type CoreWebToolKind = "search" | "fetch";

export interface CoreWebCitation {
  url: string;
  title?: string;
  citedText?: string;
  startIndex?: number;
  endIndex?: number;
}

export type CoreWebActivityStatus = "started" | "completed" | "failed";

export interface CoreWebActivity {
  id: string;
  kind: CoreWebToolKind;
  status: CoreWebActivityStatus;
  backend: Exclude<CoreWebAccessBackend, "disabled">;
  query?: string;
  url?: string;
  citations?: CoreWebCitation[];
  error?: string;
}
