import { describe, expect, it } from "vitest";
import {
  readSessionExcerptSchema,
  searchSessionHistorySchema,
} from "../shared/toolSchemas.js";

import { SESSION_RECALL_TOOL_DEFINITIONS } from "@agentlink/node-host";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import { z } from "zod";

// Other surfaces get these tools from the SDK. They must offer exactly the
// contract VS Code does, so the model sees the same tool everywhere.
describe("SDK session recall tools match VS Code's contract", () => {
  const vscodeSchemas = {
    search_session_history: searchSessionHistorySchema,
    read_session_excerpt: readSessionExcerptSchema,
  } as const;

  for (const [name, schema] of Object.entries(vscodeSchemas)) {
    it(name, () => {
      const { $schema: _, ...jsonSchema } = z.toJSONSchema(z.object(schema));
      const shared =
        SESSION_RECALL_TOOL_DEFINITIONS[
          name as keyof typeof SESSION_RECALL_TOOL_DEFINITIONS
        ];
      expect(shared.description).toBe(TOOL_REGISTRY[name]?.description);
      expect(shared.input_schema).toEqual(jsonSchema);
    });
  }
});
