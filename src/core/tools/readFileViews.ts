/**
 * `read_file` exposes two views over separate internal operations. Each view
 * keeps its own operation identity so name-keyed approval, Compose, budget,
 * and handler policies continue to apply unchanged.
 */
export type ReadFileView = "content" | "context";
export type ReadFileOperation = "read_file" | "get_context";

export const READ_FILE_VIEWS: readonly ReadFileView[] = ["content", "context"];

export const READ_FILE_VIEW_OPERATIONS: Readonly<
  Record<ReadFileView, ReadFileOperation>
> = Object.freeze({ content: "read_file", context: "get_context" });

const VIEW_ONLY_OPTIONS: Readonly<Record<ReadFileView, readonly string[]>> =
  Object.freeze({
    content: [
      "anchor",
      "anchor_regex",
      "anchor_offset",
      "auto_follow_suggestion",
    ],
    context: ["dedupe_unchanged_content", "refresh", "character_offset"],
  });

/** Views whose underlying operation is permitted by the caller's authority. */
export function getPermittedReadFileViews(
  isOperationPermitted: (operation: ReadFileOperation) => boolean,
): ReadFileView[] {
  return READ_FILE_VIEWS.filter((view) =>
    isOperationPermitted(READ_FILE_VIEW_OPERATIONS[view]),
  );
}

export type ReadFileViewResolution =
  | {
      ok: true;
      view: ReadFileView;
      operation: ReadFileOperation;
      input: Record<string, unknown>;
    }
  | { ok: false; message: string; status: string };

/**
 * Resolve a public read_file call to its internal operation before any file
 * access. An omitted view always means content; it never falls back to
 * another permitted view.
 */
export function resolveReadFileView(
  input: Readonly<Record<string, unknown>>,
  permittedViews: readonly ReadFileView[],
): ReadFileViewResolution {
  const rawView = input.view;
  if (rawView !== undefined && rawView !== "content" && rawView !== "context") {
    return {
      ok: false,
      status: "invalid_read_view",
      message: `Invalid read_file view: ${JSON.stringify(rawView)}. Use "content" or "context".`,
    };
  }
  const view: ReadFileView = rawView ?? "content";
  if (!permittedViews.includes(view)) {
    const allowed = permittedViews.map((item) => `"${item}"`).join(", ");
    return {
      ok: false,
      status: "read_view_not_permitted",
      message:
        permittedViews.length > 0
          ? `read_file view "${view}" is not permitted for this request${rawView === undefined ? ' (omitted view means "content")' : ""}. Permitted views: ${allowed}.`
          : "read_file is not permitted for this request.",
    };
  }
  const otherView: ReadFileView = view === "content" ? "context" : "content";
  const mismatched = VIEW_ONLY_OPTIONS[otherView].filter(
    (key) => input[key] !== undefined,
  );
  if (mismatched.length > 0) {
    return {
      ok: false,
      status: "read_view_option_mismatch",
      message: `read_file ${mismatched.map((key) => `'${key}'`).join(", ")} ${mismatched.length === 1 ? "applies" : "apply"} only to view "${otherView}"; the requested view is "${view}".`,
    };
  }
  const { view: _view, ...operationInput } = input;
  return {
    ok: true,
    view,
    operation: READ_FILE_VIEW_OPERATIONS[view],
    input: operationInput,
  };
}

/** Internal operation name for a public call, used for name-keyed budgets. */
export function getReadFileOperationName(
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
): string {
  return toolName === "read_file" && input?.view === "context"
    ? "get_context"
    : toolName;
}
