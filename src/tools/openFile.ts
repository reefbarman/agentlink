import type { EditorRevealProvider } from "../core/capabilities/editReview.js";
import type {
  PathAccessProvider,
  WorkspaceFileProvider,
} from "../core/capabilities/readSearch.js";
import { type ToolResult } from "../shared/types.js";

export interface OpenFileParams {
  path: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
}

export interface OpenFileProviders {
  workspaceFileProvider: WorkspaceFileProvider;
  pathAccessProvider: PathAccessProvider;
  editorRevealProvider?: EditorRevealProvider;
}

function errorTextResult(error: string, path?: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error, path }) }] };
}

export function createUnavailableEditorRevealProvider(): EditorRevealProvider {
  return {
    async reveal(params) {
      return errorTextResult(
        "Editor reveal is unavailable in this runtime. Provide an EditorRevealProvider to enable open_file.",
        params.absolutePath,
      );
    },
  };
}

export async function handleOpenFile(
  params: OpenFileParams,
  sessionId: string,
  providers: OpenFileProviders,
): Promise<ToolResult> {
  try {
    const { absolutePath, inWorkspace } =
      providers.workspaceFileProvider.resolvePath(params.path);

    const access = await providers.pathAccessProvider.ensureAccess({
      absolutePath,
      inputPath: params.path,
      inWorkspace,
      sessionId,
      kind: "read",
    });

    if (!access.approved) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "rejected",
              path: params.path,
              reason: access.reason,
            }),
          },
        ],
      };
    }

    const revealProvider =
      providers.editorRevealProvider ?? createUnavailableEditorRevealProvider();
    return revealProvider.reveal({
      absolutePath,
      line: params.line,
      column: params.column,
      end_line: params.end_line,
      end_column: params.end_column,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorTextResult(message, params.path);
  }
}
