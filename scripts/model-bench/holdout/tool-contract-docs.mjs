import { check, expectEqual, finish, firstFailure } from "./check.mjs";

await check("registry-include-tags", async () => {
  const { getTool } = await import("../src/toolRegistry.js");
  const parameter = getTool("summarize_note")?.parameters?.includeTags;
  if (!parameter) return "summarize_note has no includeTags parameter";
  return firstFailure(
    expectEqual(parameter.type, "boolean", "includeTags.type"),
    expectEqual(parameter.required, false, "includeTags.required"),
  );
});

await check("registry-existing-parameters-preserved", async () => {
  const { getTool } = await import("../src/toolRegistry.js");
  const parameters = getTool("summarize_note")?.parameters ?? {};
  return firstFailure(
    expectEqual(parameters.noteId?.type, "string", "noteId.type"),
    expectEqual(parameters.noteId?.required, true, "noteId.required"),
    expectEqual(parameters.maxWords?.type, "number", "maxWords.type"),
    expectEqual(parameters.maxWords?.required, false, "maxWords.required"),
  );
});

finish();
