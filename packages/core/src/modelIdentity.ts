/** Minimum explicit scope required on every public agent operation. */
export interface AgentPrincipal {
  readonly tenantId: string;
  readonly subjectId: string;
}

/** Stable public model identity. Bare model IDs remain a legacy runtime concern. */
export interface AgentModelReference {
  readonly providerId: string;
  readonly modelId: string;
}
