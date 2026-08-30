export type FleetResultEnvelope =
  | { type: "text"; text: string }
  | {
      type: "review_findings";
      findings: Array<{
        severity: "critical" | "high" | "medium" | "low";
        message: string;
        path?: string;
        line?: number;
      }>;
      /** What was actually reviewed, e.g. a commit range or file list. */
      reviewedScope?: string;
      /** True when the requested diff was empty or missing, so an empty findings list is not a clean review. */
      emptyDiff?: boolean;
    }
  | { type: "patch"; summary: string; files: string[]; verification?: string }
  | {
      type: "verification";
      passed: boolean;
      summary: string;
      screenshots?: string[];
      logs?: string[];
    };
