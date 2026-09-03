import * as os from "node:os";

/**
 * Client identity sent to the Codex/ChatGPT backend. The `originator` header
 * and User-Agent identify AgentLink honestly (the sanctioned third-party
 * pattern; see opencode/pi/Zed/Cline). The env overrides exist for A/B
 * testing backend behavior against other originator values — they are read at
 * request-construction time, so changing them requires restarting the host
 * process they apply to.
 */
export const CODEX_ORIGINATOR_OVERRIDE_ENV_VAR = "AGENTLINK_CODEX_ORIGINATOR";
export const CODEX_USER_AGENT_OVERRIDE_ENV_VAR = "AGENTLINK_CODEX_USER_AGENT";

export const DEFAULT_CODEX_ORIGINATOR = "agentlink";

export function getCodexOriginator(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[CODEX_ORIGINATOR_OVERRIDE_ENV_VAR]?.trim();
  return override || DEFAULT_CODEX_ORIGINATOR;
}

/**
 * Default User-Agent derives its product token from the effective originator
 * so a lone AGENTLINK_CODEX_ORIGINATOR override keeps the pair consistent,
 * mirroring the official client's `{originator}/{version} (...)` shape.
 */
export function getCodexUserAgent(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[CODEX_USER_AGENT_OVERRIDE_ENV_VAR]?.trim();
  if (override) return override;
  return `${getCodexOriginator(env)}/1.0 (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`;
}
