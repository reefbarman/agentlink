import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { writeFileAtomic } from "./atomicFile.js";
import {
  alwaysAskReason,
  GuardError,
  normaliseAlwaysAskPatterns,
  normaliseArgumentRules,
  type McpArgumentRules,
} from "./mcpToolGuard.js";

/**
 * The owner's remote MCP servers (streamable HTTP over HTTPS), kept by the
 * assistant server and called only by it: chats and task sessions reach
 * them through `call_mcp_tool`, never directly, and no token leaves this
 * process.
 *
 * - `<dataRoot>/mcp/servers.json`: each server's address, how it signs in,
 *   status, and its tools with their schema hash and the owner's policy
 *   (`ask`, the default for every new or changed tool; `run`, optionally
 *   only for some argument values; `off`), and the owner's extra
 *   always-ask patterns. Tools on the always-ask list (`mcpToolGuard.ts`)
 *   can never be on Run.
 * - `<dataRoot>/credentials/mcp/secrets.json`: header secrets and OAuth
 *   clients and tokens, AES-256-GCM under `credentials/mcp/key`.
 *
 * A server is reached only at its saved host (HTTPS, no loopback); OAuth
 * discovery and token requests may also go to other public HTTPS hosts.
 */

export const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const MAX_SERVERS = 20;
const MAX_TOOLS = 100;
const MAX_RESULT_CHARS = 100_000;
const CALL_TIMEOUT_MS = 60_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

export type McpToolPolicy = "ask" | "run" | "off";
export type McpAuthKind = "none" | "header" | "oauth";
export type McpServerStatus = "untested" | "ok" | "error" | "signed_out";

export interface McpToolRecord {
  readonly name: string;
  readonly description: string;
  /** The server's hint only: never used to skip asking. */
  readonly readOnlyHint?: boolean;
  /** The server's hint: puts the tool on the always-ask list. */
  readonly destructiveHint?: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** SHA-256 of the description, input schema and annotations. */
  readonly schemaHash: string;
  readonly policy: McpToolPolicy;
  /** With `run`: only calls whose named arguments match run; others ask. */
  readonly runWhen?: McpArgumentRules;
}

export interface McpServerRecord {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly auth: McpAuthKind;
  /** For `header`: the header's name (its value is a secret). */
  readonly headerName?: string;
  /** The owner can turn a server off without removing it. */
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  /** What went wrong, in plain words (status `error` or `signed_out`). */
  readonly error?: string;
  readonly testedAt?: number;
  readonly tools: readonly McpToolRecord[];
  /** Who added it; a chat's proposal says what it is for. */
  readonly origin: "owner" | "chat";
  readonly purpose?: string;
  readonly createdAt: number;
  /**
   * On the owner's network (Home Assistant, a NAS): a private address or
   * LAN name over HTTP(S), reached only at its saved host and port, never
   * with OAuth. Only tools that read can be on Run, and only the owner's
   * own chats are offered it.
   */
  readonly network?: true;
}

export interface NewMcpServer {
  readonly label: string;
  readonly url: string;
  readonly auth: McpAuthKind;
  readonly headerName?: string;
  readonly headerValue?: string;
  readonly origin?: "owner" | "chat";
  readonly purpose?: string;
  /** The owner ticked "On my network": a private address is accepted. */
  readonly network?: boolean;
}

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** What a refresh changed: tools put back on Ask, and tools removed. */
export interface McpRefreshResult {
  readonly server: McpServerRecord;
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface McpRegistry {
  list(): readonly McpServerRecord[];
  get(id: string): McpServerRecord | undefined;
  add(server: NewMcpServer, at?: number): Promise<McpServerRecord>;
  remove(id: string): Promise<boolean>;
  update(
    id: string,
    patch: { readonly enabled?: boolean; readonly label?: string },
  ): Promise<McpServerRecord>;
  /**
   * Set a tool's policy. `runWhen` (with `run` only) limits Run to calls
   * whose named arguments match; without it Run covers every call.
   */
  setPolicy(
    id: string,
    tool: string,
    policy: McpToolPolicy,
    runWhen?: McpArgumentRules,
  ): Promise<McpServerRecord>;
  /** The owner's extra always-ask patterns. */
  alwaysAsk(): readonly string[];
  /** Replace them; tools they now cover go back to Ask. */
  setAlwaysAsk(patterns: readonly string[]): Promise<readonly string[]>;
  /** Why a tool can never be on Run, or `undefined`. */
  runRefusal(id: string, tool: string): string | undefined;
  /** Connect, list the tools, and record status and schema changes. */
  refresh(id: string): Promise<McpRefreshResult>;
  /** Start OAuth: the address to open, or signed in already. */
  beginSignIn(
    id: string,
  ): Promise<
    | { readonly kind: "redirect"; readonly authorizationUrl: string }
    | { readonly kind: "signed_in" }
  >;
  /** Finish OAuth from the callback's `state` and `code`. */
  finishSignIn(state: string, code: string): Promise<McpServerRecord>;
  call(
    id: string,
    tool: string,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<{ readonly text: string; readonly isError: boolean }>;
  /** Whether the server has a stored secret or OAuth tokens (not what). */
  hasCredentials(id: string): boolean;
}

/** For tests: how to reach a server instead of HTTPS. */
export type McpTransportFactory = (
  server: McpServerRecord,
  options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly authProvider?: OAuthClientProvider;
  },
) => Transport;

interface SecretState {
  headers: Record<string, string>;
  oauth: Record<
    string,
    { client?: OAuthClientInformationMixed; tokens?: OAuthTokens }
  >;
}

interface PendingSignIn {
  readonly serverId: string;
  readonly codeVerifier: string;
  readonly expiresAt: number;
}

export async function openMcpRegistry(options: {
  readonly dataRoot: string;
  /** Where OAuth providers send the owner back (on this server's origin). */
  readonly redirectUrl: string;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly createTransport?: McpTransportFactory;
}): Promise<McpRegistry> {
  const now = options.now ?? Date.now;
  const serversFile = path.join(options.dataRoot, "mcp", "servers.json");
  const secretsDirectory = path.join(options.dataRoot, "credentials", "mcp");
  const secretsFile = path.join(secretsDirectory, "secrets.json");
  const key = await readOrCreateKey(path.join(secretsDirectory, "key"));
  const stored = await readServers(serversFile);
  let alwaysAsk: readonly string[] = stored.alwaysAsk;
  // A tool the always-ask list now covers (a newer list, or a hand edit)
  // goes back to Ask before anything can call it.
  const refusal = (server: McpServerRecord, tool: McpToolRecord) =>
    alwaysAskReason(server.id, tool, alwaysAsk, {
      network: server.network === true,
    });
  const guarded = (server: McpServerRecord): McpServerRecord => {
    if (
      !server.tools.some(
        (tool) => tool.policy === "run" && refusal(server, tool) !== undefined,
      )
    ) {
      return server;
    }
    return {
      ...server,
      tools: server.tools.map((tool) =>
        tool.policy === "run" && refusal(server, tool) ? onAsk(tool) : tool,
      ),
    };
  };
  let servers = stored.servers.map(guarded);
  let secrets = await readSecrets(secretsFile, key);
  const pending = new Map<string, PendingSignIn>();
  let writes: Promise<void> = Promise.resolve();

  const persist = () => {
    const snapshot = JSON.stringify({ schemaVersion: 1, servers, alwaysAsk });
    const sealed = seal(key, JSON.stringify(secrets));
    const next = writes.then(async () => {
      await fs.mkdir(path.dirname(serversFile), {
        recursive: true,
        mode: 0o700,
      });
      await writeFileAtomic(serversFile, `${snapshot}\n`);
      await fs.mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(secretsFile, `${sealed}\n`);
    });
    writes = next.catch(() => undefined);
    return next;
  };

  const require = (id: string) => {
    const server = servers.find((candidate) => candidate.id === id);
    if (!server) throw new McpError("mcp_server_not_found", "No such server");
    return server;
  };
  const replace = async (candidate: McpServerRecord) => {
    const next = guarded(candidate);
    servers = servers.map((server) => (server.id === next.id ? next : server));
    await persist();
    return next;
  };

  /** The OAuth provider for a server; state lives in `secrets`. */
  const oauthProvider = (
    server: McpServerRecord,
    signIn?: {
      readonly onRedirect: (url: URL) => void;
      verifier?: string;
    },
  ): OAuthClientProvider => {
    let codeVerifier = signIn?.verifier ?? "";
    const entry = () => (secrets.oauth[server.id] ??= {});
    return {
      get redirectUrl() {
        return options.redirectUrl;
      },
      clientMetadata: {
        client_name: "AgentLink Assistant",
        redirect_uris: [options.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => randomBytes(24).toString("base64url"),
      clientInformation: () => secrets.oauth[server.id]?.client,
      saveClientInformation: async (client) => {
        entry().client = client;
        await persist();
      },
      tokens: () => secrets.oauth[server.id]?.tokens,
      saveTokens: async (tokens) => {
        entry().tokens = tokens;
        await persist();
      },
      saveCodeVerifier: (verifier) => {
        codeVerifier = verifier;
      },
      codeVerifier: () => codeVerifier,
      redirectToAuthorization: (url) => {
        // Only while the owner is signing in; a call never opens a browser.
        if (!signIn) {
          throw new McpError(
            "mcp_signed_out",
            "Signed out: sign in again in the MCP panel",
          );
        }
        if (url.protocol !== "https:") {
          throw new McpError(
            "mcp_oauth_insecure",
            "The server's sign-in page is not HTTPS",
          );
        }
        const state = url.searchParams.get("state");
        if (!state) {
          throw new McpError("mcp_oauth_failed", "Sign-in gave no state");
        }
        pending.set(state, {
          serverId: server.id,
          codeVerifier,
          expiresAt: now() + SIGN_IN_TTL_MS,
        });
        signIn.onRedirect(url);
      },
      invalidateCredentials: async (scope) => {
        const current = secrets.oauth[server.id];
        if (!current) return;
        if (scope === "all" || scope === "client") delete current.client;
        if (scope === "all" || scope === "tokens") delete current.tokens;
        await persist();
      },
    };
  };

  /**
   * Only the saved host for the server itself; public HTTPS for OAuth. A
   * server on the owner's network is pinned to its saved scheme, host and
   * port, with nothing else allowed.
   */
  const fetchFor = (server: McpServerRecord): typeof globalThis.fetch => {
    const base = options.fetch ?? globalThis.fetch;
    const saved = new URL(server.url);
    const host = saved.host;
    return async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const refused = server.network
        ? url.protocol !== saved.protocol ||
          url.host !== host ||
          Boolean(url.username || url.password)
        : // An OAuth server's authorization server is often on another host.
          !isPublicHttps(url) || (url.host !== host && server.auth !== "oauth");
      if (refused) {
        throw new McpError(
          "mcp_destination_refused",
          `Refused to contact ${url.host}`,
        );
      }
      const response = await base(
        input instanceof Request ? new Request(input, init) : url,
        { ...init, redirect: "error" },
      );
      return response;
    };
  };

  const connect = async (server: McpServerRecord): Promise<Client> => {
    const headers: Record<string, string> =
      server.auth === "header" && server.headerName
        ? { [server.headerName]: secrets.headers[server.id] ?? "" }
        : {};
    const authProvider =
      server.auth === "oauth" ? oauthProvider(server) : undefined;
    const transport = options.createTransport
      ? options.createTransport(server, {
          headers,
          ...(authProvider ? { authProvider } : {}),
        })
      : new StreamableHTTPClientTransport(new URL(server.url), {
          fetch: fetchFor(server),
          requestInit: { headers },
          ...(authProvider ? { authProvider } : {}),
        });
    const client = new Client(
      { name: "agentlink-assistant", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  };

  const problem = (
    error: unknown,
  ): Pick<McpServerRecord, "status" | "error"> => {
    if (
      error instanceof UnauthorizedError ||
      (error instanceof McpError && error.code === "mcp_signed_out") ||
      /\b401\b|unauthori[sz]ed/iu.test(String(error))
    ) {
      return {
        status: "signed_out",
        error: "The server wants you to sign in (or the secret was refused).",
      };
    }
    const text = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      error: text.replace(/\s+/gu, " ").slice(0, 300) || "It did not answer",
    };
  };

  const registry: McpRegistry = {
    list: () => servers,
    get: (id) => servers.find((server) => server.id === id),
    hasCredentials: (id) =>
      Boolean(secrets.headers[id] || secrets.oauth[id]?.tokens),
    alwaysAsk: () => alwaysAsk,
    runRefusal(id, toolName) {
      const server = registry.get(id);
      const tool = server?.tools.find(
        (candidate) => candidate.name === toolName,
      );
      return server && tool ? refusal(server, tool) : undefined;
    },

    async setAlwaysAsk(patterns) {
      try {
        alwaysAsk = normaliseAlwaysAskPatterns(patterns);
      } catch (error) {
        throw guardProblem(error, "mcp_always_ask_invalid");
      }
      servers = servers.map(guarded);
      await persist();
      return alwaysAsk;
    },

    async add(input, at = now()) {
      if (servers.length >= MAX_SERVERS) {
        throw new McpError("mcp_server_limit", "Too many MCP servers");
      }
      const label = input.label.trim().replace(/\s+/gu, " ").slice(0, 60);
      if (!label) throw new McpError("mcp_label_invalid", "Name it");
      let url: URL;
      try {
        url = new URL(input.url.trim());
      } catch {
        throw new McpError("mcp_url_invalid", "That is not a web address");
      }
      const network = input.network === true;
      if (network) {
        if (!isNetworkAddress(url)) {
          throw new McpError(
            "mcp_url_invalid",
            "An address on your network must be http or https on a private address (such as 192.168.1.20:8123) or a .local, .lan or .home.arpa name, with no user name or password in it",
          );
        }
        if (input.origin === "chat") {
          throw new McpError(
            "mcp_url_invalid",
            "Only you can add a server on your network, in the MCP panel",
          );
        }
      } else if (!isPublicHttps(url)) {
        throw new McpError(
          "mcp_url_invalid",
          isNetworkAddress(url)
            ? 'That address is on your network. Tick "On my network" to add it (for example Home Assistant)'
            : "The address must be HTTPS on a public host",
        );
      }
      url.hash = "";
      if (!["none", "header", "oauth"].includes(input.auth)) {
        throw new McpError("mcp_auth_invalid", "Unknown sign-in kind");
      }
      if (network && input.auth === "oauth") {
        throw new McpError(
          "mcp_auth_invalid",
          "A server on your network signs in with a token in a header, or none",
        );
      }
      if (input.auth === "header") {
        if (!input.headerName || !HEADER_NAME_PATTERN.test(input.headerName)) {
          throw new McpError("mcp_header_invalid", "Name the header");
        }
        if (!input.headerValue || /[\r\n]/u.test(input.headerValue)) {
          throw new McpError("mcp_header_invalid", "Give the header's value");
        }
      }
      const base =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .replace(/^[^a-z]+/u, "")
          .slice(0, 30) || "server";
      let id = base;
      for (let n = 2; servers.some((server) => server.id === id); n += 1) {
        id = `${base}-${n}`;
      }
      const record: McpServerRecord = {
        id,
        label,
        url: url.href,
        auth: input.auth,
        ...(input.auth === "header" ? { headerName: input.headerName! } : {}),
        enabled: true,
        status: "untested",
        tools: [],
        origin: input.origin ?? "owner",
        ...(input.purpose
          ? { purpose: input.purpose.trim().slice(0, 300) }
          : {}),
        createdAt: at,
        ...(network ? { network: true as const } : {}),
      };
      if (input.auth === "header") secrets.headers[id] = input.headerValue!;
      servers = [...servers, record];
      await persist();
      return record;
    },

    async remove(id) {
      if (!servers.some((server) => server.id === id)) return false;
      servers = servers.filter((server) => server.id !== id);
      delete secrets.headers[id];
      delete secrets.oauth[id];
      for (const [state, entry] of pending) {
        if (entry.serverId === id) pending.delete(state);
      }
      await persist();
      return true;
    },

    async update(id, patch) {
      const server = require(id);
      const label = patch.label?.trim().replace(/\s+/gu, " ").slice(0, 60);
      return await replace({
        ...server,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(label ? { label } : {}),
      });
    },

    async setPolicy(id, toolName, policy, runWhen) {
      const server = require(id);
      if (!["ask", "run", "off"].includes(policy)) {
        throw new McpError("mcp_policy_invalid", "Ask, Run or Off");
      }
      const target = server.tools.find((tool) => tool.name === toolName);
      if (!target) throw new McpError("mcp_tool_not_found", "No such tool");
      if (policy === "run") {
        const refused = refusal(server, target);
        if (refused) {
          throw new McpError(
            "mcp_run_refused",
            `"${toolName}" always asks, because ${refused}`,
          );
        }
      }
      if (runWhen !== undefined && policy !== "run") {
        throw new McpError(
          "mcp_rule_invalid",
          "Argument rules only apply to Run",
        );
      }
      let rules: Record<string, string[]> | undefined;
      if (runWhen !== undefined) {
        try {
          rules = normaliseArgumentRules(target.inputSchema, runWhen);
        } catch (error) {
          throw guardProblem(error, "mcp_rule_invalid");
        }
      }
      return await replace({
        ...server,
        tools: server.tools.map((tool) => {
          if (tool.name !== toolName) return tool;
          const { runWhen: _previous, ...rest } = tool;
          return { ...rest, policy, ...(rules ? { runWhen: rules } : {}) };
        }),
      });
    },

    async refresh(id) {
      const server = require(id);
      let listed;
      try {
        const client = await connect(server);
        try {
          listed = (await client.listTools()).tools;
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (error) {
        const next = await replace({
          ...server,
          ...problem(error),
          testedAt: now(),
        });
        return { server: next, changed: [], added: [], removed: [] };
      }
      const previous = new Map(server.tools.map((tool) => [tool.name, tool]));
      const changed: string[] = [];
      const added: string[] = [];
      const tools: McpToolRecord[] = listed.slice(0, MAX_TOOLS).map((tool) => {
        const inputSchema =
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} };
        const description = (tool.description ?? "").slice(0, 2_000);
        const schemaHash = hashTool({
          description,
          inputSchema,
          annotations: tool.annotations ?? null,
        });
        const before = previous.get(tool.name);
        // New and changed tools ask, without argument rules; Off stays off.
        let policy: McpToolPolicy = "ask";
        let runWhen: McpArgumentRules | undefined;
        if (!before) added.push(tool.name);
        else if (before.schemaHash !== schemaHash) {
          changed.push(tool.name);
          policy = before.policy === "off" ? "off" : "ask";
        } else {
          policy = before.policy;
          runWhen = before.runWhen;
        }
        return {
          name: tool.name,
          description,
          ...(tool.annotations?.readOnlyHint !== undefined
            ? { readOnlyHint: tool.annotations.readOnlyHint }
            : {}),
          ...(tool.annotations?.destructiveHint !== undefined
            ? { destructiveHint: tool.annotations.destructiveHint }
            : {}),
          inputSchema,
          schemaHash,
          policy,
          ...(runWhen ? { runWhen } : {}),
        };
      });
      const names = new Set(tools.map((tool) => tool.name));
      const removed = server.tools
        .filter((tool) => !names.has(tool.name))
        .map((tool) => tool.name);
      const { error: _error, ...rest } = server;
      const next = await replace({
        ...rest,
        status: "ok",
        testedAt: now(),
        tools,
      });
      return { server: next, changed, added, removed };
    },

    async beginSignIn(id) {
      const server = require(id);
      if (server.auth !== "oauth") {
        throw new McpError("mcp_not_oauth", "This server does not use sign-in");
      }
      for (const [state, entry] of pending) {
        if (entry.expiresAt < now()) pending.delete(state);
      }
      let authorizationUrl: string | undefined;
      const provider = oauthProvider(server, {
        onRedirect: (url) => {
          authorizationUrl = url.href;
        },
      });
      const result = await auth(provider, {
        serverUrl: server.url,
        fetchFn: fetchFor(server),
      });
      if (result === "AUTHORIZED") return { kind: "signed_in" };
      if (!authorizationUrl) {
        throw new McpError("mcp_oauth_failed", "Sign-in did not start");
      }
      return { kind: "redirect", authorizationUrl };
    },

    async finishSignIn(state, code) {
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || entry.expiresAt < now()) {
        throw new McpError(
          "mcp_oauth_expired",
          "That sign-in has expired; start it again",
        );
      }
      const server = require(entry.serverId);
      const provider = oauthProvider(server, {
        onRedirect: () => undefined,
        verifier: entry.codeVerifier,
      });
      await auth(provider, {
        serverUrl: server.url,
        authorizationCode: code,
        fetchFn: fetchFor(server),
      });
      return (await registry.refresh(server.id)).server;
    },

    async call(id, toolName, input, signal) {
      const server = require(id);
      let client: Client;
      try {
        client = await connect(server);
      } catch (error) {
        const failure = problem(error);
        if (failure.status === "signed_out") {
          await replace({ ...server, ...failure });
        }
        throw new McpError(
          failure.status === "signed_out"
            ? "mcp_signed_out"
            : "mcp_unreachable",
          failure.error ?? "It did not answer",
        );
      }
      try {
        const result = (await client.callTool(
          { name: toolName, arguments: { ...input } },
          undefined,
          { ...(signal ? { signal } : {}), timeout: CALL_TIMEOUT_MS },
        )) as CallToolResult;
        return {
          text: resultText(result),
          isError: result.isError === true,
        };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
  return registry;
}

/** SHA-256 of a tool's description, schema and annotations, keys sorted. */
export function hashTool(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** HTTPS to a name or public address: never loopback or a private range. */
export function isPublicHttps(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return false;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(":")) {
    return !/^(fc|fd|fe8|fe9|fea|feb)/u.test(host) && host !== "::";
  }
  // A bare name is a container or LAN name, not a public host.
  return host.includes(".");
}

/**
 * An address on the owner's network: HTTP(S) to a private IPv4 or IPv6
 * address, or a `.local`, `.lan` or `.home.arpa` name. Never loopback,
 * link-local or cloud metadata addresses, and no user name or password.
 */
export function isNetworkAddress(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{2}:/u.test(host);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|lan|home\.arpa)$/u.test(host);
}

function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).map((item) => {
    if (item.type === "text") return item.text;
    if (item.type === "image") return `[Image: ${item.mimeType}]`;
    if (item.type === "resource_link") {
      return `Resource link: ${item.name}\nURI: ${item.uri}`;
    }
    if (item.type === "resource" && "text" in item.resource) {
      return item.resource.text;
    }
    return `[${item.type}]`;
  });
  if (result.structuredContent) {
    parts.push(
      `Structured content:\n${JSON.stringify(result.structuredContent)}`,
    );
  }
  const text = parts.join("\n");
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS - 1)}…`
    : text;
}

async function readOrCreateKey(file: string): Promise<Buffer> {
  try {
    const raw = Buffer.from((await fs.readFile(file, "utf8")).trim(), "hex");
    if (raw.length === 32) return raw;
    throw new Error(`${file} is not a 32-byte key`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  await fs
    .writeFile(file, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" })
    .catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  return Buffer.from((await fs.readFile(file, "utf8")).trim(), "hex");
}

function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
  });
}

async function readSecrets(file: string, key: Buffer): Promise<SecretState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { headers: {}, oauth: {} };
    }
    throw error;
  }
  // A file the key cannot open stops the server rather than losing secrets.
  const sealed = JSON.parse(raw) as { iv: string; tag: string; data: string };
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const text = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(text) as Partial<SecretState>;
  return { headers: parsed.headers ?? {}, oauth: parsed.oauth ?? {} };
}

/** A tool back on Ask, without argument rules. */
function onAsk(tool: McpToolRecord): McpToolRecord {
  const { runWhen: _rules, ...rest } = tool;
  return { ...rest, policy: "ask" };
}

function guardProblem(error: unknown, code: string): unknown {
  return error instanceof GuardError
    ? new McpError(code, error.message)
    : error;
}

async function readServers(file: string): Promise<{
  servers: McpServerRecord[];
  alwaysAsk: string[];
}> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      schemaVersion?: number;
      servers?: McpServerRecord[];
      alwaysAsk?: unknown;
    };
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.servers)) {
      let alwaysAsk: string[] = [];
      try {
        alwaysAsk = normaliseAlwaysAskPatterns(parsed.alwaysAsk ?? []);
      } catch {
        // A hand-edited list that does not parse keeps its valid entries.
        alwaysAsk = Array.isArray(parsed.alwaysAsk)
          ? parsed.alwaysAsk.filter((item): item is string => {
              try {
                return normaliseAlwaysAskPatterns([item]).length === 1;
              } catch {
                return false;
              }
            })
          : [];
      }
      return {
        servers: parsed.servers.filter((server) =>
          MCP_SERVER_ID_PATTERN.test(server.id),
        ),
        alwaysAsk,
      };
    }
    return { servers: [], alwaysAsk: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { servers: [], alwaysAsk: [] };
    }
    throw error;
  }
}
