import { describe, expect, it } from "vitest";
import {
  loadRuleSchema,
  loadSkillSchema,
  readSkillResourceSchema,
} from "../shared/toolSchemas.js";

import { AGENT_INSTRUCTION_TOOL_DEFINITIONS } from "@agentlink/node-host";
import { TOOL_REGISTRY } from "../shared/toolRegistry.js";
import { z } from "zod";

// Other surfaces get these tools from the SDK. They must offer exactly the
// contract VS Code does, so the model sees the same tool everywhere.
describe("SDK skill and rule tools match VS Code's contract", () => {
  const vscodeSchemas = {
    load_skill: loadSkillSchema,
    read_skill_resource: readSkillResourceSchema,
    load_rule: loadRuleSchema,
  } as const;

  for (const [name, schema] of Object.entries(vscodeSchemas)) {
    it(name, () => {
      const { $schema: _, ...jsonSchema } = z.toJSONSchema(z.object(schema));
      const shared =
        AGENT_INSTRUCTION_TOOL_DEFINITIONS[
          name as keyof typeof AGENT_INSTRUCTION_TOOL_DEFINITIONS
        ];
      expect(shared.description).toBe(TOOL_REGISTRY[name]?.description);
      expect(shared.input_schema).toEqual(jsonSchema);
    });
  }
});
