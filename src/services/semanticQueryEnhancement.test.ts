import { describe, expect, it } from "vitest";
import { expandQuery, extractKeywords } from "./semanticQueryEnhancement.js";

describe("extractKeywords", () => {
  it("splits CamelCase identifiers in order", () => {
    expect(extractKeywords("TerminalManager")).toEqual([
      "TerminalManager",
      "Terminal",
      "Manager",
    ]);
  });

  it("splits acronym boundaries", () => {
    expect(extractKeywords("HTTPServerManager")).toEqual([
      "HTTPServerManager",
      "HTTP",
      "Server",
      "Manager",
    ]);
  });

  it("splits snake_case and kebab-case identifiers", () => {
    expect(extractKeywords("shell_integration request-handler")).toEqual([
      "shell_integration",
      "shell",
      "integration",
      "request-handler",
      "request",
      "handler",
    ]);
  });

  it("removes stop words and code noise", () => {
    expect(
      extractKeywords("how does the server function class interface work"),
    ).toEqual(["server", "work"]);
  });

  it("filters tokens shorter than three characters", () => {
    expect(extractKeywords("a to by DiffView")).toEqual([
      "DiffView",
      "Diff",
      "View",
    ]);
  });

  it("deduplicates case-insensitively while preserving first spelling", () => {
    expect(extractKeywords("server SERVER Server")).toEqual(["server"]);
  });

  it("handles punctuation around identifiers", () => {
    expect(extractKeywords("(DiffViewProvider), shell_integration.")).toEqual([
      "DiffViewProvider",
      "Diff",
      "View",
      "Provider",
      "shell_integration",
      "shell",
      "integration",
    ]);
  });

  it("preserves current mixed case and separator behavior", () => {
    expect(extractKeywords("TerminalManager_execute_command")).toEqual([
      "TerminalManager_execute_command",
      "Terminal",
      "Manager_execute_command",
      "TerminalManager",
      "execute",
      "command",
    ]);
  });

  it("handles mixed identifiers and natural language", () => {
    expect(
      extractKeywords("DiffViewProvider open diff editor approval"),
    ).toEqual([
      "DiffViewProvider",
      "Diff",
      "View",
      "Provider",
      "open",
      "editor",
      "approval",
    ]);
  });

  it("returns an empty array when every token is filtered", () => {
    expect(extractKeywords("is a the function")).toEqual([]);
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("   ")).toEqual([]);
  });
});

describe("expandQuery", () => {
  it("expands CamelCase terms exactly", () => {
    expect(expandQuery("DiffViewProvider")).toBe(
      "DiffViewProvider Diff View Provider",
    );
  });

  it("preserves current acronym expansion behavior", () => {
    expect(expandQuery("HTTPServerManager")).toBe(
      "HTTPServerManager Server Manager",
    );
  });

  it("expands snake_case terms exactly", () => {
    expect(expandQuery("shell_integration command")).toBe(
      "shell_integration command shell integration",
    );
  });

  it("preserves plain and empty queries byte-for-byte", () => {
    expect(expandQuery("search files")).toBe("search files");
    expect(expandQuery("")).toBe("");
    expect(expandQuery("   ")).toBe("   ");
  });

  it("preserves current mixed CamelCase and snake_case expansion", () => {
    expect(expandQuery("TerminalManager execute_command")).toBe(
      "TerminalManager execute_command Terminal Manager execute command",
    );
  });
});
