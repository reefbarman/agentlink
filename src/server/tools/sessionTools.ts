import { handleHandshake } from "../../tools/handshake.js";
import { handshakeSchema } from "../../shared/toolSchemas.js";
import type { ToolRegistrationContext } from "./types.js";
import type { TrustGate } from "../registerTools.js";

export function registerSessionTools(
  ctx: ToolRegistrationContext,
  trust: TrustGate,
  log: (msg: string) => void,
): void {
  const { server, tracker, sid, touch, desc } = ctx;

  server.registerTool(
    "handshake",
    {
      description: desc("handshake"),
      inputSchema: handshakeSchema,
    },
    tracker.wrapHandler(
      "handshake",
      (params) => {
        touch();
        const shortId = sid().substring(0, 12);
        return handleHandshake(params, trust.markSessionTrusted, log, shortId);
      },
      (p) =>
        Array.isArray(p.working_directories)
          ? `${(p.working_directories as string[]).length} dirs`
          : "",
      sid,
    ),
  );
}
