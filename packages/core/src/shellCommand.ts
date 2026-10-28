/**
 * VS Code's shell lexer and compound-command splitter. Pure, so browser
 * bundles can use them; the classifier built on them is
 * `@agentlink/core/command-classifier`.
 */
export * from "./commandSplitter.js";
export * from "./shellLex.js";
