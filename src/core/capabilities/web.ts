import type { CoreWebToolKind } from "../webAccess.js";

export interface NativeWebToolExecutionRequest {
  kind: CoreWebToolKind;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface NativeWebToolExecutionProvider {
  execute(request: NativeWebToolExecutionRequest): Promise<unknown>;
}
