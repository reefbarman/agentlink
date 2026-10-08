import { z } from "zod";

const artifactPath = z
  .string()
  .min(1)
  .regex(
    /^(?![\\/])(?![a-zA-Z]:[\\/])(?![\s\S]*(?:^|[\\/])\.\.(?:[\\/]|$))/,
    "Use a non-empty workspace-relative path without '..' segments",
  )
  .describe("Non-empty workspace-relative path without '..' segments");

const emptyDiff = z
  .boolean()
  .describe(
    "Set true when the requested live diff or range is empty or unavailable; the runtime attributes the normalized target automatically.",
  );

export function isWorkspaceRelativeArtifact(value: string): boolean {
  return artifactPath.safeParse(value).success;
}

/** Shared by advertised tool schemas and result validation. Keep legacy extra fields. */
export const fleetResultSchemas = {
  text: z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  review_findings: z
    .object({
      type: z.literal("review_findings"),
      findings: z.array(
        z
          .object({
            severity: z.enum(["critical", "high", "medium", "low"]),
            message: z.string(),
            path: artifactPath.optional(),
            line: z.number().int().positive().optional(),
          })
          .passthrough(),
      ),
      reviewedScope: z
        .string()
        .describe(
          "Optional override when the reviewed scope materially differs from the runtime target",
        )
        .optional(),
      emptyDiff: emptyDiff.optional(),
    })
    .passthrough(),
  patch: z
    .object({
      type: z.literal("patch"),
      summary: z.string(),
      files: z.array(artifactPath),
      verification: z.string().optional(),
    })
    .passthrough(),
  verification: z
    .object({
      type: z.literal("verification"),
      passed: z.boolean(),
      summary: z.string(),
      screenshots: z.array(artifactPath).optional(),
      logs: z.array(z.string()).optional(),
    })
    .passthrough(),
};

export type FleetResultType = keyof typeof fleetResultSchemas;

const fleetResultSchema = z.discriminatedUnion("type", [
  fleetResultSchemas.text,
  fleetResultSchemas.review_findings,
  fleetResultSchemas.patch,
  fleetResultSchemas.verification,
]);

export function getFleetResultSchema(expected?: FleetResultType) {
  if (expected === "review_findings") {
    // Legacy persisted reviews may omit this; new expected review completions may not.
    return fleetResultSchemas.review_findings.extend({
      emptyDiff,
    });
  }
  return expected ? fleetResultSchemas[expected] : fleetResultSchema;
}

export function validateFleetResult(
  value: unknown,
  expected?: FleetResultType,
): Array<{ path: string; message: string }> {
  const parsed = getFleetResultSchema(expected).safeParse(value);
  if (parsed.success) return [];
  // Bound the response and never include submitted values or unknown key names.
  return parsed.error.issues.slice(0, 8).map((issue) => ({
    path: ["result", ...issue.path].join("."),
    message: issue.message,
  }));
}
