import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

/** Which credential source the client was created from. */
export type AuthSource =
  | "explicit"
  | "env-api-key"
  | "env-oauth-token"
  | "cli-credentials";

export function readClaudeCliCredentials(): string | undefined {
  try {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = fs.readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw);
    const o = parsed.claudeAiOauth;
    if (typeof o === "string") return o;
    if (o && typeof o === "object")
      return o.token ?? o.accessToken ?? o.access_token;
  } catch {
    // not found or malformed
  }
  return undefined;
}

/**
 * Run `claude auth status` to trigger a token refresh, then verify
 * the result indicates a logged-in state. Returns true if refresh succeeded.
 */
export function refreshClaudeCredentials(log?: (msg: string) => void): boolean {
  const logLine = log ?? console.log;
  try {
    logLine("[auth] running `claude auth status` to refresh credentials...");
    const output = execFileSync("claude", ["auth", "status"], {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    logLine(`[auth] claude auth status output: ${output.trim()}`);
    const parsed = JSON.parse(output.trim());
    if (parsed.loggedIn === true) {
      logLine("[auth] credential refresh successful — logged in");
      return true;
    }
    logLine("[auth] credential refresh failed — not logged in");
    return false;
  } catch (err) {
    logLine(`[auth] credential refresh failed: ${err}`);
    return false;
  }
}

/**
 * Create an Anthropic client with correct auth for the resolved credential.
 *
 * Resolution order:
 *   1. explicitApiKey parameter → x-api-key, api.anthropic.com
 *   2. ANTHROPIC_API_KEY env var → x-api-key, api.anthropic.com
 *   3. CLAUDE_CODE_OAUTH_TOKEN env var → Bearer, api.claude.ai
 *   4. ~/.claude/.credentials.json claudeAiOauth → Bearer, api.claude.ai
 *
 * Throws if no credential is found.
 */
export function createAnthropicClient(
  explicitApiKey?: string,
  log?: (msg: string) => void,
): { client: Anthropic; authSource: AuthSource } {
  const logLine = log ?? console.log;

  if (explicitApiKey) {
    logLine("[auth] using explicit API key");
    return {
      client: new Anthropic({ apiKey: explicitApiKey }),
      authSource: "explicit",
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    logLine("[auth] using ANTHROPIC_API_KEY env var");
    return {
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
      authSource: "env-api-key",
    };
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    logLine("[auth] using CLAUDE_CODE_OAUTH_TOKEN env var (Bearer)");
    return {
      client: new Anthropic({
        authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      }),
      authSource: "env-oauth-token",
    };
  }

  const credToken = readClaudeCliCredentials();
  if (credToken) {
    logLine("[auth] using ~/.claude/.credentials.json (apiKey)");
    return {
      client: new Anthropic({ apiKey: credToken }),
      authSource: "cli-credentials",
    };
  }

  throw new Error(
    "No Anthropic API key found. Set ANTHROPIC_API_KEY, run `claude login`, or configure a key in settings.",
  );
}
