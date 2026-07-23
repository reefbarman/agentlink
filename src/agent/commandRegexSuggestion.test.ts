import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  buildCommandRegexSuggestionPrompt,
  buildRequiredGeneralizationVariants,
} from "./commandRegexSuggestion.js";

describe("command regex suggestions", () => {
  it("requires independent env values and task-name suffixes to generalize", () => {
    expect(
      buildRequiredGeneralizationVariants("TARGET=tertiary make test-go"),
    ).toEqual([
      "TARGET=agentlink-variant make test-go",
      "TARGET=tertiary make test-agentlink-variant",
      "TARGET=agentlink-variant make test-agentlink-variant",
    ]);
  });

  it("recognizes package-script discriminators without generalizing plain commands", () => {
    expect(buildRequiredGeneralizationVariants("npm run test-unit")).toEqual([
      "npm run test-agentlink-variant",
    ]);
    expect(buildRequiredGeneralizationVariants("git status")).toEqual([]);
  });

  it("adds relevant project command names and bounded session context", async () => {
    const rootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-regex-prompt-"),
    );
    await fs.writeFile(
      path.join(rootPath, "Makefile"),
      "test-go:\n\tgo test ./...\n\ntest-rust:\n\tcargo test\n",
    );
    const prompt = await buildCommandRegexSuggestionPrompt({
      fullCommand: "TARGET=tertiary make test-go",
      subCommand: "TARGET=tertiary make test-go",
      session: {
        projectScope: {
          displayName: "compiler",
          rootPath,
        },
        title: "Run language test matrix",
        mode: "code",
        activeFilePath: path.join(rootPath, "Makefile"),
        filesRead: new Set([path.join(rootPath, "scripts/test.ts")]),
        getAllMessages: () => [
          { role: "user", content: "Please test each supported language" },
        ],
      } as never,
    });

    expect(prompt.userPrompt).toContain(
      "TARGET=tertiary make test-agentlink-variant",
    );
    expect(prompt.userPrompt).toContain(
      "Project command names: test-go, test-rust",
    );
    expect(prompt.userPrompt).toContain(
      "user: Please test each supported language",
    );
    expect(prompt.systemPrompt).toContain(
      "Do not stop after generalizing only the first variable token",
    );
  });
});
