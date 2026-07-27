import { describe, expect, it } from "vitest";
import { isMarkdownFile, markdownChunkFile } from "./markdownChunker.js";

import { MAX_CODE_INDEX_CHUNK_CHARS } from "./chunkQuality.js";

describe("isMarkdownFile", () => {
  it("returns true for .md files", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("/home/user/docs/guide.md")).toBe(true);
  });

  it("returns true for .mdx and .markdown", () => {
    expect(isMarkdownFile("page.mdx")).toBe(true);
    expect(isMarkdownFile("notes.markdown")).toBe(true);
  });

  it("returns false for non-markdown files", () => {
    expect(isMarkdownFile("file.ts")).toBe(false);
    expect(isMarkdownFile("file.txt")).toBe(false);
    expect(isMarkdownFile("file.json")).toBe(false);
  });
});

describe("markdownChunkFile", () => {
  const fp = "/workspace/README.md";
  const rp = "README.md";

  it("returns empty for empty content", () => {
    expect(markdownChunkFile("", fp, rp)).toEqual([]);
  });

  it("returns empty for very short content", () => {
    expect(markdownChunkFile("hello", fp, rp)).toEqual([]);
  });

  it("splits at heading boundaries", () => {
    const content = [
      "# Introduction",
      "",
      "This is the introduction section with enough content to pass the minimum threshold.",
      "",
      "## Installation",
      "",
      "Run npm install to get started with the project. Make sure you have Node.js installed.",
      "",
      "## Usage",
      "",
      "Import the module and call the main function to get started with the application.",
    ].join("\n");

    const chunks = markdownChunkFile(content, fp, rp);
    expect(chunks.length).toBe(3);

    // First chunk is the intro section
    expect(chunks[0].content).toContain("Introduction");
    expect(chunks[0].startLine).toBe(1);

    // Second chunk is installation
    expect(chunks[1].content).toContain("Installation");
    expect(chunks[1].startLine).toBe(5);

    // Third chunk is usage
    expect(chunks[2].content).toContain("Usage");
    expect(chunks[2].startLine).toBe(9);
  });

  it("includes normalized file path and heading context in embeddingContent", () => {
    const content =
      "# Title\n\nSome content that is long enough to pass the minimum character threshold for chunks.";
    const chunks = markdownChunkFile(content, fp, rp);
    expect(chunks.length).toBe(1);
    expect(chunks[0].embeddingContent).toBe(
      [
        "// README.md",
        "// # Title",
        "Some content that is long enough to pass the minimum character threshold for chunks.",
      ].join("\n"),
    );
  });

  it("includes heading context in embeddingContent", () => {
    const content = [
      "# Main Title",
      "",
      "This is some content under the main title that should be long enough.",
      "",
      "## Sub Section",
      "",
      "This is the sub section content that should also be long enough to pass the threshold.",
    ].join("\n");

    const chunks = markdownChunkFile(content, fp, rp);
    expect(chunks.length).toBe(2);

    // First chunk has the H1 heading context
    expect(chunks[0].embeddingContent).toContain("// # Main Title");

    // Second chunk preserves the full heading hierarchy without duplicating H2.
    expect(chunks[1].scope).toEqual(["# Main Title", "## Sub Section"]);
    expect(chunks[1].embeddingContent).toContain(
      "// # Main Title > ## Sub Section",
    );
    expect(chunks[1].embeddingContent!.match(/## Sub Section/g)).toHaveLength(
      1,
    );
    expect(chunks[1].content).toContain("## Sub Section");
  });

  it("handles pre-heading content", () => {
    const content = [
      "Some preamble text that appears before any heading. It should be long enough to be a chunk.",
      "",
      "# First Heading",
      "",
      "Content under the first heading that is long enough to pass the minimum threshold.",
    ].join("\n");

    const chunks = markdownChunkFile(content, fp, rp);
    expect(chunks.length).toBe(2);

    // Pre-heading chunk has path context but no fabricated heading.
    expect(chunks[0].content).toContain("preamble");
    expect(chunks[0].embeddingContent).toContain("// README.md");
    expect(chunks[0].embeddingContent).not.toContain("// #");

    // Heading chunk has heading context
    expect(chunks[1].embeddingContent).toContain("// # First Heading");
  });

  it("splits oversized sections at paragraph boundaries", () => {
    // Create a section that exceeds 1150 chars
    const longParagraph1 = "A".repeat(600);
    const longParagraph2 = "B".repeat(600);
    const content = [
      "# Big Section",
      "",
      longParagraph1,
      "",
      longParagraph2,
    ].join("\n");

    const chunks = markdownChunkFile(content, fp, rp);
    expect(chunks.length).toBe(2);

    // Each sub-chunk still has the heading context
    expect(chunks[0].embeddingContent).toContain("// # Big Section");
    expect(chunks[1].embeddingContent).toContain("// # Big Section");
  });

  it("hard-splits a giant Markdown line while retaining heading hierarchy", () => {
    const giantLine = "x".repeat(MAX_CODE_INDEX_CHUNK_CHARS * 2 + 1);
    const content = ["# Guide", "", "## Installation", "", giantLine].join(
      "\n",
    );

    const chunks = markdownChunkFile(
      content,
      "/workspace/docs/guide.md",
      "docs/guide.md",
    );
    const giantParts = chunks.filter((chunk) => chunk.startLine === 5);

    expect(giantParts).toHaveLength(3);
    expect(giantParts.map((chunk) => chunk.content).join("")).toBe(giantLine);
    expect(
      giantParts.every(
        (chunk) =>
          chunk.endLine === 5 &&
          chunk.content.length <= MAX_CODE_INDEX_CHUNK_CHARS &&
          chunk.language === "markdown" &&
          chunk.embeddingContent?.startsWith(
            "// docs/guide.md\n// # Guide > ## Installation\n",
          ),
      ),
    ).toBe(true);
  });

  it("sets correct line numbers", () => {
    const content = [
      "# Section One", // L1
      "", // L2
      "Content one that is long enough to pass the minimum character threshold easily.", // L3
      "", // L4
      "## Section Two", // L5
      "", // L6
      "Content two that is also long enough to pass the minimum character threshold here.", // L7
    ].join("\n");

    const chunks = markdownChunkFile(content, fp, rp);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[1].startLine).toBe(5);
  });
});
