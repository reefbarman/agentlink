export const DEFAULT_CONFIRMATION_OPTIONS = ["Yes", "No"] as const;

export function isConfirmationOptions(
  options: unknown,
): options is [string, string] {
  return (
    Array.isArray(options) &&
    options.length === 2 &&
    typeof options[0] === "string" &&
    typeof options[1] === "string" &&
    Boolean(options[0].trim()) &&
    Boolean(options[1].trim()) &&
    options[0].trim() !== options[1].trim()
  );
}

export function getConfirmationOptions(options: unknown): [string, string] {
  if (!isConfirmationOptions(options)) {
    return [...DEFAULT_CONFIRMATION_OPTIONS];
  }
  return [options[0].trim(), options[1].trim()];
}
