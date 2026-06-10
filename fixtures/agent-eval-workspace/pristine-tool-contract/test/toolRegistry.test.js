import assert from "node:assert/strict";
import { getTool } from "../src/toolRegistry.js";

const tool = getTool("summarize_note");

assert.equal(tool.parameters.noteId.required, true);
assert.equal(tool.parameters.maxWords.required, false);
assert.equal(tool.parameters.includeTags?.type, "boolean");
assert.equal(tool.parameters.includeTags?.required, false);
