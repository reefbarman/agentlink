import { describe, expect, it } from "vitest";
import {
  getPermittedReadFileViews,
  getReadFileOperationName,
  resolveReadFileView,
} from "./readFileViews.js";

describe("read_file views", () => {
  it("derives permitted views from the underlying operation grants", () => {
    expect(getPermittedReadFileViews(() => true)).toEqual([
      "content",
      "context",
    ]);
    expect(getPermittedReadFileViews((op) => op === "read_file")).toEqual([
      "content",
    ]);
    expect(getPermittedReadFileViews((op) => op === "get_context")).toEqual([
      "context",
    ]);
    expect(getPermittedReadFileViews(() => false)).toEqual([]);
  });

  it("defaults to content and strips view from the operation input", () => {
    expect(
      resolveReadFileView({ path: "a.ts", anchor: "x" }, ["content"]),
    ).toEqual({
      ok: true,
      view: "content",
      operation: "read_file",
      input: { path: "a.ts", anchor: "x" },
    });
    expect(
      resolveReadFileView(
        { path: "a.ts", view: "context", dedupe_unchanged_content: true },
        ["content", "context"],
      ),
    ).toEqual({
      ok: true,
      view: "context",
      operation: "get_context",
      input: { path: "a.ts", dedupe_unchanged_content: true },
    });
  });

  it("never falls back to another view when the omitted default is not permitted", () => {
    expect(resolveReadFileView({ path: "a.ts" }, ["context"])).toMatchObject({
      ok: false,
      status: "read_view_not_permitted",
    });
    expect(
      resolveReadFileView({ path: "a.ts", view: "context" }, ["content"]),
    ).toMatchObject({ ok: false, status: "read_view_not_permitted" });
  });

  it("rejects unknown views and options belonging to the other view", () => {
    expect(
      resolveReadFileView({ path: "a.ts", view: "raw" }, ["content"]),
    ).toMatchObject({ ok: false, status: "invalid_read_view" });
    expect(
      resolveReadFileView({ path: "a.ts", view: "context", anchor: "x" }, [
        "content",
        "context",
      ]),
    ).toMatchObject({ ok: false, status: "read_view_option_mismatch" });
    expect(
      resolveReadFileView({ path: "a.ts", refresh: true }, [
        "content",
        "context",
      ]),
    ).toMatchObject({ ok: false, status: "read_view_option_mismatch" });
  });

  it("names the internal operation used for name-keyed budgets", () => {
    expect(getReadFileOperationName("read_file", { view: "context" })).toBe(
      "get_context",
    );
    expect(getReadFileOperationName("read_file", {})).toBe("read_file");
    expect(getReadFileOperationName("search_files", { view: "context" })).toBe(
      "search_files",
    );
  });
});
