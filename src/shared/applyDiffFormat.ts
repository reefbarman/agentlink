export const APPLY_DIFF_SEARCH_REPLACE_FORMAT = [
  "<<<<<<< SEARCH",
  "exact content to find",
  "======= DIVIDER =======",
  "replacement content",
  ">>>>>>> REPLACE",
].join("\n");

export const APPLY_DIFF_INPUT_GRAMMAR = [
  "Use SEARCH/REPLACE blocks in this exact format:",
  APPLY_DIFF_SEARCH_REPLACE_FORMAT,
  "Use the DIVIDER marker shown above; in this form a bare ======= line is literal payload, so ordinary Git conflict hunks are representable.",
  "Marker recognition trims surrounding whitespace, and <<<<<<< SEARCH> remains a reserved compatibility spelling. If payload must contain a standalone line whose trimmed text equals <<<<<<< SEARCH, <<<<<<< SEARCH>, ======= DIVIDER =======, or >>>>>>> REPLACE, use unified-diff input with an @@ hunk and standard space/-/+ line prefixes instead; every unified hunk-body line must carry one of those prefixes.",
].join("\n");
