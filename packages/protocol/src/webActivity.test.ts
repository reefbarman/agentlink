import type {
  CoreWebAccessBackend,
  CoreWebActivity,
  CoreWebActivityStatus,
  CoreWebCitation,
  CoreWebToolKind,
} from "./webActivity.js";
import { expect, expectTypeOf, it } from "vitest";

it("pins web activity transport contracts", () => {
  expectTypeOf<CoreWebAccessBackend>().toEqualTypeOf<
    "provider" | "mcp" | "mixed" | "disabled"
  >();
  expectTypeOf<CoreWebToolKind>().toEqualTypeOf<"search" | "fetch">();
  expectTypeOf<CoreWebActivityStatus>().toEqualTypeOf<
    "started" | "completed" | "failed"
  >();
  expectTypeOf<CoreWebCitation>().toEqualTypeOf<{
    url: string;
    title?: string;
    citedText?: string;
    startIndex?: number;
    endIndex?: number;
  }>();
  expectTypeOf<CoreWebActivity>().toEqualTypeOf<{
    id: string;
    kind: CoreWebToolKind;
    status: CoreWebActivityStatus;
    backend: "provider" | "mcp" | "mixed";
    query?: string;
    url?: string;
    citations?: CoreWebCitation[];
    error?: string;
  }>();
});

it("keeps web activity transport serializable across surfaces", () => {
  const value: CoreWebActivity = {
    id: "activity-1",
    kind: "search",
    status: "completed",
    backend: "provider",
    query: "AgentLink protocol",
    citations: [
      {
        url: "https://example.com/agentlink",
        title: "AgentLink",
        citedText: "Browser-safe protocol contracts",
        startIndex: 0,
        endIndex: 31,
      },
    ],
  };

  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
