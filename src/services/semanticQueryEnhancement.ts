const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "as",
  "until",
  "while",
  "of",
  "at",
  "by",
  "for",
  "with",
  "about",
  "against",
  "between",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "to",
  "from",
  "up",
  "down",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
]);

const CODE_NOISE_WORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "import",
  "export",
  "return",
  "new",
  "type",
  "interface",
  "enum",
  "struct",
  "impl",
  "def",
  "self",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "string",
  "number",
  "boolean",
  "int",
  "public",
  "private",
  "static",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "use",
  "using",
  "get",
  "set",
]);

/**
 * Extract meaningful keywords from a search query.
 * Splits CamelCase and snake_case, removes stop words and code noise.
 */
export function extractKeywords(query: string): string[] {
  const tokens: string[] = [];
  const rawWords = query.split(/[\s,;:.()[\]{}<>'"]+/).filter(Boolean);

  for (const word of rawWords) {
    const camelParts = word
      .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .filter(Boolean);
    if (camelParts.length > 1) {
      tokens.push(word);
      tokens.push(...camelParts);
    }

    const snakeParts = word.split(/[_-]/).filter(Boolean);
    if (snakeParts.length > 1) {
      tokens.push(word);
      tokens.push(...snakeParts);
    }

    if (camelParts.length <= 1 && snakeParts.length <= 1) {
      tokens.push(word);
    }
  }

  const seen = new Set<string>();
  return tokens.filter((token) => {
    const lower = token.toLowerCase();
    if (lower.length < 3) return false;
    if (STOP_WORDS.has(lower)) return false;
    if (CODE_NOISE_WORDS.has(lower)) return false;
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

/**
 * Expand query text for better embedding recall.
 * Adds split forms of CamelCase and snake_case terms.
 */
export function expandQuery(query: string): string {
  let expanded = query;

  const camelMatches = query.match(/[A-Z][a-z]+(?=[A-Z])|[A-Z][a-z]+/g);
  if (camelMatches && camelMatches.length > 1) {
    expanded += " " + camelMatches.join(" ");
  }

  const words = query.split(/\s+/);
  for (const word of words) {
    if (word.includes("_")) {
      expanded += " " + word.replace(/_/g, " ");
    }
  }

  return expanded;
}
