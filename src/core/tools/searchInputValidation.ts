export function getSearchInputError(
  toolName: string,
  input: object,
): string | undefined {
  const params = input as Record<string, unknown>;
  const removed =
    toolName === "search_files"
      ? "semantic"
      : toolName === "read_file" || toolName === "list_files"
        ? "query"
        : undefined;
  if (removed && Object.hasOwn(params, removed)) {
    return `Unsupported parameter '${removed}' for ${toolName}.`;
  }
  if (toolName !== "search_files") return undefined;
  const hasRegex = params.regex !== undefined;
  const hasQuery = params.query !== undefined;
  if (hasRegex === hasQuery) {
    return "Supply exactly one of 'regex' or 'query' for search_files.";
  }
  if (hasRegex && typeof params.regex !== "string") {
    return "regex must be a string.";
  }
  if (hasQuery && (typeof params.query !== "string" || !params.query.trim())) {
    return "query must be a non-empty string.";
  }
  if (typeof params.path !== "string") {
    return "path must be a file or directory path.";
  }
  return undefined;
}
