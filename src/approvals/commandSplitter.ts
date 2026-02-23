/**
 * Split a compound shell command on &&, ||, |, ; while respecting
 * single/double quotes and backslash escapes.
 */
export function splitCompoundCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Backslash escape (skip next character)
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Quote tracking
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Only split when outside quotes
    if (!inSingle && !inDouble) {
      // && operator
      if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i += 2;
        continue;
      }

      // || operator
      if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i += 2;
        continue;
      }

      // | pipe
      if (ch === "|") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i++;
        continue;
      }

      // ; separator
      if (ch === ";") {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);

  return parts;
}
