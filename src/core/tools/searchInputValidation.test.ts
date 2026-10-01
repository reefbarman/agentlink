import { describe, expect, it } from "vitest";

import { getSearchInputError } from "./searchInputValidation.js";

describe("search input contract", () => {
  it.each([
    { path: "." },
    { path: ".", regex: "needle", query: "where is the needle" },
    { path: ".", regex: 5 },
    { path: ".", query: " " },
  ])("rejects invalid search input %j", (input) => {
    expect(getSearchInputError("search_files", input)).toBeTypeOf("string");
  });

  it.each([true, false, undefined])(
    "rejects the removed semantic flag (%s)",
    (semantic) => {
      expect(
        getSearchInputError("search_files", {
          path: ".",
          regex: "needle",
          semantic,
        }),
      ).toContain("Unsupported parameter 'semantic'");
    },
  );

  it.each(["read_file", "list_files"])(
    "rejects removed query on %s",
    (name) => {
      expect(
        getSearchInputError(name, { path: ".", query: "needle" }),
      ).toContain("Unsupported parameter 'query'");
    },
  );

  it.each([
    { path: ".", regex: "" },
    { path: "src", query: "find error handling" },
  ])("accepts the new contract %j", (input) => {
    expect(getSearchInputError("search_files", input)).toBeUndefined();
  });
});
