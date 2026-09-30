/**
 * Surface-neutral selection and formatting for diagnostics introduced by an
 * edit. Callers supply error diagnostics only; lines are 0-based.
 */
export interface DiagnosticEntry {
  line: number;
  message: string;
}

export interface LabeledDiagnosticEntry extends DiagnosticEntry {
  /** Workspace-relative label for diagnostics outside the edited file. */
  path?: string;
}

/**
 * Line correspondence between the pre-edit and post-edit text, derived from
 * their common leading and trailing lines. Lines between the prefix and the
 * suffix form the edited region.
 */
export interface LineMapping {
  prefixLines: number;
  oldChangedEnd: number;
  newChangedEnd: number;
  lineDelta: number;
}

export const MAX_REPORTED_DIAGNOSTICS = 20;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 240;
export const MAX_DIAGNOSTICS_OUTPUT_CHARS = 4_000;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function computeLineMapping(
  baseline: string,
  final: string,
): LineMapping {
  const oldLines = splitLines(baseline);
  const newLines = splitLines(final);
  const shorter = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    prefixLines: prefix,
    oldChangedEnd: oldLines.length - suffix,
    newChangedEnd: newLines.length - suffix,
    lineDelta: newLines.length - oldLines.length,
  };
}

function mapBaselineLine(
  line: number,
  mapping: LineMapping | undefined,
): number | undefined {
  if (!mapping || line < mapping.prefixLines) return line;
  if (line >= mapping.oldChangedEnd) return line + mapping.lineDelta;
  return undefined;
}

function isEditedLine(line: number, mapping: LineMapping): boolean {
  // A pure deletion has an empty new region; keep the join line in scope.
  return (
    line >= mapping.prefixLines &&
    line < Math.max(mapping.newChangedEnd, mapping.prefixLines + 1)
  );
}

function take(pool: Map<string, number>, key: string): boolean {
  const count = pool.get(key) ?? 0;
  if (count === 0) return false;
  pool.set(key, count - 1);
  return true;
}

function add(pool: Map<string, number>, key: string): void {
  pool.set(key, (pool.get(key) ?? 0) + 1);
}

/**
 * Select the current diagnostics that the edit introduced.
 *
 * With a baseline, a current diagnostic is pre-existing when a baseline
 * diagnostic with the same message maps to its line (unchanged lines follow
 * the edit's line shift), or when it sits in the edited region and a baseline
 * diagnostic with the same message sat in the replaced region.
 *
 * Without a baseline (`baseline: undefined`, typically a file no language
 * server had diagnosed before the edit), only diagnostics on edited lines are
 * reported; the rest are counted as `unbaselinedOmitted`.
 */
export function selectIntroducedDiagnostics(options: {
  baseline: readonly DiagnosticEntry[] | undefined;
  current: readonly DiagnosticEntry[];
  mapping?: LineMapping;
}): { introduced: DiagnosticEntry[]; unbaselinedOmitted: number } {
  const { baseline, current, mapping } = options;
  if (!baseline) {
    if (!mapping) return { introduced: [...current], unbaselinedOmitted: 0 };
    const introduced = current.filter((entry) =>
      isEditedLine(entry.line, mapping),
    );
    return {
      introduced,
      unbaselinedOmitted: current.length - introduced.length,
    };
  }

  const mapped = new Map<string, number>();
  const replaced = new Map<string, number>();
  for (const entry of baseline) {
    const line = mapBaselineLine(entry.line, mapping);
    if (line === undefined) add(replaced, entry.message);
    else add(mapped, `${line}\u0000${entry.message}`);
  }

  const introduced = current.filter((entry) => {
    if (take(mapped, `${entry.line}\u0000${entry.message}`)) return false;
    if (
      mapping &&
      isEditedLine(entry.line, mapping) &&
      take(replaced, entry.message)
    ) {
      return false;
    }
    return true;
  });
  return { introduced, unbaselinedOmitted: 0 };
}

function formatMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
    ? `${singleLine.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS - 1)}…`
    : singleLine;
}

/**
 * Render introduced error diagnostics as bounded text: at most
 * MAX_REPORTED_DIAGNOSTICS entries and roughly MAX_DIAGNOSTICS_OUTPUT_CHARS,
 * followed by an omitted-count summary.
 */
export function formatIntroducedDiagnostics(
  entries: readonly LabeledDiagnosticEntry[],
  unbaselinedOmitted = 0,
): string | undefined {
  const lines: string[] = [];
  let chars = 0;
  for (const entry of entries) {
    if (lines.length >= MAX_REPORTED_DIAGNOSTICS) break;
    const location = entry.path
      ? `${entry.path}: Line ${entry.line + 1}`
      : `Line ${entry.line + 1}`;
    const line = `${location}: ${formatMessage(entry.message)}`;
    if (lines.length > 0 && chars + line.length > MAX_DIAGNOSTICS_OUTPUT_CHARS)
      break;
    lines.push(line);
    chars += line.length + 1;
  }
  const hidden = entries.length - lines.length;
  if (hidden > 0) {
    lines.push(
      `… ${hidden} more new error diagnostic${hidden === 1 ? "" : "s"} not shown (${entries.length} total). Use get_diagnostics to inspect them.`,
    );
  }
  if (unbaselinedOmitted > 0) {
    lines.push(
      `${unbaselinedOmitted} error diagnostic${unbaselinedOmitted === 1 ? "" : "s"} outside the edited lines not reported: this file had no pre-edit diagnostics baseline, so they are likely pre-existing.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
