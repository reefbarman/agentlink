export type TerminalTargetFailure =
  | "host_target"
  | "wrong_authority"
  | "provider_retired"
  | "ambiguous_name"
  | "not_found";

export type TerminalTargetKind = "terminal_id" | "terminal_name" | "split_from";

export type TerminalTargetAuthority = "sandbox" | "native-agent";

export interface TerminalTargetCandidate {
  readonly terminal_id: string;
  readonly terminal_name: string;
  readonly authority?: TerminalTargetAuthority;
}

export interface TerminalTargetRecoveryDetails {
  readonly failure: TerminalTargetFailure;
  readonly target_kind: TerminalTargetKind;
  readonly target_value: string;
  readonly required_authority?: TerminalTargetAuthority;
  readonly target_authorities?: readonly TerminalTargetAuthority[];
  readonly compatible_terminals?: readonly TerminalTargetCandidate[];
  readonly available_terminals?: readonly TerminalTargetCandidate[];
  readonly retry_guidance: readonly string[];
}

function formatCandidates(
  label: string,
  candidates: readonly TerminalTargetCandidate[],
): string | undefined {
  if (candidates.length === 0) return undefined;
  return `${label}: ${candidates
    .map(
      (candidate) =>
        `${candidate.terminal_id} (${candidate.terminal_name})${candidate.authority ? ` [${candidate.authority}]` : ""}`,
    )
    .join(", ")}.`;
}

export class TerminalTargetRecoveryError extends Error {
  readonly code = "terminal_target_rejected";
  readonly failure: TerminalTargetFailure;
  readonly target_kind: TerminalTargetKind;
  readonly target_value: string;
  readonly required_authority?: TerminalTargetAuthority;
  readonly target_authorities?: readonly TerminalTargetAuthority[];
  readonly compatible_terminals: readonly TerminalTargetCandidate[];
  readonly available_terminals: readonly TerminalTargetCandidate[];
  readonly retry_guidance: readonly string[];

  constructor(details: TerminalTargetRecoveryDetails) {
    const compatible = Object.freeze(
      [...(details.compatible_terminals ?? [])].map((candidate) =>
        Object.freeze({ ...candidate }),
      ),
    );
    const available = Object.freeze(
      [...(details.available_terminals ?? [])].map((candidate) =>
        Object.freeze({ ...candidate }),
      ),
    );
    const guidance = Object.freeze([...details.retry_guidance]);
    const authority = details.required_authority
      ? ` Required authority: ${details.required_authority}.`
      : "";
    const actual = details.target_authorities?.length
      ? ` Target authority: ${details.target_authorities.join(", ")}.`
      : "";
    const lines = [
      `Terminal target ${details.target_kind}="${details.target_value}" was rejected: ${details.failure.replaceAll("_", " ")}.${authority}${actual}`,
      "No terminal was retargeted and execution authority was not changed automatically.",
      formatCandidates("Compatible terminals", compatible),
      formatCandidates("Available terminals", available),
      ...guidance,
    ].filter((line): line is string => Boolean(line));
    super(lines.join(" "));
    this.name = "TerminalTargetRecoveryError";
    this.failure = details.failure;
    this.target_kind = details.target_kind;
    this.target_value = details.target_value;
    this.required_authority = details.required_authority;
    this.target_authorities = details.target_authorities
      ? Object.freeze([...details.target_authorities])
      : undefined;
    this.compatible_terminals = compatible;
    this.available_terminals = available;
    this.retry_guidance = guidance;
  }
}
